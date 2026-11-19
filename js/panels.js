// Tool panels for the studio screen.
import { db, loadImage } from './db.js';
import { THEMES, FILTERS, ASPECTS, newTitleFrame, totalTicks, frameStartTick, frameAtTick } from './project.js';
import { TITLE_STYLES, TITLE_ANIMS, drawCover } from './render.js';
import { VoiceRecorder, SFX, synthSfx, decodeClip, playTracks, stopTracks } from './audio.js';
import { RemoteCameraSide, RemoteStudioSide } from './remote.js';
import { exportMP4, exportRecorder, exportGIF, exportSequence, exportStill, exportProjectZip, shareOrDownload, canUseWebCodecs, RESOLUTIONS } from './export.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeName = s => (s || 'movie').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'movie';
const q = (root, sel) => root.querySelector(sel);

function slider(id, label, min, max, step, value, fmt = v => v) {
  return `<div class="field"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><output id="${id}_o">${fmt(+value)}</output></div>`;
}
function onSlider(root, id, fn, fmt = v => v, commit) {
  const el = q(root, '#' + id), o = q(root, '#' + id + '_o');
  el.oninput = () => { o.textContent = fmt(+el.value); fn(+el.value, false); };
  el.onchange = () => { fn(+el.value, true); commit?.(); };
}
function chips(id, options, current) {
  return `<div class="chips" id="${id}">${Object.entries(options).map(([k, v]) => `<button class="chip${k === String(current) ? ' on' : ''}" data-v="${esc(k)}">${esc(v)}</button>`).join('')}</div>`;
}
function onChips(root, id, fn) {
  q(root, '#' + id).addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; q(root, '#' + id).querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b)); fn(b.dataset.v); });
}
const pct = v => Math.round(v * 100) + '%';

// helper: change a setting with undo + save + redraw
function setter(app, fn, { fx = false, assets = false, grid = false } = {}) {
  return async (v, commit = true) => {
    fn(app.project.settings, v);
    if (commit) { app.saveSoon(); }
    if (assets) await app.loadAssets();
    if (fx) app.updateLiveFx();
    if (grid) app.updateGrid();
    app.showFrame();
  };
}

