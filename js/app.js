// Frameloom — main app controller.
import { db, uid, loadImage, forgetImage, collectGarbage, blobURL } from './db.js';
import { newProject, migrate, newPhotoFrame, totalTicks, frameStartTick, frameAtTick, ASPECTS } from './project.js';
import { renderFrame, drawCover, deflickerGains, chromaKey, processPixels, mkCanvas, hexToRgb } from './render.js';
import { Camera } from './camera.js';
import { playTracks, stopTracks, audioCtx } from './audio.js';
import { PaintEditor } from './paint.js';
import { importProjectZip, exportProjectZip, shareOrDownload } from './export.js';
import { PANELS } from './panels.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class App {
  constructor() {
    this.project = null;
    this.cur = 0;              // playhead; == frames.length means "after the last frame" (capture slot)
    this.mode = 'live';        // live | view
    this.playing = false;
    this.selection = new Set();
    this.selectMode = false;
    this.clipboard = null;
    this.undoStack = []; this.redoStack = [];
    this.assets = { chromaBg: null, chromaBgVideo: null, overlay: null };
    this.prefs = { shutterSound: true, haptics: true, wakeLock: true };
    this.camera = new Camera($('liveVideo'));
    $('viewCanvas').getContext('2d', { willReadFrequently: true });
    this.paint = new PaintEditor(this);
    this.timelapse = null;
    this.panelName = null;
    this.bindGlobal();
  }

  async init() {
    const prefs = await db.getKV('prefs').catch(() => null);
    if (prefs) Object.assign(this.prefs, prefs);
    await this.renderLibrary();
    this.setupInstall();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
  }

  // ---------------- screens ----------------
  showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); if (id === 'studio') this.layoutStage(); }

  // ---------------- library ----------------
  async renderLibrary() {
    const grid = $('projectGrid');
    const list = await db.listProjects();
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = `<div class="empty"><div class="big">🎬</div><h2>Make your first movie</h2><p>Tap <b>＋ New movie</b>, point your camera at something, take a picture, move it a tiny bit, and take another.</p></div>`;
      return;
    }
    for (const p of list) {
      const card = document.createElement('div');
      card.className = 'proj-card';
      const first = p.frames.find(f => f.thumb);
      const secs = (totalTicks(p) / p.fps).toFixed(1);
      card.innerHTML = `<div class="thumb">🎞</div><div class="meta"><div style="min-width:0"><b></b><small>${p.frames.length} frames · ${secs}s</small></div><button class="more" aria-label="More">⋯</button></div>`;
      card.querySelector('b').textContent = p.name;
      card.querySelector('.thumb').style.aspectRatio = String(ASPECTS[p.aspect] || 16 / 9);
      if (first) blobURL(first.thumb).then(u => { if (u) { const t = card.querySelector('.thumb'); t.style.backgroundImage = `url(${u})`; t.textContent = ''; } });
      card.querySelector('.thumb').onclick = () => this.openProject(p.id);
      card.querySelector('.more').onclick = e => { e.stopPropagation(); this.projectMenu(p); };
      grid.appendChild(card);
    }
  }

  async projectMenu(p) {
    const r = await this.choose(p.name, [['open', 'Open'], ['rename', 'Rename'], ['dup', 'Duplicate'], ['backup', 'Export backup (.zip)'], ['delete', 'Delete', 'danger']]);
    if (r === 'open') this.openProject(p.id);
    if (r === 'rename') { const n = await this.prompt('Rename movie', p.name); if (n) { p.name = n; await db.putProject(p); this.renderLibrary(); } }
    if (r === 'dup') { const q = JSON.parse(JSON.stringify(p)); q.id = uid(); q.name = p.name + ' copy'; q.created = Date.now(); await db.putProject(q); this.renderLibrary(); }
    if (r === 'backup') { const blob = await this.withProgress('Packing backup…', cb => exportProjectZip(p, cb)); if (blob) shareOrDownload(blob, safeName(p.name) + '.frameloom.zip'); }
    if (r === 'delete' && await this.confirm('Delete movie?', `“${p.name}” and all its frames will be removed from this device.`, 'Delete')) { await db.deleteProject(p.id); await collectGarbage(); this.renderLibrary(); }
  }

  async newProject() {
    const name = await this.prompt('New movie', `Movie ${new Date().toLocaleDateString()}`, 'Movie name');
    if (name === null) return;
    const p = newProject(name || 'My Movie');
    await db.putProject(p);
    this.openProject(p.id);
  }

  async openProject(id) {
    const p = await db.getProject(id);
    if (!p) return;
    this.project = migrate(p);
    this.cur = this.project.frames.length;
    this.selection.clear(); this.selectMode = false;
    this.undoStack = []; this.redoStack = [];
    $('projName').value = this.project.name;
    this.showScreen('studio');
    await this.loadAssets();
    this.setMode('live');
    this.renderTimeline();
    this.requestWakeLock();
    if (!this.camera.ready) this.startCamera();
  }

  async closeProject() {
    this.stop();
    this.stopTimelapse();
    this.closePanel();
    await this.save();
    this.camera.stop();
    this.remote?.close(); this.remote = null;
    this.stopLiveFx();
    this.project = null;
    this.wakeLock?.release?.().catch(() => { }); this.wakeLock = null;
    this.showScreen('library');
    await this.renderLibrary();
    collectGarbage();
  }

  async save() {
    if (!this.project) return;
    clearTimeout(this._saveT);
    await db.putProject(this.project);
  }
  saveSoon() { clearTimeout(this._saveT); this._saveT = setTimeout(() => this.save(), 400); }

  // ---------------- undo ----------------
  snapshotState() { const p = this.project; return JSON.stringify({ frames: p.frames, audio: p.audio, settings: p.settings, fps: p.fps, aspect: p.aspect }); }
  pushUndo() { if (!this.project) return; this.undoStack.push(this.snapshotState()); if (this.undoStack.length > 60) this.undoStack.shift(); this.redoStack = []; this.updateUndoBtns(); }
  restore(s) { Object.assign(this.project, JSON.parse(s)); this.cur = Math.min(this.cur, this.project.frames.length); this.selection.clear(); this.loadAssets(); this.renderTimeline(); this.showFrame(); this.saveSoon(); if (this.panelName) this.openPanel(this.panelName); }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(this.snapshotState()); this.restore(s); this.updateUndoBtns(); this.toast('Undone'); }
  redo() { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push(this.snapshotState()); this.restore(s); this.updateUndoBtns(); this.toast('Redone'); }
  updateUndoBtns() { $('btnUndo').disabled = !this.undoStack.length; $('btnRedo').disabled = !this.redoStack.length; }

  // ---------------- camera ----------------
  async startCamera(opts = {}) {
    const msg = $('camMsg');
    msg.classList.add('hidden');
    try {
      await this.camera.start({ resolution: this.project?.settings.capture.resolution || 1080, ...opts });
      this.applyMirror();
      this.updateBadge();
      this.updateLiveFx();
    } catch (e) {
      console.warn(e);
      msg.innerHTML = `<div style="font-size:40px">📷</div><div>${e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access for this app in your browser or phone settings, then try again.' : (e.message || 'No camera found.')}</div><div class="row"><button class="btn accent" id="retryCam">Try again</button><button class="btn" id="noCam">Import pictures instead</button></div>`;
      msg.classList.remove('hidden');
      $('retryCam').onclick = () => this.startCamera();
      $('noCam').onclick = () => { msg.classList.add('hidden'); this.openPanel('import'); };
    }
  }
  applyMirror() { $('liveVideo').style.transform = this.project?.settings.capture.mirror ? 'scaleX(-1)' : ''; }

  // ---------------- stage layout ----------------
  layoutStage() {
    if (!this.project) return;
    const st = $('stage').getBoundingClientRect();
    const ar = ASPECTS[this.project.aspect] || 16 / 9;
    let w = st.width, h = w / ar;
    if (h > st.height) { h = st.height; w = h * ar; }
    w = Math.floor(w); h = Math.floor(h);
    this.stageW = w; this.stageH = h;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const el of [$('liveVideo'), $('viewCanvas'), $('onionCanvas'), $('refVideo'), $('refImage'), $('gridOverlay')]) {
      el.style.width = w + 'px'; el.style.height = h + 'px';
      el.style.left = Math.round((st.width - w) / 2) + 'px'; el.style.top = Math.round((st.height - h) / 2) + 'px';
    }
    for (const c of [$('viewCanvas'), $('onionCanvas')]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    document.documentElement.style.setProperty('--ar', String(ar));
    this.updateGrid();
    this.showFrame();
  }

  updateGrid() {
    const g = $('gridOverlay'), mode = this.project?.settings.grid || 'off';
    g.classList.toggle('hidden', mode === 'off');
    const w = this.stageW, h = this.stageH;
    if (mode === 'thirds') g.style.backgroundSize = `${w / 3}px ${h / 3}px`;
    if (mode === 'fine') g.style.backgroundSize = `${w / 8}px ${w / 8}px`;
    if (mode === 'center') g.style.backgroundSize = `${w / 2}px ${h / 2}px`;
    g.style.backgroundPosition = mode === 'center' ? `${w / 2 % (w / 2)}px 0` : '0 0';
  }

  // ---------------- mode / frame display ----------------
  setMode(m) {
    this.mode = m;
    const live = m === 'live';
    $('liveVideo').style.visibility = live && !this.liveFxOn ? 'visible' : 'hidden';
    $('viewCanvas').style.visibility = live && !this.liveFxOn ? 'hidden' : 'visible';
    $('onionCanvas').style.visibility = live || this.project?.settings.onion.next ? 'visible' : 'hidden';
    $('btnMode').classList.toggle('on', live);
    $('btnMode').textContent = live ? '🎥' : '🖼';
    $('btnCapture').style.opacity = live ? 1 : 0.5;
    this.updateRefLayer();
    this.renderTimeline();
    this.showFrame();
  }

  async showFrame() {
    if (!this.project || this.playing) return;
    const p = this.project, n = p.frames.length;
    this.updateInfo();
    if (this.mode === 'view') {
      const idx = Math.min(this.cur, n - 1);
      const c = $('viewCanvas'), x = c.getContext('2d');
      if (idx < 0) { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); }
      else await renderFrame(x, p, idx, c.width, c.height, { assets: await this.assetsAt(frameStartTick(p, idx)), gains: p.settings.deflicker ? deflickerGains(p) : null });
    }
    this.drawOnion();
    this.syncReference();
  }

  async drawOnion() {
    const p = this.project, c = $('onionCanvas'), x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    const o = p.settings.onion;
    if (!o.on) return;
    if (this.mode === 'live') {
      for (let k = o.count; k >= 1; k--) {
        const f = p.frames[this.cur - k]; if (!f) continue;
        x.globalAlpha = o.opacity * (k === 1 ? 1 : 0.6 / (k - 1));
        if (f.type === 'photo') { const im = await loadImage(f.img); if (im) drawCover(x, im, c.width, c.height); }
        if (f.paint) { const pi = await loadImage(f.paint); if (pi) x.drawImage(pi, 0, 0, c.width, c.height); }
      }
      x.globalAlpha = 1;
    } else if (o.next) { // show previous & next frame ghosts while editing
      for (const [d, tint] of [[-1, 'rgba(255,60,60,0.25)'], [1, 'rgba(60,160,255,0.25)']]) {
        const f = p.frames[this.cur + d]; if (!f || f.type !== 'photo') continue;
        const im = await loadImage(f.img); if (!im) continue;
        x.globalAlpha = o.opacity * 0.6; drawCover(x, im, c.width, c.height);
        x.globalAlpha = 1; x.globalCompositeOperation = 'source-atop'; x.fillStyle = tint; x.fillRect(0, 0, c.width, c.height); x.globalCompositeOperation = 'source-over';
      }
    }
  }

  updateInfo() {
    const p = this.project; if (!p) return;
    const n = p.frames.length;
    $('tlPos').textContent = this.mode === 'live' ? `● ${this.cur + 1} / ${n + 1}` : `${Math.min(this.cur + 1, n)} / ${n}`;
    $('tlTime').textContent = `${(frameStartTick(p, Math.min(this.cur, n)) / p.fps).toFixed(1)}s / ${(totalTicks(p) / p.fps).toFixed(1)}s`;
    $('tlFps').textContent = `${p.fps} fps`;
  }

  updateBadge(txt) {
    const b = $('stageBadge');
    if (txt !== undefined) { b.textContent = txt; return; }
    const parts = [];
    if (this.camera.remote) parts.push('📡 Remote camera');
    if (this.timelapse) parts.push('⏱ Time-lapse');
    if (this.project?.settings.chroma.on) parts.push('🟩');
    b.textContent = parts.join(' · ');
  }

  // ---------------- timeline ----------------
  renderTimeline() {
    const p = this.project; if (!p) return;
    const tl = $('timeline');
    tl.innerHTML = '';
    const frag = document.createDocumentFragment();
    p.frames.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'tl-frame' + (this.mode === 'view' && i === this.cur ? ' cur' : '') + (this.selection.has(i) ? ' sel' : '') + (f.type === 'title' ? ' title-card' : '');
      d.dataset.i = i;
      if (f.type === 'title') { d.style.background = f.title.bg || '#000'; d.style.color = f.title.fg || '#fff'; d.textContent = (f.title.text || '').slice(0, 18); }
      else if (f.thumb) blobURL(f.thumb).then(u => u && (d.style.backgroundImage = `url(${u})`));
      d.insertAdjacentHTML('beforeend', `<span class="n">${i + 1}</span>${f.hold > 1 ? `<span class="hold">×${f.hold}</span>` : ''}${f.paint ? '<span class="tag">🖌</span>' : ''}`);
      frag.appendChild(d);
    });
    const end = document.createElement('div');
    end.className = 'tl-end' + (this.mode === 'live' ? ' cur' : '');
    end.textContent = '📷'; end.dataset.end = '1';
    if (this.mode === 'live' && this.cur < p.frames.length) {
      // show the insertion point in the middle of the strip
      const marker = document.createElement('div'); marker.className = 'tl-end cur'; marker.style.width = '10px'; marker.textContent = ''; marker.dataset.ins = '1';
      frag.insertBefore(marker, frag.children[this.cur] || null);
    }
    frag.appendChild(end);
    tl.appendChild(frag);
    const target = tl.querySelector('.cur');
    if (target) { const r = target.offsetLeft - tl.clientWidth / 2 + target.clientWidth / 2; tl.scrollLeft = r; }
    this.updateInfo();
  }

  onTimelineTap(e) {
    const el = e.target.closest('.tl-frame, .tl-end');
    if (!el || !this.project) return;
    this.stop();
    if (el.dataset.end) { this.cur = this.project.frames.length; this.setMode('live'); return; }
    if (el.dataset.ins) return;
    const i = +el.dataset.i;
    if (this.selectMode || e.shiftKey || e.metaKey || e.ctrlKey) {
      if (e.shiftKey && this.selection.size) { const a = Math.min(...this.selection, i), b = Math.max(...this.selection, i); for (let k = a; k <= b; k++) this.selection.add(k); }
      else this.selection.has(i) ? this.selection.delete(i) : this.selection.add(i);
    } else if (this.mode === 'view' && this.cur === i && this.selection.size === 0) {
      // second tap on the same frame opens the quick frame menu
      this.frameMenu(i); return;
    } else this.selection.clear();
    this.cur = i;
    if (this.mode !== 'view') this.setMode('view'); else { this.renderTimeline(); this.showFrame(); }
    if (this.panelName === 'edit' || this.panelName === 'titles') this.openPanel(this.panelName);
  }

  async frameMenu(i) {
    const f = this.project.frames[i];
    const r = await this.choose(`Frame ${i + 1}`, [['paint', '🖌 Paint / draw'], ['dup', 'Duplicate'], ['hold+', 'Hold longer (+1)'], ['hold-', 'Hold shorter (−1)'], ['insert', '📷 Insert new picture after this'], ['clean', 'Use as clean plate (magic eraser)'], ...(f.type === 'title' ? [['title', 'Edit title']] : []), ['delete', 'Delete', 'danger']]);
    if (!r) return;
    if (r === 'paint') return this.paint.open(i);
    if (r === 'title') return this.openPanel('titles');
    if (r === 'insert') { this.cur = i + 1; return this.setMode('live'); }
    this.selection = new Set([i]);
    if (r === 'dup') this.ops.duplicate();
    if (r === 'hold+') this.ops.hold(1);
    if (r === 'hold-') this.ops.hold(-1);
    if (r === 'delete') this.ops.del();
    if (r === 'clean') { this.project.settings.cleanPlate = i; this.saveSoon(); this.toast(`Frame ${i + 1} is now the clean plate`); }
    this.selection.clear(); this.renderTimeline();
  }

  // frame operations (used by Edit panel, keyboard and menus)
  get ops() {
    const app = this, p = this.project;
    const sel = () => app.selection.size ? [...app.selection].sort((a, b) => a - b) : (app.mode === 'view' && p.frames[app.cur] ? [app.cur] : []);
    const done = (msg) => { app.renderTimeline(); app.showFrame(); app.saveSoon(); if (msg) app.toast(msg); };
    return {
      sel,
      del() { const s = sel(); if (!s.length) return; app.pushUndo(); for (const i of s.reverse()) p.frames.splice(i, 1); app.selection.clear(); app.cur = Math.min(s[s.length - 1], p.frames.length); if (!p.frames.length) app.setMode('live'); done(`Deleted ${s.length} frame${s.length > 1 ? 's' : ''}`); },
      copy() { const s = sel(); if (!s.length) return; app.clipboard = s.map(i => JSON.parse(JSON.stringify(p.frames[i]))); app.toast(`Copied ${s.length}`); },
      cut() { this.copy(); this.del(); },
      paste() { if (!app.clipboard) return app.toast('Nothing copied yet'); app.pushUndo(); const at = app.mode === 'live' ? app.cur : app.cur + 1; const items = app.clipboard.map(f => ({ ...JSON.parse(JSON.stringify(f)), id: uid() })); p.frames.splice(at, 0, ...items); app.selection = new Set(items.map((_, k) => at + k)); app.cur = at; done(`Pasted ${items.length}`); },
      duplicate() { const s = sel(); if (!s.length) return; app.pushUndo(); const items = s.map(i => ({ ...JSON.parse(JSON.stringify(p.frames[i])), id: uid() })); const at = s[s.length - 1] + 1; p.frames.splice(at, 0, ...items); app.selection = new Set(items.map((_, k) => at + k)); app.cur = at; done('Duplicated'); },
      reverse() { const s = sel(); if (s.length < 2) return app.toast('Select 2 or more frames'); app.pushUndo(); const items = s.map(i => p.frames[i]).reverse(); s.forEach((i, k) => p.frames[i] = items[k]); done('Reversed'); },
      boomerang() { const s = sel(); const src = s.length > 1 ? s : p.frames.map((_, i) => i); app.pushUndo(); const items = src.slice(0, -1).reverse().map(i => ({ ...JSON.parse(JSON.stringify(p.frames[i])), id: uid() })); p.frames.splice(src[src.length - 1] + 1, 0, ...items); done(`Added ${items.length} frames going backwards`); },
      repeat(n) { const s = sel(); if (!s.length) return; app.pushUndo(); const block = s.map(i => p.frames[i]); const at = s[s.length - 1] + 1; const items = []; for (let k = 0; k < n; k++) block.forEach(f => items.push({ ...JSON.parse(JSON.stringify(f)), id: uid() })); p.frames.splice(at, 0, ...items); done(`Repeated ×${n}`); },
      move(d) { const s = sel(); if (!s.length) return; if (s[0] + d < 0 || s[s.length - 1] + d >= p.frames.length) return; app.pushUndo(); const items = s.map(i => p.frames[i]); for (const i of [...s].reverse()) p.frames.splice(i, 1); const at = s[0] + d; p.frames.splice(at, 0, ...items); app.selection = new Set(items.map((_, k) => at + k)); app.cur = Math.max(0, app.cur + d); done(); },
      hold(d, abs) { const s = sel(); if (!s.length) return; app.pushUndo(); s.forEach(i => p.frames[i].hold = Math.max(1, Math.min(240, abs ? d : (p.frames[i].hold || 1) + d))); done(); },
      selectAll() { app.selection = new Set(p.frames.map((_, i) => i)); app.renderTimeline(); },
      selectNone() { app.selection.clear(); app.renderTimeline(); },
      clearPaint() { const s = sel(); if (!s.length) return; app.pushUndo(); s.forEach(i => p.frames[i].paint = null); done('Drawings cleared'); },
      async blank(color = '#000000') {
        app.pushUndo();
        const { w, h } = { w: 1280, h: Math.round(1280 / (ASPECTS[p.aspect] || 16 / 9)) };
        const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
        const f = await app.frameFromCanvas(c); const at = app.mode === 'live' ? app.cur : app.cur + 1; p.frames.splice(at, 0, f); app.cur = at; done('Blank frame added');
      },
    };
  }

  // ---------------- capture ----------------
  async frameFromCanvas(canvas, quality) {
    const q = quality ?? this.project?.settings.capture.quality ?? 0.92;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
    const img = await db.putBlob(blob);
    const { thumb, lum } = await this.makeThumb(canvas);
    const f = newPhotoFrame(img, thumb); f.lum = lum;
    return f;
  }
  async makeThumb(src) {
    const k = 200 / Math.max(src.width, src.height);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
    return { thumb: await db.putBlob(blob), lum: s / (d.length / 4) };
  }
  async refreshThumb(f) {
    if (f.type !== 'photo') return;
    const im = await loadImage(f.img); if (!im) return;
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    if (f.paint) { const pi = await loadImage(f.paint); if (pi) x.drawImage(pi, 0, 0, c.width, c.height); }
    const { thumb, lum } = await this.makeThumb(c);
    if (f.thumb) forgetImage(f.thumb);
    f.thumb = thumb; if (!f.paint) f.lum = lum;
  }
  async replaceFrameImage(f, canvas) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));
    forgetImage(f.img);
    f.img = await db.putBlob(blob);
  }

  async capture({ fromTimer = false } = {}) {
    if (!this.project) return;
    if (this.mode !== 'live') { this.setMode('live'); return; }
    if (this.capturing) return;
    const s = this.project.settings;
    if (!fromTimer && s.timer.delay > 0) return this.countdown(s.timer.delay, () => this.capture({ fromTimer: true }));
    if (!this.camera.ready) return this.toast('Camera is not ready');
    this.capturing = true;
    try {
      const target = { 480: 854, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }[s.capture.resolution] || 1920;
      const ar = ASPECTS[this.project.aspect] || 16 / 9;
      const tw = ar >= 1 ? target : Math.round(target * ar), th = ar >= 1 ? Math.round(target / ar) : target;
      const c = this.camera.grab(tw, th, s.capture.mirror);
      if (!c) throw new Error('No picture from camera');
      this.flash(); this.shutterSound(); this.haptic();
      const f = await this.frameFromCanvas(c);
      this.pushUndo();
      const n = Math.max(1, s.capture.framesPerShot || 1);
      if (s.capture.replace && this.cur < this.project.frames.length) {
        this.project.frames[this.cur] = f; this.cur++;
      } else {
        const items = [f]; for (let k = 1; k < n; k++) items.push({ ...f, id: uid() });
        this.project.frames.splice(this.cur, 0, ...items);
        this.cur += items.length;
      }
      this.renderTimeline();
      this.showFrame();
      this.saveSoon();
      this.remote?.send({ cmd: 'captured', n: this.project.frames.length });
    } catch (e) { this.toast(e.message); }
    finally { this.capturing = false; }
  }

  flash() { const f = $('flash'); f.classList.add('go'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('go'))); }
  shutterSound() {
    if (!this.prefs.shutterSound) return;
    try { const ac = audioCtx(), o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime; o.type = 'square'; o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(300, t + 0.05); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08); o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.09); } catch (e) { }
  }
  haptic() { if (this.prefs.haptics && navigator.vibrate) navigator.vibrate(15); }

  countdown(sec, then) {
    const el = $('countdown'); el.classList.remove('hidden');
    let n = sec; el.textContent = n;
    clearInterval(this._cd);
    this._cd = setInterval(() => { n--; if (n <= 0) { clearInterval(this._cd); el.classList.add('hidden'); then(); } else { el.textContent = n; this.shutterTick(); } }, 1000);
  }
  shutterTick() { try { const ac = audioCtx(), o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime; o.frequency.value = 1000; g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.06); } catch (e) { } }

  startTimelapse() {
    const t = this.project.settings.timer;
    if (this.mode !== 'live') this.setMode('live');
    let shots = 0;
    const tick = async () => { await this.capture({ fromTimer: true }); shots++; this.updateBadge(`⏱ Time-lapse · ${shots}${t.count ? '/' + t.count : ''} · every ${t.interval}s`); if (t.count && shots >= t.count) this.stopTimelapse(); };
    this.timelapse = setInterval(tick, Math.max(0.5, t.interval) * 1000);
    tick();
    $('btnCapture').classList.add('busy');
    this.toast('Time-lapse started');
  }
  stopTimelapse() { if (!this.timelapse) return; clearInterval(this.timelapse); this.timelapse = null; $('btnCapture').classList.remove('busy'); this.updateBadge(); if (this.panelName === 'timer') this.openPanel('timer'); }

  // ---------------- playback ----------------
  async play() {
    const p = this.project;
    if (!p || !p.frames.length) return this.toast('Take some pictures first');
    if (this.playing) return this.stop();
    this.stopTimelapse();
    if (this.mode === 'live') this.setMode('view');
    this.playing = true;
    $('btnPlay').textContent = '❚❚';
    const total = totalTicks(p);
    const startIdx = this.cur >= p.frames.length - 1 ? 0 : this.cur;
    let startTick = frameStartTick(p, startIdx);
    const pp = p.settings.playback.pingpong;
    const cycle = pp ? Math.max(1, 2 * total - 2) : total;
    const c = $('viewCanvas'), x = c.getContext('2d');
    const gains = p.settings.deflicker ? deflickerGains(p) : null;
    $('onionCanvas').style.visibility = 'hidden';
    playTracks(p, startTick / p.fps);
    const t0 = performance.now();
    let lastTick = -1, busy = false;
    const loop = async () => {
      if (!this.playing) return;
      let k = startTick + Math.floor((performance.now() - t0) / (1000 / p.fps));
      if (k >= cycle) {
        if (!p.settings.playback.loop) { this.stop(); return; }
        // restart cleanly (and restart audio) at the top of each loop
        return this.restartLoop();
      }
      const tick = pp && k >= total ? cycle - k : k;
      if (tick !== lastTick && !busy) {
        busy = true; lastTick = tick;
        const { idx, sub } = frameAtTick(p, tick);
        this.cur = idx;
        await renderFrame(x, p, idx, c.width, c.height, { sub, assets: await this.assetsAt(tick), gains });
        this.highlightPlayhead(idx);
        this.syncReference(tick);
        busy = false;
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._loop = loop;
    this._raf = requestAnimationFrame(loop);
  }
  restartLoop() { this.playing = false; cancelAnimationFrame(this._raf); this.cur = 0; this.play(); }
  stop() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this._raf);
    stopTracks();
    $('btnPlay').textContent = '▶';
    $('onionCanvas').style.visibility = this.mode === 'live' || this.project?.settings.onion.next ? 'visible' : 'hidden';
    this.renderTimeline(); this.showFrame();
  }
  highlightPlayhead(i) {
    const tl = $('timeline');
    tl.querySelector('.tl-frame.cur')?.classList.remove('cur');
    const el = tl.querySelector(`.tl-frame[data-i="${i}"]`);
    if (el) { el.classList.add('cur'); tl.scrollLeft = el.offsetLeft - tl.clientWidth / 2; }
    this.updateInfo();
  }

  // ---------------- assets: green-screen background, overlay, reference ----------------
  async loadAssets() {
    const s = this.project.settings;
    this.assets = { chromaBg: null, chromaBgVideo: null, overlay: null };
    if (s.chroma.bgBlob) {
      const b = await db.getBlob(s.chroma.bgBlob);
      if (b && b.type.startsWith('video')) { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(b); await new Promise(r => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 4000); }); this.assets.chromaBgVideo = v; }
      else if (b) this.assets.chromaBg = await loadImage(s.chroma.bgBlob);
    }
    if (s.overlay.blob) this.assets.overlay = await loadImage(s.overlay.blob);
    await this.loadReference();
    this.updateLiveFx();
  }
  async assetsAt(tick) {
    const a = { chromaBg: this.assets.chromaBg, overlay: this.assets.overlay };
    if (this.assets.chromaBgVideo) { a.chromaBg = await seekVideo(this.assets.chromaBgVideo, tick / this.project.fps); }
    return a;
  }
  // used by export: a callback that resolves assets for a given tick
  get assetResolver() { return tick => this.assetsAt(tick); }

  async loadReference() {
    const r = this.project.settings.reference, v = $('refVideo'), im = $('refImage');
    v.classList.add('hidden'); im.classList.add('hidden');
    if (this._refURL) { URL.revokeObjectURL(this._refURL); this._refURL = null; }
    v.removeAttribute('src'); im.removeAttribute('src');
    if (!r.blob) return;
    const b = await db.getBlob(r.blob); if (!b) return;
    this._refURL = URL.createObjectURL(b);
    if (b.type.startsWith('video')) { r.kind = 'video'; v.src = this._refURL; v.load(); }
    else { r.kind = 'image'; im.src = this._refURL; }
    this.updateRefLayer();
  }
  updateRefLayer() {
    const r = this.project?.settings.reference;
    const v = $('refVideo'), im = $('refImage');
    if (!r || !r.blob || !r.on) { v.classList.add('hidden'); im.classList.add('hidden'); return; }
    const el = r.kind === 'video' ? v : im;
    el.classList.remove('hidden'); el.style.opacity = r.opacity;
    (r.kind === 'video' ? im : v).classList.add('hidden');
  }
  syncReference(tick) {
    const r = this.project?.settings.reference; if (!r || r.kind !== 'video' || !r.on || !r.sync) return;
    const v = $('refVideo'); if (!v.duration) return;
    const t = (tick ?? frameStartTick(this.project, Math.min(this.cur, this.project.frames.length))) / this.project.fps;
    v.currentTime = Math.min(t, v.duration - 0.01);
  }
  async referenceAt(idx) {
    const r = this.project.settings.reference; if (!r.blob) return null;
    if (r.kind === 'image') return $('refImage');
    const v = $('refVideo'); return seekVideo(v, frameStartTick(this.project, idx) / this.project.fps);
  }

  // ---- live preview of green screen / filters on the camera feed ----
  updateLiveFx() {
    const s = this.project?.settings;
    const want = !!s && (s.chroma.on || s.filter.name !== 'none' || Object.values(s.adjust).some(v => v));
    if (want && !this.liveFxOn) { this.liveFxOn = true; this.liveFxLoop(); }
    if (!want && this.liveFxOn) this.stopLiveFx();
    if (this.project) this.setModeVisibility();
  }
  setModeVisibility() { const live = this.mode === 'live'; $('liveVideo').style.visibility = live && !this.liveFxOn ? 'visible' : 'hidden'; $('viewCanvas').style.visibility = live && !this.liveFxOn ? 'hidden' : 'visible'; }
  stopLiveFx() { this.liveFxOn = false; cancelAnimationFrame(this._fxRaf); }
  liveFxLoop() {
    const small = mkCanvas(480, 270), sx = small.getContext('2d', { willReadFrequently: true });
    const bgc = mkCanvas(480, 270), bx = bgc.getContext('2d', { willReadFrequently: true });
    const run = async () => {
      if (!this.liveFxOn) return;
      this._fxRaf = requestAnimationFrame(run);
      if (this.mode !== 'live' || this.playing || !this.camera.ready || this._fxBusy) return;
      this._fxBusy = true;
      try {
        const s = this.project.settings, ar = ASPECTS[this.project.aspect] || 16 / 9;
        const w = 480, h = Math.round(480 / ar); if (small.width !== w || small.height !== h) { small.width = bgc.width = w; small.height = bgc.height = h; }
        sx.save(); if (s.capture.mirror) { sx.translate(w, 0); sx.scale(-1, 1); } drawCover(sx, $('liveVideo'), w, h); sx.restore();
        const id = sx.getImageData(0, 0, w, h);
        if (s.chroma.on) {
          const a = chromaKey(id.data, s.chroma.color, s.chroma.tolerance, s.chroma.softness, s.chroma.spill);
          const bgSrc = this.assets.chromaBgVideo || this.assets.chromaBg;
          if (s.chroma.bgType !== 'color' && bgSrc) { if (this.assets.chromaBgVideo && this.assets.chromaBgVideo.paused) { this.assets.chromaBgVideo.loop = true; this.assets.chromaBgVideo.play().catch(() => { }); } drawCover(bx, bgSrc, w, h, s.chroma.bgFit); }
          else { bx.fillStyle = s.chroma.bgType === 'transparent' ? '#888' : s.chroma.bgColor; bx.fillRect(0, 0, w, h); }
          const bd = bx.getImageData(0, 0, w, h).data, d = id.data;
          for (let i = 0, q = 0; i < d.length; i += 4, q++) { const al = a[q]; if (al < 1) { d[i] = d[i] * al + bd[i] * (1 - al); d[i + 1] = d[i + 1] * al + bd[i + 1] * (1 - al); d[i + 2] = d[i + 2] * al + bd[i + 2] * (1 - al); } }
        }
        processPixels(id, w, h, { filter: s.filter.name === 'pixel' || s.filter.name === 'sketch' ? 'none' : s.filter.name, amount: s.filter.amount, adjust: s.adjust, seed: 1 });
        sx.putImageData(id, 0, 0);
        const c = $('viewCanvas'), x = c.getContext('2d'); x.drawImage(small, 0, 0, c.width, c.height);
        if (s.overlay.on && this.assets.overlay) { x.globalAlpha = s.overlay.opacity; x.drawImage(this.assets.overlay, 0, 0, c.width, c.height); x.globalAlpha = 1; }
      } finally { this._fxBusy = false; }
    };
    run();
  }

  // ---------------- panels ----------------
  openPanel(name) {
    const def = PANELS[name]; if (!def) return;
    this.panelName = name;
    $('panelTitle').textContent = def.title;
    const body = $('panelBody');
    body.innerHTML = '';
    def.build(this, body);
    $('panel').classList.remove('hidden');
    document.querySelectorAll('#toolbar button').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  }
  closePanel() { this.panelName = null; $('panel').classList.add('hidden'); document.querySelectorAll('#toolbar button').forEach(b => b.classList.remove('active')); }

  // ---------------- dialogs ----------------
  modal(title, bodyHTML, actions) {
    return new Promise(resolve => {
      $('modalTitle').textContent = title;
      const body = $('modalBody'); body.innerHTML = '';
      if (typeof bodyHTML === 'string') body.innerHTML = bodyHTML; else if (bodyHTML) body.appendChild(bodyHTML);
      const act = $('modalActions'); act.innerHTML = '';
      const close = v => { $('modal').classList.add('hidden'); resolve(v); };
      actions.forEach(([val, label, cls]) => { const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = label; b.onclick = () => close(typeof val === 'function' ? val() : val); act.appendChild(b); });
      $('modal').classList.remove('hidden');
      $('modal').onclick = e => { if (e.target === $('modal')) close(null); };
      this._modalClose = close;
      setTimeout(() => body.querySelector('input,textarea')?.focus(), 50);
    });
  }
  confirm(title, text, ok = 'OK') { return this.modal(title, `<p>${esc(text)}</p>`, [[false, 'Cancel'], [true, ok, ok === 'Delete' ? 'danger' : 'accent']]); }
  alert(title, html) { return this.modal(title, html, [[true, 'OK', 'accent']]); }
  prompt(title, value = '', placeholder = '') {
    const multi = title === 'Add text';
    const html = multi ? `<textarea id="pIn" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input type="text" id="pIn" style="width:100%" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const p = this.modal(title, html, [[null, 'Cancel'], [() => $('pIn').value, 'OK', 'accent']]);
    setTimeout(() => { const i = $('pIn'); if (i && !multi) { i.select(); i.onkeydown = e => { if (e.key === 'Enter') this._modalClose(i.value); }; } }, 60);
    return p;
  }
  choose(title, options) {
    const wrap = document.createElement('div');
    return new Promise(resolve => {
      options.forEach(([val, label, cls]) => { const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.style.cssText = 'display:block;width:100%;margin:6px 0;text-align:left'; b.textContent = label; b.onclick = () => { $('modal').classList.add('hidden'); resolve(val); }; wrap.appendChild(b); });
      this.modal(title, wrap, [[null, 'Cancel']]).then(v => resolve(v));
    });
  }
  async withProgress(title, fn) {
    const ac = new AbortController();
    const body = document.createElement('div');
    body.innerHTML = `<div class="progress"><div></div></div><div class="hint" id="progTxt">Starting…</div>`;
    const bar = body.querySelector('.progress > div'), txt = body.querySelector('#progTxt');
    let cancelled = false;
    this.modal(title, body, [[() => { cancelled = true; ac.abort(); return null; }, 'Cancel']]);
    try {
      const r = await fn(v => { bar.style.width = Math.round(v * 100) + '%'; txt.textContent = Math.round(v * 100) + '%'; }, ac.signal);
      $('modal').classList.add('hidden');
      return r;
    } catch (e) {
      $('modal').classList.add('hidden');
      if (!cancelled) { console.error(e); this.alert('Something went wrong', `<p>${esc(e.message || String(e))}</p>`); }
      return null;
    }
  }
  toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(this._toastT); this._toastT = setTimeout(() => t.classList.remove('show'), 1800); }

  pickFile(accept, multiple = false) {
    return new Promise(resolve => {
      const fp = $('filePicker'); fp.value = ''; fp.accept = accept; fp.multiple = multiple;
      fp.onchange = () => resolve(multiple ? [...fp.files] : fp.files[0] || null);
      fp.click();
    });
  }

  async requestWakeLock() { if (!this.prefs.wakeLock || !navigator.wakeLock) return; try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { } }

  setupInstall() {
    const hint = $('installHint');
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone) return;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) { hint.innerHTML = 'Install: tap <b>Share</b> then <b>Add to Home Screen</b>.'; hint.classList.remove('hidden'); }
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); this._installEvt = e;
      hint.innerHTML = '<button class="btn accent" id="btnInstall">Install app</button>'; hint.classList.remove('hidden');
      $('btnInstall').onclick = async () => { this._installEvt.prompt(); await this._installEvt.userChoice; hint.classList.add('hidden'); };
    });
  }

  async appSettings() {
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const used = est ? `${(est.usage / 1e6).toFixed(0)} MB used of ${(est.quota / 1e9).toFixed(1)} GB available` : '';
    const body = document.createElement('div');
    body.innerHTML = `
      <label class="row"><input type="checkbox" id="pfShutter"> Shutter sound</label>
      <label class="row"><input type="checkbox" id="pfHaptics"> Vibrate on capture</label>
      <label class="row"><input type="checkbox" id="pfWake"> Keep screen awake while animating</label>
      <div class="section"><h3>Storage</h3><div class="hint">${used}<br>Movies are stored only on this device. Use “Export backup” on a movie to save or move it.</div></div>
      <div class="section"><h3>Shortcuts</h3><div class="hint">Space / Enter: take picture · ← →: step frames · P: play · Delete: delete frame · Ctrl/⌘+Z: undo. Most Bluetooth camera remotes work as a shutter.</div></div>
      <div class="section"><h3>About</h3><div class="hint">Frameloom 1.0 — free, open-source stop-motion studio. Works offline once installed.</div></div>`;
    body.querySelector('#pfShutter').checked = this.prefs.shutterSound;
    body.querySelector('#pfHaptics').checked = this.prefs.haptics;
    body.querySelector('#pfWake').checked = this.prefs.wakeLock;
    await this.modal('Settings', body, [[true, 'Done', 'accent']]);
    this.prefs.shutterSound = body.querySelector('#pfShutter').checked;
    this.prefs.haptics = body.querySelector('#pfHaptics').checked;
    this.prefs.wakeLock = body.querySelector('#pfWake').checked;
    db.setKV('prefs', this.prefs);
  }

  // ---------------- wiring ----------------
  bindGlobal() {
    $('btnNewProject').onclick = () => this.newProject();
    $('btnAppSettings').onclick = () => this.appSettings();
    $('btnImportProject').onclick = async () => {
      const f = await this.pickFile('.zip,application/zip'); if (!f) return;
      const p = await this.withProgress('Importing…', () => importProjectZip(f));
      if (p) { this.toast('Movie imported'); this.renderLibrary(); }
    };
    $('btnBack').onclick = () => this.closeProject();
    $('projName').onchange = () => { this.project.name = $('projName').value.trim() || 'Untitled'; this.saveSoon(); };
    $('btnUndo').onclick = () => this.undo();
    $('btnRedo').onclick = () => this.redo();
    $('btnExport').onclick = () => PANELS.exportDialog(this);
    $('btnCapture').onclick = () => { if (this.timelapse) this.stopTimelapse(); else this.capture(); };
    $('btnPlay').onclick = () => this.play();
    $('btnMode').onclick = () => {
      this.stop();
      if (this.mode === 'live') { if (!this.project.frames.length) return this.toast('No frames yet'); this.cur = Math.max(0, Math.min(this.cur - 1, this.project.frames.length - 1)); this.setMode('view'); }
      else { this.cur = Math.min(this.cur + 1, this.project.frames.length); this.setMode('live'); if (!this.camera.ready) this.startCamera(); }
    };
    // hold to compare live view with the last frame
    const flip = $('btnFlip');
    const showLast = on => { if (this.mode !== 'live') return; const p = this.project; const idx = this.cur - 1; if (idx < 0) return; if (on) { $('liveVideo').style.visibility = 'hidden'; $('viewCanvas').style.visibility = 'visible'; renderFrame($('viewCanvas').getContext('2d'), p, idx, $('viewCanvas').width, $('viewCanvas').height, {}); $('onionCanvas').style.visibility = 'hidden'; } else { this.setModeVisibility(); $('onionCanvas').style.visibility = 'visible'; } };
    flip.addEventListener('pointerdown', () => showLast(true));
    flip.addEventListener('pointerup', () => showLast(false));
    flip.addEventListener('pointerleave', () => showLast(false));
    $('timeline').addEventListener('click', e => this.onTimelineTap(e));
    $('toolbar').addEventListener('click', e => { const b = e.target.closest('[data-panel]'); if (!b) return; if (this.panelName === b.dataset.panel) this.closePanel(); else this.openPanel(b.dataset.panel); });
    $('panelClose').onclick = () => this.closePanel();
    // tap on the stage to pick a green-screen key colour
    $('stage').addEventListener('click', e => { if (this.pickingKey) this.pickKeyColor(e); });
    window.addEventListener('resize', () => this.layoutStage());
    window.addEventListener('orientationchange', () => setTimeout(() => this.layoutStage(), 300));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.project) this.requestWakeLock(); else this.save(); });
    window.addEventListener('pagehide', () => this.save());
    document.addEventListener('keydown', e => {
      if (!this.project || !$('studio').classList.contains('active')) return;
      if (e.target.matches('input, textarea, select') || !$('modal').classList.contains('hidden')) return;
      const k = e.key;
      if (k === ' ' || k === 'Enter' || k === 'AudioVolumeUp' || k === 'AudioVolumeDown' || k === 'VolumeUp' || k === 'VolumeDown' || k === 'Camera') { e.preventDefault(); this.capture(); }
      else if (k === 'ArrowLeft') { this.stop(); this.cur = Math.max(0, this.cur - 1); if (this.mode === 'live') this.setMode('view'); else { this.renderTimeline(); this.showFrame(); } }
      else if (k === 'ArrowRight') { this.stop(); if (this.cur >= this.project.frames.length - 1) { this.cur = this.project.frames.length; this.setMode('live'); } else { this.cur++; this.renderTimeline(); this.showFrame(); } }
      else if (k === 'p' || k === 'P') this.play();
      else if ((k === 'Delete' || k === 'Backspace') && this.mode === 'view') this.ops.del();
      else if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'c') this.ops.copy();
      else if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'x') this.ops.cut();
      else if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'v') this.ops.paste();
    });
  }

  pickKeyColor(e) {
    this.pickingKey = false;
    const src = this.mode === 'live' ? $('liveVideo') : $('viewCanvas');
    const r = $('viewCanvas').getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d', { willReadFrequently: true });
    drawCover(x, src.tagName === 'VIDEO' ? src : $('viewCanvas'), 64, 64);
    const mx = this.project.settings.capture.mirror && this.mode === 'live' ? 1 - fx : fx;
    const d = x.getImageData(Math.min(63, Math.floor(mx * 64)), Math.min(63, Math.floor(fy * 64)), 1, 1).data;
    this.pushUndo();
    this.project.settings.chroma.color = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    this.project.settings.chroma.on = true;
    this.saveSoon(); this.updateLiveFx(); this.showFrame();
    if (this.panelName === 'green') this.openPanel('green');
    this.toast('Key colour picked');
  }
}

export function seekVideo(v, t) {
  return new Promise(res => {
    if (!v.duration || !isFinite(v.duration)) return res(v);
    const target = t % v.duration;
    if (Math.abs(v.currentTime - target) < 0.01) return res(v);
    const done = () => { v.removeEventListener('seeked', done); res(v); };
    v.addEventListener('seeked', done);
    v.currentTime = target;
    setTimeout(done, 1500);
  });
}

export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function safeName(s) { return (s || 'movie').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'movie'; }

const app = new App();
window.frameloom = app;
app.init();
