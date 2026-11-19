// Paint editor: draw on frames, add text and shapes, trace (rotoscope), and the magic eraser (restore a clean background).
import { db, loadImage, forgetImage } from './db.js';
import { drawCover, drawTitle, hexToRgb } from './render.js';
import { aspectSize } from './render.js';

const $ = id => document.getElementById(id);
const SWATCHES = ['#000000', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#8e5a2b'];

export class PaintEditor {
  constructor(app) {
    this.app = app;
    this.tool = 'brush';
    this.base = $('paintBase'); this.ref = $('paintRef'); this.layer = $('paintLayer'); this.cursor = $('paintCursor');
    this.bx = this.base.getContext('2d', { willReadFrequently: true });
    this.lx = this.layer.getContext('2d', { willReadFrequently: true });
    this.rx = this.ref.getContext('2d');
    this.cx = this.cursor.getContext('2d');
    this.undoStack = []; this.redoStack = [];
    this.cleanPlate = null;
    this.bind();
  }

  bind() {
    $('paintToolRow').addEventListener('click', e => {
      const b = e.target.closest('[data-tool]'); if (!b) return;
      this.tool = b.dataset.tool;
      document.querySelectorAll('#paintToolRow .tool').forEach(x => x.classList.toggle('active', x === b));
      this.updateHint();
    });
    const sw = $('swatches');
    SWATCHES.forEach(c => { const b = document.createElement('button'); b.style.background = c; b.onclick = () => $('paintColor').value = c; sw.appendChild(b); });
    $('paintUndo').onclick = () => this.undo();
    $('paintRedo').onclick = () => this.redo();
    $('paintClear').onclick = () => { this.snapshot(); this.lx.clearRect(0, 0, this.W, this.H); };
    $('paintShowRef').onchange = () => this.drawRef();
    $('paintOnion').onchange = () => this.drawRef();
    $('paintCancel').onclick = () => this.close(false);
    $('paintDone').onclick = () => this.close(true);
    $('paintPrevF').onclick = () => this.step(-1);
    $('paintNextF').onclick = () => this.step(1);

    const el = this.cursor.parentElement;
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', e => this.up(e));
    window.addEventListener('resize', () => { if (this.isOpen) this.fit(); });
  }

  updateHint() {
    const h = {
      brush: 'Draw freely. Drawings stay on their own layer, so the photo underneath is never damaged.',
      marker: 'A see-through highlighter that builds up as you draw over it.',
      eraser: 'Erases your drawing only (not the photo).',
      fill: 'Tap an area to fill it with colour. Edges come from what you see on screen.',
      line: 'Drag to draw a straight line.', rect: 'Drag to draw a box.', ellipse: 'Drag to draw an oval.',
      text: 'Tap where the text should go.',
      magic: `Paint over rigs, strings or hands to replace them with the clean background from frame ${this.cleanIdx + 1}. Choose a clean frame in Edit ▸ Clean plate.`,
      pick: 'Tap to pick a colour from the picture.',
    };
    $('paintHint').textContent = h[this.tool] || '';
  }

  async open(idx) {
    this.idx = idx;
    const p = this.app.project, f = p.frames[idx];
    // clean plate: the chosen frame, or else the first photo frame that isn't this one
    let ci = p.settings.cleanPlate;
    if (ci == null || !p.frames[ci] || p.frames[ci].type !== 'photo' || ci === idx) ci = p.frames.findIndex((fr, k) => fr.type === 'photo' && k !== idx);
    this.cleanIdx = Math.max(0, ci);
    // working resolution: the photo's own resolution (max 1920 on the long side)
    let W, H;
    const img = f.type === 'photo' ? await loadImage(f.img) : null;
    if (img) { const k = Math.min(1, 1920 / Math.max(img.width, img.height)); W = Math.round(img.width * k); H = Math.round(img.height * k); }
    else ({ w: W, h: H } = aspectSize(p.aspect, 1280));
    this.W = W; this.H = H;
    for (const c of [this.base, this.ref, this.layer, this.cursor]) { c.width = W; c.height = H; }
    this.bx.clearRect(0, 0, W, H);
    if (img) drawCover(this.bx, img, W, H);
    else if (f.type === 'title') drawTitle(this.bx, W, H, f.title, 1);
    this.lx.clearRect(0, 0, W, H);
    if (f.paint) { const pi = await loadImage(f.paint); if (pi) this.lx.drawImage(pi, 0, 0, W, H); }
    this.baseDirty = false;
    this.undoStack = []; this.redoStack = [];
    this.cleanPlate = null;
    const cf = p.frames[this.cleanIdx];
    if (cf && cf.type === 'photo' && this.cleanIdx !== idx) { const ci = await loadImage(cf.img); if (ci) { const c = document.createElement('canvas'); c.width = W; c.height = H; drawCover(c.getContext('2d'), ci, W, H); this.cleanPlate = c; } }
    $('paintIdx').textContent = `${idx + 1} / ${p.frames.length}`;
    $('paintShowRef').parentElement.style.display = p.settings.reference.blob ? '' : 'none';
    if (p.settings.reference.blob && p.settings.reference.on) $('paintShowRef').checked = true;
    this.app.showScreen('paintScreen');
    this.isOpen = true;
    this.fit();
    await this.drawRef();
    this.updateHint();
  }

  fit() {
    const st = $('paintStage').getBoundingClientRect();
    const k = Math.min((st.width - 16) / this.W, (st.height - 16) / this.H);
    const inner = $('paintInner');
    inner.style.width = this.W * k + 'px'; inner.style.height = this.H * k + 'px';
    this.base.style.width = '100%'; this.base.style.height = '100%';
  }

  async drawRef() {
    const p = this.app.project, rx = this.rx;
    rx.clearRect(0, 0, this.W, this.H);
    if ($('paintOnion').checked && this.idx > 0) {
      const pf = p.frames[this.idx - 1];
      rx.globalAlpha = 0.35;
      if (pf.type === 'photo') { const im = await loadImage(pf.img); if (im) drawCover(rx, im, this.W, this.H); }
      if (pf.paint) { const pi = await loadImage(pf.paint); if (pi) rx.drawImage(pi, 0, 0, this.W, this.H); }
      rx.globalAlpha = 1;
    }
    if ($('paintShowRef').checked && p.settings.reference.blob) {
      const src = await this.app.referenceAt(this.idx);
      if (src) { rx.globalAlpha = p.settings.reference.opacity; drawCover(rx, src, this.W, this.H); rx.globalAlpha = 1; }
    }
  }

  pt(e) {
    const r = this.cursor.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * this.W, y: (e.clientY - r.top) / r.height * this.H, pr: e.pressure || 0.5 };
  }
  get color() { return $('paintColor').value; }
  get size() { return +$('paintSize').value * this.W / 1000; }
  get alpha() { return +$('paintAlpha').value / 100; }

  snapshot() {
    this.undoStack.push({ layer: this.lx.getImageData(0, 0, this.W, this.H), base: this.tool === 'magic' ? this.bx.getImageData(0, 0, this.W, this.H) : null });
    if (this.undoStack.length > 20) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    const s = this.undoStack.pop(); if (!s) return;
    this.redoStack.push({ layer: this.lx.getImageData(0, 0, this.W, this.H), base: s.base ? this.bx.getImageData(0, 0, this.W, this.H) : null });
    this.lx.putImageData(s.layer, 0, 0); if (s.base) this.bx.putImageData(s.base, 0, 0);
  }
  redo() {
    const s = this.redoStack.pop(); if (!s) return;
    this.undoStack.push({ layer: this.lx.getImageData(0, 0, this.W, this.H), base: s.base ? this.bx.getImageData(0, 0, this.W, this.H) : null });
    this.lx.putImageData(s.layer, 0, 0); if (s.base) this.bx.putImageData(s.base, 0, 0);
  }

  down(e) {
    if (e.button > 0) return;
    e.preventDefault();
    this.cursor.parentElement.setPointerCapture?.(e.pointerId);
    const p = this.pt(e);
    if (this.tool === 'pick') { this.pick(p); return; }
    if (this.tool === 'text') { this.addText(p); return; }
    if (this.tool === 'fill') { this.snapshot(); this.fill(p); return; }
    if (this.tool === 'magic' && !this.cleanPlate) { this.app.toast('Pick a different clean-plate frame first (Edit ▸ Clean plate).'); return; }
    this.snapshot();
    this.drawing = true; this.start = p; this.last = p;
    if (['brush', 'marker', 'eraser', 'magic'].includes(this.tool)) this.stroke(p, p);
  }
  move(e) {
    const p = this.pt(e);
    this.cx.clearRect(0, 0, this.W, this.H);
    if (!this.drawing) { // brush preview
      if (['brush', 'marker', 'eraser', 'magic'].includes(this.tool) && e.pointerType === 'mouse') { this.cx.strokeStyle = '#fff'; this.cx.lineWidth = this.W / 800; this.cx.beginPath(); this.cx.arc(p.x, p.y, this.size / 2, 0, 7); this.cx.stroke(); }
      return;
    }
    if (['brush', 'marker', 'eraser', 'magic'].includes(this.tool)) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of evs) { const q = this.pt(ce); this.stroke(this.last, q); this.last = q; }
    } else this.shape(this.cx, this.start, p);
  }
  up(e) {
    if (!this.drawing) return;
    this.drawing = false;
    if (['line', 'rect', 'ellipse'].includes(this.tool)) { this.cx.clearRect(0, 0, this.W, this.H); this.shape(this.lx, this.start, this.pt(e)); }
    if (this.tool === 'magic') this.baseDirty = true;
  }

  stroke(a, b) {
    const t = this.tool;
    const ctx = t === 'magic' ? this.bx : this.lx;
    const size = this.size * (t === 'brush' ? (0.6 + b.pr * 0.8) : 1);
    ctx.save();
    ctx.lineCap = t === 'marker' ? 'square' : 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, size);
    if (t === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; }
    else if (t === 'magic') {
      // clip to the brush stroke, then copy the clean plate through it
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      const path = new Path2D(); const r = size / 2;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r / 2)));
      for (let i = 0; i <= steps; i++) { const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps; path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2); }
      ctx.clip(path); ctx.drawImage(this.cleanPlate, 0, 0); ctx.restore(); return;
    }
    else { ctx.strokeStyle = this.color; ctx.globalAlpha = t === 'marker' ? this.alpha * 0.35 : this.alpha; }
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x + 0.01, b.y); ctx.stroke();
    ctx.restore();
  }

  shape(ctx, a, b) {
    ctx.save(); ctx.strokeStyle = this.color; ctx.globalAlpha = this.alpha; ctx.lineWidth = Math.max(1, this.size); ctx.lineCap = 'round';
    ctx.beginPath();
    if (this.tool === 'line') { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    if (this.tool === 'rect') ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    if (this.tool === 'ellipse') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke(); ctx.restore();
  }

  async addText(p) {
    const text = await this.app.prompt('Add text', '', 'Type your text');
    if (!text) return;
    this.snapshot();
    const fs = Math.max(10, this.size * 3);
    this.lx.save(); this.lx.font = `bold ${fs}px -apple-system, Roboto, sans-serif`; this.lx.textBaseline = 'middle'; this.lx.textAlign = 'center';
    this.lx.globalAlpha = this.alpha; this.lx.lineWidth = fs / 8; this.lx.strokeStyle = '#0009'; this.lx.lineJoin = 'round';
    text.split('\n').forEach((ln, i) => { this.lx.strokeText(ln, p.x, p.y + i * fs * 1.2); this.lx.fillStyle = this.color; this.lx.fillText(ln, p.x, p.y + i * fs * 1.2); });
    this.lx.restore();
  }

  pick(p) {
    const c = document.createElement('canvas'); c.width = 1; c.height = 1; const x = c.getContext('2d');
    x.drawImage(this.base, p.x, p.y, 1, 1, 0, 0, 1, 1); x.drawImage(this.layer, p.x, p.y, 1, 1, 0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    $('paintColor').value = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    this.app.toast('Colour picked');
  }

  fill(p) {
    const W = this.W, H = this.H;
    const comp = document.createElement('canvas'); comp.width = W; comp.height = H;
    const cx = comp.getContext('2d', { willReadFrequently: true }); cx.drawImage(this.base, 0, 0); cx.drawImage(this.layer, 0, 0);
    const src = cx.getImageData(0, 0, W, H).data;
    const layer = this.lx.getImageData(0, 0, W, H), ld = layer.data;
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    const i0 = (y0 * W + x0) * 4;
    const tr = src[i0], tg = src[i0 + 1], tb = src[i0 + 2];
    const [fr, fg, fb] = hexToRgb(this.color), fa = Math.round(this.alpha * 255);
    const tol = 48 * 48 * 3;
    const seen = new Uint8Array(W * H);
    const stack = [x0, y0];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      let lx = x; while (lx >= 0 && match(lx, y)) lx--; lx++;
      let rx = x; while (rx < W && match(rx, y)) rx++; rx--;
      for (let i = lx; i <= rx; i++) {
        const q = y * W + i; seen[q] = 1; const k = q * 4; ld[k] = fr; ld[k + 1] = fg; ld[k + 2] = fb; ld[k + 3] = fa;
        if (y > 0 && match(i, y - 1)) stack.push(i, y - 1);
        if (y < H - 1 && match(i, y + 1)) stack.push(i, y + 1);
      }
    }
    function match(x, y) { const q = y * W + x; if (seen[q]) return false; const k = q * 4; const dr = src[k] - tr, dg = src[k + 1] - tg, db = src[k + 2] - tb; return dr * dr + dg * dg + db * db <= tol; }
    // grow the fill by one pixel so it tucks under anti-aliased outlines
    this.lx.putImageData(layer, 0, 0);
  }

  async save() {
    const p = this.app.project, f = p.frames[this.idx];
    const ld = this.lx.getImageData(0, 0, this.W, this.H).data;
    let empty = true; for (let i = 3; i < ld.length; i += 4) if (ld[i]) { empty = false; break; }
    const oldPaint = f.paint;
    f.paint = empty ? null : await db.putBlob(await new Promise(r => this.layer.toBlob(r, 'image/png')));
    if (oldPaint) forgetImage(oldPaint);
    if (this.baseDirty && f.type === 'photo') {
      await this.app.replaceFrameImage(f, this.base);
    }
    await this.app.refreshThumb(f);
  }

  async step(d) {
    const n = this.idx + d;
    if (n < 0 || n >= this.app.project.frames.length) return;
    this.app.pushUndo();
    await this.save();
    await this.app.save();
    await this.open(n);
  }

  async close(keep) {
    if (keep) { this.app.pushUndo(); await this.save(); await this.app.save(); }
    this.isOpen = false;
    this.app.showScreen('studio');
    this.app.current = this.idx;
    this.app.renderTimeline(); this.app.showFrame();
  }
}