export const PANELS = {
  // ======================= CAMERA =======================
  camera: {
    title: 'Camera',
    build(app, body) {
      const s = app.project.settings, cam = app.camera;
      const caps = cam.capabilities(), cur = cam.settings();
      const devOpts = cam.devices.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cam.deviceId ? 'selected' : ''}>${esc(d.label || 'Camera ' + (i + 1))}</option>`).join('');
      body.innerHTML = `
        <div class="row wrap">
          <button class="btn" id="cSwitch">🔄 Switch camera</button>
          ${devOpts ? `<select id="cDev">${devOpts}</select>` : ''}
          <button class="btn" id="cRestart">Restart camera</button>
        </div>
        <div class="field"><span>Capture quality</span><select id="cRes">
          ${[480, 720, 1080, 1440, 2160].map(r => `<option value="${r}" ${r === s.capture.resolution ? 'selected' : ''}>${r === 2160 ? '4K' : r + 'p'}</option>`).join('')}
        </select><span class="hint">${cam.video.videoWidth ? cam.video.videoWidth + '×' + cam.video.videoHeight : ''}</span></div>
        <div class="row wrap">
          <label><input type="checkbox" id="cMirror" ${s.capture.mirror ? 'checked' : ''}> Mirror</label>
          <label><input type="checkbox" id="cReplace" ${s.capture.replace ? 'checked' : ''}> Replace frame (retake)</label>
        </div>
        <div class="field"><span>Pictures per tap</span><select id="cPer">${[1, 2, 3, 4].map(n => `<option ${n === s.capture.framesPerShot ? 'selected' : ''} value="${n}">${n === 1 ? 'Ones (1)' : n === 2 ? 'Twos (2)' : n}</option>`).join('')}</select><span></span></div>
        <div class="field"><span>Grid</span><select id="cGrid">${Object.entries({ off: 'Off', thirds: 'Thirds', fine: 'Fine', center: 'Centre cross' }).map(([k, v]) => `<option value="${k}" ${k === s.grid ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>
        <div class="section"><h3>Manual controls</h3>
          <div class="row wrap"><button class="btn" id="cLock">🔒 Lock focus & exposure</button><button class="btn" id="cAuto">Auto</button>${caps.torch ? '<button class="btn" id="cTorch">🔦 Light</button>' : ''}</div>
          <div id="cManual"></div>
          <div class="hint" id="cNote"></div>
        </div>`;
      const manual = q(body, '#cManual');
      const ctl = [
        ['zoom', 'Zoom', v => v.toFixed(1) + '×'],
        ['focusDistance', 'Focus', v => v.toFixed(2), { focusMode: 'manual' }],
        ['exposureCompensation', 'Exposure ±', v => v.toFixed(1)],
        ['exposureTime', 'Shutter time', v => Math.round(v), { exposureMode: 'manual' }],
        ['iso', 'ISO', v => Math.round(v), { exposureMode: 'manual' }],
        ['colorTemperature', 'White balance', v => Math.round(v) + 'K', { whiteBalanceMode: 'manual' }],
        ['brightness', 'Brightness', v => Math.round(v)], ['contrast', 'Contrast', v => Math.round(v)],
        ['saturation', 'Saturation', v => Math.round(v)], ['sharpness', 'Sharpness', v => Math.round(v)],
      ];
      let any = false;
      for (const [k, label, fmt, extra] of ctl) {
        const c = caps[k]; if (!c || c.min === undefined || c.max === undefined || c.min === c.max) continue;
        any = true;
        manual.insertAdjacentHTML('beforeend', slider('cc_' + k, label, c.min, c.max, c.step || (c.max - c.min) / 100, cur[k] ?? c.min, fmt));
        onSlider(manual, 'cc_' + k, v => cam.apply({ ...(extra || {}), [k]: v }), fmt);
      }
      q(body, '#cNote').textContent = any ? 'Lock the camera before animating so the light doesn’t flicker between frames.'
        : 'This phone’s browser doesn’t expose manual camera controls (iPhone Safari hides most of them). Use “Lock” if available, keep the lighting steady, and turn on Effects ▸ Deflicker.';
      q(body, '#cSwitch').onclick = async () => { await cam.switchCamera(); app.applyMirror(); app.openPanel('camera'); };
      q(body, '#cRestart').onclick = () => app.startCamera().then(() => app.openPanel('camera'));
      q(body, '#cDev') && (q(body, '#cDev').onchange = e => cam.start({ deviceId: e.target.value }).then(() => app.openPanel('camera')));
      q(body, '#cRes').onchange = e => { s.capture.resolution = +e.target.value; app.saveSoon(); app.startCamera({ resolution: +e.target.value }).then(() => app.openPanel('camera')); };
      q(body, '#cMirror').onchange = e => { s.capture.mirror = e.target.checked; app.applyMirror(); app.saveSoon(); };
      q(body, '#cReplace').onchange = e => { s.capture.replace = e.target.checked; app.saveSoon(); app.toast(e.target.checked ? 'Next picture replaces the frame at the playhead' : 'Next picture is inserted'); };
      q(body, '#cPer').onchange = e => { s.capture.framesPerShot = +e.target.value; app.saveSoon(); };
      q(body, '#cGrid').onchange = e => { s.grid = e.target.value; app.updateGrid(); app.saveSoon(); };
      q(body, '#cLock').onclick = async () => app.toast(await cam.lockAll(true) ? 'Locked' : 'Locking isn’t supported by this camera');
      q(body, '#cAuto').onclick = async () => { await cam.lockAll(false); app.toast('Auto'); };
      if (q(body, '#cTorch')) q(body, '#cTorch').onclick = async () => { app._torch = !app._torch; await cam.apply({ torch: app._torch }); };
    },
  },

  // ======================= ONION SKIN =======================
  onion: {
    title: 'Onion skin',
    build(app, body) {
      const o = app.project.settings.onion;
      body.innerHTML = `
        <label class="row"><input type="checkbox" id="oOn" ${o.on ? 'checked' : ''}> Show previous frames over the camera</label>
        ${slider('oOp', 'Opacity', 0.05, 0.9, 0.05, o.opacity, pct)}
        ${slider('oCnt', 'Frames shown', 1, 5, 1, o.count)}
        <label class="row"><input type="checkbox" id="oNext" ${o.next ? 'checked' : ''}> When viewing a frame, ghost the frames before (red) and after (blue)</label>
        <div class="hint">Tip: press and hold ⇆ next to the shutter to flip between the camera and your last picture.</div>`;
      const set = setter(app, () => { });
      q(body, '#oOn').onchange = e => { o.on = e.target.checked; set(); };
      q(body, '#oNext').onchange = e => { o.next = e.target.checked; app.setMode(app.mode); app.saveSoon(); };
      onSlider(body, 'oOp', v => { o.opacity = v; app.drawOnion(); }, pct, () => app.saveSoon());
      onSlider(body, 'oCnt', v => { o.count = v; app.drawOnion(); }, v => v, () => app.saveSoon());
    },
  },

  // ======================= TIMER / TIME-LAPSE =======================
  timer: {
    title: 'Timer & time-lapse',
    build(app, body) {
      const t = app.project.settings.timer;
      body.innerHTML = `
        <h3 class="hint">Self-timer (before each picture)</h3>
        ${chips('tDelay', { 0: 'Off', 2: '2 s', 3: '3 s', 5: '5 s', 10: '10 s' }, t.delay)}
        <div class="section"><h3>Time-lapse</h3>
          <div class="field"><span>Every</span><input type="number" id="tInt" min="0.5" step="0.5" value="${t.interval}"><span>seconds</span></div>
          <div class="field"><span>Stop after</span><input type="number" id="tCnt" min="0" step="1" value="${t.count}"><span>pictures (0 = never)</span></div>
          <button class="btn ${app.timelapse ? 'danger' : 'accent'}" id="tGo">${app.timelapse ? '■ Stop time-lapse' : '▶ Start time-lapse'}</button>
          <div class="hint" style="margin-top:8px">Great for clouds, plants, building things or melting ice. Keep the phone plugged in for long sessions.</div>
        </div>`;
      onChips(body, 'tDelay', v => { t.delay = +v; app.saveSoon(); });
      q(body, '#tInt').onchange = e => { t.interval = Math.max(0.5, +e.target.value || 5); app.saveSoon(); };
      q(body, '#tCnt').onchange = e => { t.count = Math.max(0, Math.round(+e.target.value || 0)); app.saveSoon(); };
      q(body, '#tGo').onclick = () => { if (app.timelapse) app.stopTimelapse(); else { app.startTimelapse(); app.openPanel('timer'); } };
    },
  },

  // ======================= EDIT =======================
  edit: {
    title: 'Edit frames',
    build(app, body) {
      const p = app.project, ops = app.ops;
      const sel = ops.sel();
      const cf = p.frames[app.cur];
      body.innerHTML = `
        <div class="row wrap">
          <button class="btn ${app.selectMode ? 'on' : ''}" id="eSelMode">☑︎ Select many</button>
          <button class="btn" id="eAll">Select all</button><button class="btn" id="eNone">Clear selection</button>
        </div>
        <div class="hint">${sel.length ? `${sel.length} frame${sel.length > 1 ? 's' : ''} selected` : 'Tap a frame in the timeline to select it.'}</div>
        <div class="row wrap">
          <button class="btn" id="eCopy">Copy</button><button class="btn" id="eCut">Cut</button><button class="btn" id="ePaste">Paste</button>
          <button class="btn" id="eDup">Duplicate</button><button class="btn danger" id="eDel">Delete</button>
        </div>
        <div class="row wrap">
          <button class="btn" id="eLeft">◀ Move</button><button class="btn" id="eRight">Move ▶</button>
          <button class="btn" id="eRev">Reverse order</button><button class="btn" id="eBoom">Boomerang</button>
          <button class="btn" id="eRep">Repeat…</button>
        </div>
        <div class="section"><h3>Frame length (hold)</h3>
          <div class="row wrap"><button class="btn" id="eHm">− shorter</button><span>${cf ? '×' + (cf.hold || 1) + ` = ${((cf.hold || 1) / p.fps).toFixed(2)}s` : ''}</span><button class="btn" id="eHp">+ longer</button><button class="btn" id="eHset">Set…</button></div>
        </div>
        <div class="section"><h3>More</h3>
          <div class="row wrap">
            <button class="btn" id="ePaint">🖌 Paint this frame</button>
            <button class="btn" id="eClean">Use as clean plate</button>
            <button class="btn" id="eClearP">Clear drawings</button>
            <button class="btn" id="eBlank">Add blank frame</button>
            <button class="btn" id="eStill">Save frame as picture</button>
          </div>
          <div class="hint">Clean plate: frame ${(p.settings.cleanPlate ?? 0) + 1} — the magic eraser copies background from it to hide rigs and hands.</div>
        </div>`;
      const re = () => app.openPanel('edit');
      q(body, '#eSelMode').onclick = () => { app.selectMode = !app.selectMode; re(); };
      q(body, '#eAll').onclick = () => { ops.selectAll(); re(); };
      q(body, '#eNone').onclick = () => { ops.selectNone(); re(); };
      q(body, '#eCopy').onclick = () => ops.copy();
      q(body, '#eCut').onclick = () => { ops.cut(); re(); };
      q(body, '#ePaste').onclick = () => { ops.paste(); re(); };
      q(body, '#eDup').onclick = () => { ops.duplicate(); re(); };
      q(body, '#eDel').onclick = () => { ops.del(); re(); };
      q(body, '#eLeft').onclick = () => ops.move(-1);
      q(body, '#eRight').onclick = () => ops.move(1);
      q(body, '#eRev').onclick = () => ops.reverse();
      q(body, '#eBoom').onclick = () => ops.boomerang();
      q(body, '#eRep').onclick = async () => { const n = parseInt(await app.prompt('Repeat selection how many more times?', '2')); if (n > 0) ops.repeat(Math.min(50, n)); };
      q(body, '#eHm').onclick = () => { ops.hold(-1); re(); };
      q(body, '#eHp').onclick = () => { ops.hold(1); re(); };
      q(body, '#eHset').onclick = async () => { const n = parseInt(await app.prompt('Hold each selected frame for how many ticks?', String(cf?.hold || 1))); if (n > 0) { ops.hold(n, true); re(); } };
      q(body, '#ePaint').onclick = () => { if (!p.frames[app.cur] || app.mode !== 'view') return app.toast('Tap a frame in the timeline first'); app.closePanel(); app.paint.open(app.cur); };
      q(body, '#eClean').onclick = () => { if (app.mode !== 'view') return app.toast('Tap a frame first'); p.settings.cleanPlate = app.cur; app.saveSoon(); re(); };
      q(body, '#eClearP').onclick = () => ops.clearPaint();
      q(body, '#eBlank').onclick = async () => { const c = await app.prompt('Blank frame colour (hex)', '#000000'); if (c) ops.blank(c); };
      q(body, '#eStill').onclick = async () => {
        if (app.mode !== 'view' || !p.frames[app.cur]) return app.toast('Tap a frame first');
        const r = await app.withProgress('Rendering…', () => exportStill(p, app.cur, { res: 2160, assets: app.assetResolver }));
        if (r) shareOrDownload(r.blob, `${safeName(p.name)}_frame${app.cur + 1}.png`);
      };
    },
  },

  // ======================= PAINT =======================
  paint: {
    title: 'Paint & rotoscope',
    build(app, body) {
      const t = app.project.settings.tracing;
      body.innerHTML = `
        <button class="btn accent" id="pOpen">🖌 Paint on ${app.mode === 'view' && app.project.frames[app.cur] ? 'frame ' + (app.cur + 1) : 'the selected frame'}</button>
        <div class="hint" style="margin:8px 0">Brush, marker, eraser, fill, shapes, text, colour picker and the magic eraser. Drawings sit on their own layer and can be cleared any time.</div>
        <div class="section"><h3>Rotoscoping</h3>
          <div class="hint">1. Layers ▸ Reference: add a video to trace. 2. Add blank frames (or take pictures) and paint over the reference, frame by frame. 3. Turn on “Drawings only” so the movie shows just your drawings.</div>
          <label class="row"><input type="checkbox" id="pHide" ${t.hidePhotos ? 'checked' : ''}> Drawings only (hide photos in the movie)</label>
          <div class="field"><span>Paper colour</span><input type="color" id="pPaper" value="${t.paperColor}"><span></span></div>
          <div class="row wrap"><button class="btn" id="pAddBlank">Add 12 blank frames for drawing</button></div>
        </div>`;
      q(body, '#pOpen').onclick = () => {
        let i = app.mode === 'view' ? app.cur : app.cur - 1;
        if (!app.project.frames[i]) return app.toast('Take or import a frame first');
        app.closePanel(); app.paint.open(i);
      };
      q(body, '#pHide').onchange = e => { app.pushUndo(); t.hidePhotos = e.target.checked; app.saveSoon(); app.showFrame(); };
      q(body, '#pPaper').onchange = e => { t.paperColor = e.target.value; app.saveSoon(); app.showFrame(); };
      q(body, '#pAddBlank').onclick = async () => { for (let i = 0; i < 12; i++) await app.ops.blank(t.paperColor); app.toast('Added 12 frames'); };
    },
  },

  // ======================= GREEN SCREEN =======================
  green: {
    title: 'Green screen',
    build(app, body) {
      const c = app.project.settings.chroma;
      body.innerHTML = `
        <label class="row"><input type="checkbox" id="gOn" ${c.on ? 'checked' : ''}> Replace the background colour</label>
        <div class="row wrap"><span class="hint">Key colour</span><input type="color" id="gColor" value="${c.color}">
          <button class="btn" id="gPick">💧 Tap picture to pick</button>
          <button class="btn" id="gGreen">Green</button><button class="btn" id="gBlue">Blue</button></div>
        ${slider('gTol', 'Strength', 0, 1, 0.01, c.tolerance, pct)}
        ${slider('gSoft', 'Edge softness', 0, 0.6, 0.01, c.softness, pct)}
        ${slider('gSpill', 'Remove green glow', 0, 1, 0.05, c.spill, pct)}
        <div class="section"><h3>New background</h3>
          ${chips('gType', { color: 'Colour', image: 'Picture', video: 'Video', transparent: 'Transparent' }, c.bgType)}
          <div class="row wrap" style="margin-top:8px">
            <input type="color" id="gBg" value="${c.bgColor}">
            <button class="btn" id="gImg">Choose picture…</button><button class="btn" id="gVid">Choose video…</button>
            <select id="gFit"><option value="cover" ${c.bgFit === 'cover' ? 'selected' : ''}>Fill</option><option value="contain" ${c.bgFit === 'contain' ? 'selected' : ''}>Fit</option><option value="stretch" ${c.bgFit === 'stretch' ? 'selected' : ''}>Stretch</option></select>
          </div>
          <div class="hint">“Transparent” keeps the cut-out for PNG image-sequence export. Video backgrounds play along with your movie.</div>
        </div>`;
      const set = setter(app, () => { }, { fx: true });
      const re = () => app.openPanel('green');
      q(body, '#gOn').onchange = e => { app.pushUndo(); c.on = e.target.checked; set(); app.updateBadge(); };
      q(body, '#gColor').oninput = e => { c.color = e.target.value; c.on = true; set(); };
      q(body, '#gPick').onclick = () => { app.pickingKey = true; app.toast('Tap the background colour in the picture'); };
      q(body, '#gGreen').onclick = () => { c.color = '#00b140'; c.on = true; set(); re(); };
      q(body, '#gBlue').onclick = () => { c.color = '#0047bb'; c.on = true; set(); re(); };
      onSlider(body, 'gTol', (v, commit) => { c.tolerance = v; if (commit) set(); else app.updateLiveFx(); }, pct);
      onSlider(body, 'gSoft', (v, commit) => { c.softness = v; if (commit) set(); }, pct);
      onSlider(body, 'gSpill', (v, commit) => { c.spill = v; if (commit) set(); }, pct);
      onChips(body, 'gType', v => { c.bgType = v; set(); });
      q(body, '#gBg').oninput = e => { c.bgColor = e.target.value; c.bgType = 'color'; set(); };
      q(body, '#gFit').onchange = e => { c.bgFit = e.target.value; set(); };
      const choose = async (accept, type) => { const f = await app.pickFile(accept); if (!f) return; app.pushUndo(); c.bgBlob = await db.putBlob(f); c.bgType = type; c.on = true; await app.loadAssets(); set(); re(); };
      q(body, '#gImg').onclick = () => choose('image/*', 'image');
      q(body, '#gVid').onclick = () => choose('video/*', 'video');
    },
  },

  // ======================= AUDIO =======================
  audio: {
    title: 'Sound',
    build(app, body) {
      const p = app.project;
      const dur = totalTicks(p) / p.fps;
      const playheadSec = frameStartTick(p, Math.min(app.cur, p.frames.length)) / p.fps;
      body.innerHTML = `
        <div class="row wrap">
          <button class="btn accent" id="aRec">🎙 Record voice</button>
          <button class="btn" id="aImp">🎵 Add music / sound file</button>
          <button class="btn" id="aPrev">▶ Play with sound</button>
        </div>
        <label class="row hint"><input type="checkbox" id="aPlayRec" checked> Play the animation while recording (great for lip-sync)</label>
        <div class="hint">New sounds start at the playhead (${playheadSec.toFixed(1)}s). Movie length ${dur.toFixed(1)}s.</div>
        <div id="aList"></div>
        <div class="section"><h3>Sound effects</h3><div class="chips" id="aSfx">${Object.entries(SFX).map(([k, v]) => `<button class="chip" data-v="${k}">${v}</button>`).join('')}</div>
        <div class="hint">Tap to add at the playhead. Long-press to just listen.</div></div>`;
      const list = q(body, '#aList');
      const renderList = () => {
        list.innerHTML = p.audio.length ? '' : '<div class="hint" style="margin:10px 0">No sounds yet.</div>';
        p.audio.forEach((t, i) => {
          const el = document.createElement('div');
          el.className = 'list-item'; el.style.flexDirection = 'column'; el.style.alignItems = 'stretch';
          el.innerHTML = `
            <div class="row" style="margin:0"><span class="grow">${t.kind === 'voice' ? '🎙' : t.kind === 'sfx' ? '💥' : '🎵'} ${esc(t.name)}</span>
              <button class="btn" data-a="mute">${t.muted ? '🔇' : '🔊'}</button><button class="btn" data-a="here">⇥ Playhead</button><button class="btn danger" data-a="del">✕</button></div>
            ${slider('av' + i, 'Volume', 0, 2, 0.05, t.volume ?? 1, pct)}
            <div class="field"><span>Starts at</span><input type="number" step="0.05" min="0" value="${(t.start || 0).toFixed(2)}" data-a="start"><span>s</span></div>
            <div class="field"><span>Trim start / end</span><div class="row" style="margin:0"><input type="number" step="0.05" min="0" style="width:80px" value="${(t.trimStart || 0).toFixed(2)}" data-a="tin"><input type="number" step="0.05" min="0" style="width:80px" value="${t.trimEnd ? t.trimEnd.toFixed(2) : ''}" placeholder="end" data-a="tout"></div><span>s</span></div>
            <div class="audio-lane"><div class="clip"></div><div class="ph"></div></div>`;
          decodeClip(t.blob).then(buf => {
            if (!buf) return;
            const len = Math.max(0, (t.trimEnd || buf.duration) - (t.trimStart || 0));
            const span = Math.max(dur, (t.start || 0) + len, 0.1);
            const clip = el.querySelector('.clip'); clip.style.left = ((t.start || 0) / span * 100) + '%'; clip.style.width = (len / span * 100) + '%';
            el.querySelector('.ph').style.left = (playheadSec / span * 100) + '%';
            el.querySelector('.grow').title = `${buf.duration.toFixed(1)}s`;
          });
          onSlider(el, 'av' + i, v => { t.volume = v; }, pct, () => app.saveSoon());
          el.addEventListener('click', e => {
            const a = e.target.dataset.a;
            if (a === 'mute') { t.muted = !t.muted; app.saveSoon(); renderList(); }
            if (a === 'here') { app.pushUndo(); t.start = playheadSec; app.saveSoon(); renderList(); }
            if (a === 'del') { app.pushUndo(); p.audio.splice(i, 1); app.saveSoon(); renderList(); }
          });
          el.addEventListener('change', e => {
            const a = e.target.dataset.a, v = Math.max(0, parseFloat(e.target.value) || 0);
            if (a === 'start') t.start = v; if (a === 'tin') t.trimStart = v; if (a === 'tout') t.trimEnd = v || null;
            if (a) { app.saveSoon(); renderList(); }
          });
          list.appendChild(el);
        });
      };
      renderList();
      const addTrack = async (blob, name, kind) => {
        app.pushUndo();
        p.audio.push({ id: Math.random().toString(36).slice(2), blob: await db.putBlob(blob), name, kind, start: playheadSec, volume: 1, trimStart: 0, trimEnd: null });
        app.saveSoon(); renderList();
      };
      q(body, '#aImp').onclick = async () => { const f = await app.pickFile('audio/*,video/*'); if (f) await addTrack(f, f.name.replace(/\.[^.]+$/, ''), 'music'); };
      q(body, '#aPrev').onclick = () => { app.closePanel(); app.play(); };
      q(body, '#aRec').onclick = async () => {
        const rec = new VoiceRecorder();
        try { await rec.start(); } catch (e) { return app.alert('Microphone', `<p>Couldn’t use the microphone: ${esc(e.message)}</p>`); }
        const playAlong = q(body, '#aPlayRec').checked;
        if (playAlong && p.frames.length) { stopTracks(); app.cur = Math.min(app.cur, p.frames.length - 1); app.play(); }
        await app.modal('Recording…', '<div style="font-size:48px;text-align:center">🔴</div><p class="hint" style="text-align:center">Speak now. Tap Stop when you’re done.</p>', [[true, '■ Stop', 'danger']]);
        app.stop();
        const blob = await rec.stop();
        await addTrack(blob, 'Voice ' + (p.audio.filter(a => a.kind === 'voice').length + 1), 'voice');
        app.toast('Voice added');
      };
      const sfx = q(body, '#aSfx');
      let pressT = null, longPressed = false;
      sfx.addEventListener('pointerdown', e => { const b = e.target.closest('.chip'); if (!b) return; longPressed = false; pressT = setTimeout(async () => { longPressed = true; const blob = await synthSfx(b.dataset.v); new Audio(URL.createObjectURL(blob)).play(); }, 450); });
      sfx.addEventListener('pointerup', () => clearTimeout(pressT));
      sfx.addEventListener('click', async e => { const b = e.target.closest('.chip'); if (!b || longPressed) return; const blob = await synthSfx(b.dataset.v); new Audio(URL.createObjectURL(blob)).play().catch(() => { }); await addTrack(blob, SFX[b.dataset.v], 'sfx'); app.toast(`${SFX[b.dataset.v]} added`); });
    },
  },

  // ======================= TITLES =======================
  titles: {
    title: 'Titles & credits',
    build(app, body) {
      const p = app.project;
      const f = app.mode === 'view' ? p.frames[app.cur] : null;
      const editing = f && f.type === 'title' ? f : null;
      const t = editing ? editing.title : { text: p.name, sub: '', style: THEMES[p.settings.theme]?.titleStyle || 'classic', fg: '#ffffff', bg: '#000000', font: 'serif', size: 1, align: 'center', anim: 'fade', overPrev: false };
      const hold = editing ? editing.hold : Math.round(p.fps * 2);
      body.innerHTML = `
        ${editing ? `<div class="hint">Editing title card at frame ${app.cur + 1}</div>` : `<div class="hint">Make a title card, then add it at the start, at the playhead, or at the end.</div>`}
        <textarea id="tText" placeholder="Title">${esc(t.text)}</textarea>
        <input type="text" id="tSub" style="width:100%;margin-top:6px" placeholder="Subtitle (optional)" value="${esc(t.sub)}">
        <div class="field"><span>Style</span><select id="tStyle">${Object.entries(TITLE_STYLES).map(([k, v]) => `<option value="${k}" ${k === t.style ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>
        <div class="field"><span>Animation</span><select id="tAnim">${Object.entries(TITLE_ANIMS).map(([k, v]) => `<option value="${k}" ${k === t.anim ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>
        <div class="field"><span>Font</span><select id="tFont">${['serif', 'sans', 'rounded', 'hand', 'display', 'mono'].map(k => `<option ${k === t.font ? 'selected' : ''}>${k}</option>`).join('')}</select><span></span></div>
        <div class="row wrap"><span class="hint">Text</span><input type="color" id="tFg" value="${t.fg}"><span class="hint">Background</span><input type="color" id="tBg" value="${t.bg}">
          <select id="tAlign">${['left', 'center', 'right'].map(a => `<option ${a === t.align ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        ${slider('tSize', 'Size', 0.4, 2.5, 0.05, t.size, v => v.toFixed(2) + '×')}
        ${slider('tHold', 'Duration', 1, Math.max(240, hold), 1, hold, v => (v / p.fps).toFixed(1) + 's')}
        <label class="row"><input type="checkbox" id="tOver" ${t.overPrev ? 'checked' : ''}> Show text over the previous picture (subtitle / caption)</label>
        <div class="row wrap">
          ${editing ? '<button class="btn accent" id="tSave">Update title</button><button class="btn danger" id="tDel">Delete</button>' :
          '<button class="btn accent" id="tStart">Add at start</button><button class="btn" id="tHere">Add at playhead</button><button class="btn" id="tEnd">Add at end</button>'}
          <button class="btn" id="tCredits">Rolling credits…</button>
        </div>`;
      const read = () => ({ text: q(body, '#tText').value, sub: q(body, '#tSub').value, style: q(body, '#tStyle').value, anim: q(body, '#tAnim').value, font: q(body, '#tFont').value, fg: q(body, '#tFg').value, bg: q(body, '#tBg').value, align: q(body, '#tAlign').value, size: +q(body, '#tSize').value, overPrev: q(body, '#tOver').checked });
      onSlider(body, 'tSize', () => liveUpdate(), v => v.toFixed(2) + '×');
      onSlider(body, 'tHold', () => liveUpdate(), v => (v / p.fps).toFixed(1) + 's');
      const liveUpdate = () => { if (!editing) return; Object.assign(editing.title, read()); editing.hold = +q(body, '#tHold').value; app.saveSoon(); app.showFrame(); app.renderTimeline(); };
      body.addEventListener('input', e => { if (e.target.type !== 'range') liveUpdate(); });
      body.addEventListener('change', e => { if (e.target.type !== 'range') liveUpdate(); });
      const add = at => { app.pushUndo(); const fr = newTitleFrame({ ...read(), hold: +q(body, '#tHold').value }); p.frames.splice(at, 0, fr); app.cur = at; app.setMode('view'); app.saveSoon(); app.openPanel('titles'); };
      if (editing) {
        q(body, '#tSave').onclick = () => { app.pushUndo(); liveUpdate(); app.toast('Title updated'); };
        q(body, '#tDel').onclick = () => { app.selection = new Set([app.cur]); app.ops.del(); app.openPanel('titles'); };
      } else {
        q(body, '#tStart').onclick = () => add(0);
        q(body, '#tHere').onclick = () => add(app.mode === 'live' ? app.cur : app.cur + 1);
        q(body, '#tEnd').onclick = () => add(p.frames.length);
      }
      q(body, '#tCredits').onclick = async () => {
        const text = await app.prompt('Add text', `${p.name}\n\nDirected by\nYou\n\nStarring\nEveryone`, 'One line per name');
        if (!text) return;
        app.pushUndo();
        const fr = newTitleFrame({ text, sub: '', style: 'credits', anim: 'scroll', font: 'sans', size: 0.7, hold: Math.round(p.fps * Math.max(5, text.split('\n').length * 0.8)) });
        p.frames.push(fr); app.cur = p.frames.length - 1; app.setMode('view'); app.saveSoon(); app.openPanel('titles');
      };
    },
  },

  // ======================= EFFECTS =======================
  effects: {
    title: 'Effects & look',
    build(app, body) {
      const s = app.project.settings;
      const themes = Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.label]));
      body.innerHTML = `
        <h3 class="hint">Movie theme</h3>${chips('fxTheme', themes, s.theme)}
        <div class="section"><h3>Filter</h3>${chips('fxFilter', FILTERS, s.filter.name)}
        ${slider('fxAmt', 'Strength', 0, 1, 0.05, s.filter.amount, pct)}</div>
        <div class="section"><h3>Adjust</h3>
          ${slider('fxB', 'Brightness', -0.5, 0.5, 0.01, s.adjust.brightness, pct)}
          ${slider('fxC', 'Contrast', -0.5, 1, 0.01, s.adjust.contrast, pct)}
          ${slider('fxS', 'Saturation', -1, 1, 0.01, s.adjust.saturation, pct)}
          ${slider('fxW', 'Warmth', -1, 1, 0.01, s.adjust.warmth, pct)}
          ${slider('fxV', 'Vignette', 0, 1, 0.01, s.adjust.vignette, pct)}
          ${slider('fxG', 'Film grain', 0, 1, 0.01, s.adjust.grain, pct)}
          <label class="row"><input type="checkbox" id="fxDef" ${s.deflicker ? 'checked' : ''}> Deflicker (evens out brightness changes between frames)</label>
          <button class="btn" id="fxReset">Reset adjustments</button>
        </div>
        <div class="section"><h3>Fade in / out</h3>
          ${slider('fxIn', 'Fade in', 0, 5, 0.1, s.fade.inSec, v => v.toFixed(1) + 's')}
          ${slider('fxOut', 'Fade out', 0, 5, 0.1, s.fade.outSec, v => v.toFixed(1) + 's')}
          <div class="row"><span class="hint">Fade colour</span><input type="color" id="fxFc" value="${s.fade.color}"></div>
        </div>`;
      const set = setter(app, () => { }, { fx: true });
      onChips(body, 'fxTheme', v => {
        app.pushUndo();
        const th = THEMES[v]; s.theme = v;
        s.filter.name = th.filter || 'none'; s.filter.amount = 1;
        s.adjust = Object.assign({ brightness: 0, contrast: 0, saturation: 0, warmth: 0, vignette: 0, grain: 0 }, th.adjust || {});
        s.fade = Object.assign({ inSec: 0, outSec: 0, color: '#000000' }, th.fade || {});
        set(); app.openPanel('effects');
      });
      onChips(body, 'fxFilter', v => { app.pushUndo(); s.filter.name = v; set(); });
      onSlider(body, 'fxAmt', (v, c) => { s.filter.amount = v; if (c) set(); }, pct);
      for (const [id, k] of [['fxB', 'brightness'], ['fxC', 'contrast'], ['fxS', 'saturation'], ['fxW', 'warmth'], ['fxV', 'vignette'], ['fxG', 'grain']])
        onSlider(body, id, (v, c) => { s.adjust[k] = v; if (c) set(); else app.updateLiveFx(); }, pct);
      q(body, '#fxDef').onchange = e => { s.deflicker = e.target.checked; set(); };
      q(body, '#fxReset').onclick = () => { app.pushUndo(); s.adjust = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, vignette: 0, grain: 0 }; set(); app.openPanel('effects'); };
      onSlider(body, 'fxIn', (v, c) => { s.fade.inSec = v; if (c) set(); }, v => v.toFixed(1) + 's');
      onSlider(body, 'fxOut', (v, c) => { s.fade.outSec = v; if (c) set(); }, v => v.toFixed(1) + 's');
      q(body, '#fxFc').onchange = e => { s.fade.color = e.target.value; set(); };
    },
  },

  // ======================= LAYERS =======================
  layers: {
    title: 'Layers',
    build(app, body) {
      const s = app.project.settings, o = s.overlay, r = s.reference, w = s.watermark;
      body.innerHTML = `
        <h3 class="hint">Foreground overlay (in the movie)</h3>
        <div class="hint">A picture placed on top of every frame — e.g. a frame border, a window, snow, a logo. Use a PNG with a see-through middle.</div>
        <div class="row wrap"><button class="btn" id="lOv">Choose picture…</button>${o.blob ? '<button class="btn danger" id="lOvDel">Remove</button>' : ''}<label><input type="checkbox" id="lOvOn" ${o.on ? 'checked' : ''}> Show</label></div>
        ${slider('lOvOp', 'Opacity', 0, 1, 0.05, o.opacity, pct)}
        <div class="section"><h3>Reference / rotoscope layer (not in the movie)</h3>
          <div class="hint">A video or picture shown over the camera and in the paint editor to trace or line things up. Videos move along with the frame you're on.</div>
          <div class="row wrap"><button class="btn" id="lRef">Choose video or picture…</button>${r.blob ? '<button class="btn danger" id="lRefDel">Remove</button>' : ''}<label><input type="checkbox" id="lRefOn" ${r.on ? 'checked' : ''}> Show</label><label><input type="checkbox" id="lRefSync" ${r.sync ? 'checked' : ''}> Move with frames</label></div>
          ${slider('lRefOp', 'Opacity', 0.05, 1, 0.05, r.opacity, pct)}
        </div>
        <div class="section"><h3>Caption / watermark</h3>
          <div class="row"><label><input type="checkbox" id="lWm" ${w.on ? 'checked' : ''}> Show</label><input type="text" id="lWmT" style="flex:1" placeholder="e.g. © My Studio" value="${esc(w.text)}"></div>
        </div>`;
      const re = () => app.openPanel('layers');
      q(body, '#lOv').onclick = async () => { const f = await app.pickFile('image/*'); if (!f) return; app.pushUndo(); o.blob = await db.putBlob(f); o.on = true; await app.loadAssets(); app.saveSoon(); app.showFrame(); re(); };
      q(body, '#lOvDel') && (q(body, '#lOvDel').onclick = async () => { app.pushUndo(); o.blob = null; o.on = false; await app.loadAssets(); app.saveSoon(); app.showFrame(); re(); });
      q(body, '#lOvOn').onchange = e => { o.on = e.target.checked; app.saveSoon(); app.showFrame(); };
      onSlider(body, 'lOvOp', (v, c) => { o.opacity = v; if (c) { app.saveSoon(); app.showFrame(); } }, pct);
      q(body, '#lRef').onclick = async () => { const f = await app.pickFile('video/*,image/*'); if (!f) return; r.blob = await db.putBlob(f); r.on = true; await app.loadReference(); app.saveSoon(); app.syncReference(); re(); };
      q(body, '#lRefDel') && (q(body, '#lRefDel').onclick = async () => { r.blob = null; r.on = false; await app.loadReference(); app.saveSoon(); re(); });
      q(body, '#lRefOn').onchange = e => { r.on = e.target.checked; app.updateRefLayer(); app.syncReference(); app.saveSoon(); };
      q(body, '#lRefSync').onchange = e => { r.sync = e.target.checked; app.saveSoon(); };
      onSlider(body, 'lRefOp', v => { r.opacity = v; app.updateRefLayer(); }, pct, () => app.saveSoon());
      q(body, '#lWm').onchange = e => { w.on = e.target.checked; app.saveSoon(); app.showFrame(); };
      q(body, '#lWmT').oninput = e => { w.text = e.target.value; w.on = !!w.text; q(body, '#lWm').checked = w.on; app.saveSoon(); app.showFrame(); };
    },
  },

  // ======================= IMPORT =======================
  import: {
    title: 'Import',
    build(app, body) {
      body.innerHTML = `
        <div class="row wrap">
          <button class="btn accent" id="iPics">🖼 Pictures as frames</button>
          <button class="btn accent" id="iVid">🎞 Video → frames</button>
          <button class="btn" id="iAud">🎵 Sound</button>
        </div>
        <div class="hint">Pictures are added at the playhead in the order you pick them. Videos are split into frames at your movie’s frame rate — handy for rotoscoping or to mix live action with stop motion.</div>`;
      q(body, '#iPics').onclick = async () => {
        const files = await app.pickFile('image/*', true);
        if (!files?.length) return;
        files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        await app.withProgress('Importing pictures…', async (cb, signal) => {
          app.pushUndo();
          let at = app.mode === 'live' ? app.cur : app.cur + 1;
          for (let i = 0; i < files.length; i++) {
            if (signal.aborted) break;
            const c = await fileToCanvas(files[i], app.project.aspect);
            const f = await app.frameFromCanvas(c, 0.95);
            app.project.frames.splice(at++, 0, f);
            cb((i + 1) / files.length);
          }
          app.cur = at; app.renderTimeline(); app.showFrame(); app.saveSoon();
        });
      };
      q(body, '#iVid').onclick = async () => {
        const file = await app.pickFile('video/*'); if (!file) return;
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
        await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Can’t read this video')); }).catch(e => app.alert('Video', esc(e.message)));
        if (!v.duration) return;
        const fps = app.project.fps;
        const form = document.createElement('div');
        form.innerHTML = `<p class="hint">Length ${v.duration.toFixed(1)}s</p>
          <div class="field"><span>From</span><input type="number" id="vf" min="0" step="0.1" value="0"><span>s</span></div>
          <div class="field"><span>To</span><input type="number" id="vt" min="0" step="0.1" value="${Math.min(v.duration, 20).toFixed(1)}"><span>s</span></div>
          <div class="field"><span>Frames per second</span><input type="number" id="vr" min="1" max="60" value="${fps}"><span></span></div>
          <label class="row"><input type="checkbox" id="va"> Also import the video's sound</label>`;
        const ok = await app.modal('Video to frames', form, [[false, 'Cancel'], [true, 'Import', 'accent']]);
        if (!ok) return;
        const from = +form.querySelector('#vf').value, to = Math.min(v.duration, +form.querySelector('#vt').value), rate = Math.max(1, +form.querySelector('#vr').value), withAudio = form.querySelector('#va').checked;
        await app.withProgress('Extracting frames…', async (cb, signal) => {
          app.pushUndo();
          let at = app.mode === 'live' ? app.cur : app.cur + 1;
          const startSec = frameStartTick(app.project, at) / app.project.fps;
          const n = Math.max(1, Math.floor((to - from) * rate));
          for (let i = 0; i < n; i++) {
            if (signal.aborted) break;
            await seekTo(v, from + i / rate);
            const c = coverCanvas(v, app.project.aspect, 1920);
            app.project.frames.splice(at++, 0, await app.frameFromCanvas(c, 0.9));
            cb((i + 1) / n);
          }
          if (withAudio) app.project.audio.push({ id: Math.random().toString(36).slice(2), blob: await db.putBlob(file), name: file.name, kind: 'music', start: startSec, volume: 1, trimStart: from, trimEnd: to });
          app.cur = at; app.renderTimeline(); app.showFrame(); app.saveSoon();
        });
        URL.revokeObjectURL(v.src);
      };
      q(body, '#iAud').onclick = () => app.openPanel('audio');
    },
  },

  // ======================= REMOTE =======================
  remote: {
    title: 'Remote camera',
    build(app, body) {
      const r = app.remote;
      body.innerHTML = `
        <div class="hint">Use a second phone or tablet as the camera (or as a wireless shutter button). Both devices must have Frameloom open; on the same Wi-Fi works best. You swap two codes by copy & paste, AirDrop, Nearby Share or a message.</div>
        ${r ? `<div class="list-item"><span class="grow">Connected as ${r.role === 'cam' ? 'camera' : 'studio'} · <b id="rState">${r.pc?.connectionState || ''}</b></span><button class="btn danger" id="rEnd">Disconnect</button></div>
          ${r.role === 'cam' ? '<button class="btn accent" id="rShoot" style="width:100%;padding:18px;font-size:18px">📸 Shutter (take picture on studio)</button>' : ''}` : `
        <div class="section"><h3>A. On the STUDIO device (this one keeps the movie)</h3>
          <div class="hint">Paste the code from the camera device, then send back the reply code.</div>
          <textarea id="rOffer" class="code-box" placeholder="Paste camera code here"></textarea>
          <button class="btn accent" id="rAnswer">Connect</button>
          <textarea id="rReply" class="code-box hidden" readonly></textarea>
          <button class="btn hidden" id="rCopyReply">Copy / share reply code</button>
        </div>
        <div class="section"><h3>B. On the CAMERA device</h3>
          <button class="btn accent" id="rMakeOffer">Make camera code</button>
          <textarea id="rMyOffer" class="code-box hidden" readonly></textarea>
          <button class="btn hidden" id="rCopyOffer">Copy / share camera code</button>
          <textarea id="rGotReply" class="code-box hidden" placeholder="Paste the studio's reply code here"></textarea>
          <button class="btn accent hidden" id="rFinish">Finish connecting</button>
        </div>`}`;
      const share = async text => { try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); app.toast('Copied'); } } catch (e) { try { await navigator.clipboard.writeText(text); app.toast('Copied'); } catch (e2) { } } };
      const state = st => { const el = document.getElementById('rState'); if (el) el.textContent = st; if (st === 'connected') app.toast('Remote connected'); if (st === 'failed' || st === 'closed') { app.toast('Remote disconnected'); } app.updateBadge(); };
      if (r) {
        q(body, '#rEnd').onclick = () => { r.close(); app.remote = null; if (r.role === 'studio') app.startCamera(); app.updateBadge(); app.openPanel('remote'); };
        q(body, '#rShoot') && (q(body, '#rShoot').onclick = () => { r.send({ cmd: 'capture' }); app.flash(); app.haptic(); });
        return;
      }
      q(body, '#rAnswer').onclick = async () => {
        try {
          const side = new RemoteStudioSide({
            onStream: stream => { app.camera.useRemoteStream(stream); app.updateBadge(); app.setMode('live'); },
            onState: state,
            onCommand: m => { if (m.cmd === 'capture') app.capture(); },
          });
          side.role = 'studio';
          const reply = await side.answer(q(body, '#rOffer').value);
          app.remote = side;
          q(body, '#rReply').value = reply; q(body, '#rReply').classList.remove('hidden'); q(body, '#rCopyReply').classList.remove('hidden');
          q(body, '#rCopyReply').onclick = () => share(reply);
        } catch (e) { app.alert('Remote', `<p>${esc(e.message)}</p>`); }
      };
      q(body, '#rMakeOffer').onclick = async () => {
        if (!app.camera.stream) await app.startCamera();
        if (!app.camera.stream) return;
        const side = new RemoteCameraSide({ onState: state, onCommand: m => { if (m.cmd === 'captured') { app.flash(); app.toast(`Studio has ${m.n} frames`); } } });
        side.role = 'cam';
        const code = await side.createOffer(app.camera.stream);
        app._pendingRemote = side;
        for (const id of ['#rMyOffer', '#rCopyOffer', '#rGotReply', '#rFinish']) q(body, id).classList.remove('hidden');
        q(body, '#rMyOffer').value = code;
        q(body, '#rCopyOffer').onclick = () => share(code);
        q(body, '#rFinish').onclick = async () => {
          try { await side.acceptAnswer(q(body, '#rGotReply').value); app.remote = side; app._pendingRemote = null; app.openPanel('remote'); }
          catch (e) { app.alert('Remote', `<p>${esc(e.message)}</p>`); }
        };
      };
    },
  },

  // ======================= MOVIE SETTINGS =======================
  movie: {
    title: 'Movie settings',
    build(app, body) {
      const p = app.project, s = p.settings;
      body.innerHTML = `
        ${slider('mFps', 'Speed', 1, 60, 1, p.fps, v => v + ' fps')}
        ${chips('mFpsQ', { 5: '5', 8: '8', 10: '10', 12: '12', 15: '15', 24: '24', 30: '30' }, p.fps)}
        <div class="field"><span>Shape</span><select id="mAspect">${Object.keys(ASPECTS).map(a => `<option ${a === p.aspect ? 'selected' : ''}>${a}</option>`).join('')}</select><span></span></div>
        <label class="row"><input type="checkbox" id="mLoop" ${s.playback.loop ? 'checked' : ''}> Loop playback</label>
        <label class="row"><input type="checkbox" id="mPP" ${s.playback.pingpong ? 'checked' : ''}> Ping-pong (play forwards then backwards)</label>
        <div class="field"><span>Picture quality</span><select id="mQ">${[[0.8, 'Good'], [0.92, 'High'], [0.98, 'Best']].map(([v, l]) => `<option value="${v}" ${v === s.capture.quality ? 'selected' : ''}>${l}</option>`).join('')}</select><span></span></div>
        <div class="hint">${p.frames.length} frames · ${(totalTicks(p) / p.fps).toFixed(1)} seconds</div>
        <div class="section"><h3>Backup</h3><div class="row wrap"><button class="btn" id="mBackup">Export backup (.zip)</button></div>
        <div class="hint">A backup contains every frame, sound and setting. Import it on any device from the movie list.</div></div>`;
      onSlider(body, 'mFps', (v, c) => { p.fps = v; app.updateInfo(); if (c) { app.saveSoon(); app.openPanel('movie'); } }, v => v + ' fps');
      onChips(body, 'mFpsQ', v => { p.fps = +v; app.saveSoon(); app.updateInfo(); app.openPanel('movie'); });
      q(body, '#mAspect').onchange = e => { app.pushUndo(); p.aspect = e.target.value; app.saveSoon(); app.layoutStage(); app.renderTimeline(); };
      q(body, '#mLoop').onchange = e => { s.playback.loop = e.target.checked; app.saveSoon(); };
      q(body, '#mPP').onchange = e => { s.playback.pingpong = e.target.checked; app.saveSoon(); };
      q(body, '#mQ').onchange = e => { s.capture.quality = +e.target.value; app.saveSoon(); };
      q(body, '#mBackup').onclick = async () => { await app.save(); const b = await app.withProgress('Packing backup…', cb => exportProjectZip(p, cb)); if (b) shareOrDownload(b, safeName(p.name) + '.frameloom.zip'); };
    },
  },

  // ======================= EXPORT DIALOG =======================
  async exportDialog(app) {
    const p = app.project;
    if (!p.frames.length) return app.toast('Nothing to export yet');
    app.stop();
    await app.save();
    const wc = canUseWebCodecs();
    const form = document.createElement('div');
    form.innerHTML = `
      <div class="field"><span>Format</span><select id="xF">
        <option value="video">Movie (${wc ? 'MP4' : 'video'})</option><option value="gif">Animated GIF</option>
        <option value="png">Image sequence (PNG .zip)</option><option value="jpg">Image sequence (JPEG .zip)</option>
        <option value="still">This frame as picture</option><option value="backup">Project backup (.zip)</option></select><span></span></div>
      <div class="field" id="xResF"><span>Size</span><select id="xR">${Object.entries(RESOLUTIONS).map(([k, v]) => `<option value="${k}" ${k === '1080' ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>
      <div class="field" id="xQF"><span>Quality</span><select id="xQ"><option value="medium">Standard</option><option value="high" selected>High</option></select><span></span></div>
      <label class="row" id="xAF"><input type="checkbox" id="xA" ${p.audio.length ? 'checked' : ''} ${p.audio.length ? '' : 'disabled'}> Include sound</label>
      <div class="hint" id="xNote">${p.frames.length} frames · ${(totalTicks(p) / p.fps).toFixed(1)}s at ${p.fps} fps.</div>`;
    const sync = () => {
      const f = form.querySelector('#xF').value;
      form.querySelector('#xResF').style.display = f === 'backup' ? 'none' : '';
      form.querySelector('#xQF').style.display = f === 'video' ? '' : 'none';
      form.querySelector('#xAF').style.display = f === 'video' ? '' : 'none';
      if (f === 'gif' && +form.querySelector('#xR').value > 480) form.querySelector('#xR').value = '360';
    };
    form.querySelector('#xF').onchange = sync; sync();
    const ok = await app.modal('Export movie', form, [[false, 'Cancel'], [true, 'Export', 'accent']]);
    if (!ok) return;
    const fmt = form.querySelector('#xF').value, res = +form.querySelector('#xR').value, quality = form.querySelector('#xQ').value, audio = form.querySelector('#xA').checked;
    const assets = app.assetResolver;
    const name = safeName(p.name);
    const result = await app.withProgress('Exporting…', async (onProgress, signal) => {
      if (fmt === 'video') {
        if (wc) { try { return await exportMP4(p, { res, quality, audio, assets, onProgress, signal }); } catch (e) { if (e.message === 'Cancelled') throw e; console.warn('WebCodecs export failed, falling back', e); } }
        return exportRecorder(p, { res: Math.min(res, 1080), audio, assets, onProgress, signal });
      }
      if (fmt === 'gif') return exportGIF(p, { res, assets, onProgress, signal });
      if (fmt === 'png' || fmt === 'jpg') return exportSequence(p, { res, format: fmt, assets, onProgress, signal });
      if (fmt === 'still') return exportStill(p, app.mode === 'view' ? Math.min(app.cur, p.frames.length - 1) : p.frames.length - 1, { res, assets });
      if (fmt === 'backup') return { blob: await exportProjectZip(p, onProgress), ext: 'frameloom.zip' };
    });
    if (!result) return;
    const fname = `${name}.${result.ext}`;
    const mb = (result.blob.size / 1e6).toFixed(1);
    const go = await app.modal('Export ready', `<p>${esc(fname)} · ${mb} MB${result.audioDropped ? '<br><span class="hint">This browser can’t encode sound into MP4, so the sound was left out. Try Chrome on Android/desktop.</span>' : ''}</p>${result.blob.type.startsWith('video') || result.blob.type === 'image/gif' || result.blob.type === 'image/png' ? `<div style="text-align:center"><${result.blob.type.startsWith('video') ? 'video controls playsinline' : 'img'} src="${URL.createObjectURL(result.blob)}" style="max-width:100%;max-height:40vh;border-radius:8px"></div>` : ''}`,
      [[false, 'Close'], [true, navigator.canShare ? 'Share / Save' : 'Download', 'accent']]);
    if (go) {
      const r = await shareOrDownload(result.blob, fname);
      if (r === 'downloaded') app.toast('Saved to Downloads');
    }
  },
};

// ---------- import helpers ----------
async function fileToCanvas(file, aspect) {
  const bmp = await createImageBitmap(file).catch(async () => { const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img; });
  return coverCanvas(bmp, aspect, 1920);
}
function coverCanvas(src, aspect, longSide) {
  const ar = ASPECTS[aspect] || 16 / 9;
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  const long = Math.min(longSide, Math.max(sw, sh));
  const w = ar >= 1 ? long : Math.round(long * ar), h = ar >= 1 ? Math.round(long / ar) : long;
  const c = document.createElement('canvas'); c.width = w & ~1; c.height = h & ~1;
  drawCover(c.getContext('2d'), src, c.width, c.height);
  return c;
}
function seekTo(v, t) {
  return new Promise(res => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = Math.min(t, v.duration - 0.001); setTimeout(done, 2000); });
}
