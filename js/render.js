// Frame compositor: photo -> green screen -> paint -> filters/adjustments -> overlay -> titles -> fades.
import { loadImage } from './db.js';
import { frameStartTick, totalTicks } from './project.js';

export function srcSize(src) {
  return { w: src.videoWidth || src.naturalWidth || src.width, h: src.videoHeight || src.naturalHeight || src.height };
}

export function drawCover(ctx, src, w, h, mode = 'cover') {
  const s = srcSize(src);
  if (!s.w || !s.h) return;
  const scale = mode === 'contain' ? Math.min(w / s.w, h / s.h) : mode === 'stretch' ? null : Math.max(w / s.w, h / s.h);
  if (scale === null) { ctx.drawImage(src, 0, 0, w, h); return; }
  const dw = s.w * scale, dh = s.h * scale;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function hexToRgb(hex) { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export { hexToRgb };

function mkCanvas(w, h) {
  if (self.OffscreenCanvas) { try { const c = new OffscreenCanvas(w, h); if (c.getContext('2d')) return c; } catch (e) { } }
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
export { mkCanvas };

// ---------- Green screen ----------
export function chromaKey(data, keyHex, tol, soft, spill) {
  const [kr, kg, kb] = hexToRgb(keyHex);
  const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb, kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const T = tol * 180, S = Math.max(1, soft * 180);
  const dom = kg >= kr && kg >= kb ? 1 : kb >= kr ? 2 : 0;
  const alpha = new Float32Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    const d = Math.hypot(cb - kcb, cr - kcr);
    let a = d <= T ? 0 : d >= T + S ? 1 : (d - T) / S;
    alpha[p] = a;
    if (a > 0 && spill > 0) { // spill suppression: pull the key's dominant channel down
      const o1 = dom === 0 ? g : r, o2 = dom === 2 ? g : b;
      const lim = Math.max(o1, o2);
      const c = data[i + dom];
      if (c > lim) data[i + dom] = c - (c - lim) * spill * (1 - a * 0.5);
    }
  }
  return alpha;
}

// ---------- Pixel effects ----------
const THERMAL = [[0, 0, 40], [40, 0, 120], [150, 0, 150], [230, 60, 30], [255, 170, 0], [255, 255, 160]];
function thermal(l) { const x = l / 255 * (THERMAL.length - 1); const i = Math.min(THERMAL.length - 2, Math.floor(x)); const t = x - i; const a = THERMAL[i], b = THERMAL[i + 1]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

export function processPixels(img, w, h, o) {
  const d = img.data;
  const { filter = 'none', amount = 1, adjust = {}, gain = 1, seed = 1 } = o;
  const br = (adjust.brightness || 0) * 255, ct = 1 + (adjust.contrast || 0), sat = 1 + (adjust.saturation || 0), warm = (adjust.warmth || 0) * 40;
  const rand = mulberry32(seed * 7919);
  let flick = 0;
  if (filter === 'oldfilm') flick = (rand() - 0.5) * 22;
  // LUT for gain/brightness/contrast
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v * gain + br + flick) - 128) * ct + 128;
  const noAdj = gain === 1 && !br && ct === 1 && sat === 1 && !warm && !flick;
  if (filter === 'sketch') sketch(d, w, h);
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (!noAdj) {
      r = lut[r]; g = lut[g]; b = lut[b];
      if (sat !== 1) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
      if (warm) { r += warm; b -= warm; }
    }
    if (filter !== 'none' && filter !== 'pixel' && filter !== 'sketch') {
      let nr = r, ng = g, nb = b;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      switch (filter) {
        case 'bw': nr = ng = nb = l; break;
        case 'sepia': nr = r * .393 + g * .769 + b * .189; ng = r * .349 + g * .686 + b * .168; nb = r * .272 + g * .534 + b * .131; break;
        case 'noir': { const c = (l - 128) * 1.6 + 128; nr = ng = nb = c; break; }
        case 'oldfilm': { const c = (l - 128) * 1.2 + 128; nr = c * 1.07 + 10; ng = c * 0.98 + 4; nb = c * 0.82; break; }
        case 'retro': nr = r * 0.9 + 40; ng = g * 0.85 + 25; nb = b * 0.7 + 20; { const m = (nr + ng + nb) / 3; nr = m + (nr - m) * 0.8; ng = m + (ng - m) * 0.8; nb = m + (nb - m) * 0.8; } break;
        case 'warm': nr = r * 1.1 + 15; ng = g * 1.02 + 5; nb = b * 0.85; break;
        case 'cool': nr = r * 0.85; ng = g * 1.0 + 5; nb = b * 1.15 + 15; break;
        case 'vivid': nr = l + (r - l) * 1.6; ng = l + (g - l) * 1.6; nb = l + (b - l) * 1.6; nr = (nr - 128) * 1.1 + 128; ng = (ng - 128) * 1.1 + 128; nb = (nb - 128) * 1.1 + 128; break;
        case 'faded': nr = (l + (r - l) * 0.6) * 0.8 + 45; ng = (l + (g - l) * 0.6) * 0.8 + 42; nb = (l + (b - l) * 0.6) * 0.8 + 50; break;
        case 'dreamy': nr = r * 0.85 + 50; ng = g * 0.8 + 38; nb = b * 0.85 + 50; break;
        case 'comic': { const q = v => Math.round(v / 64) * 64; const s2 = 1.5; nr = q(l + (r - l) * s2); ng = q(l + (g - l) * s2); nb = q(l + (b - l) * s2); break; }
        case 'invert': nr = 255 - r; ng = 255 - g; nb = 255 - b; break;
        case 'thermal': [nr, ng, nb] = thermal(Math.max(0, Math.min(255, l))); break;
      }
      if (amount >= 1) { r = nr; g = ng; b = nb; } else { r += (nr - r) * amount; g += (ng - g) * amount; b += (nb - b) * amount; }
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
}

function sketch(d, w, h) {
  const L = new Float32Array(w * h);
  for (let i = 0, p = 0; p < L.length; i += 4, p++) L[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    const xm = x > 0 ? p - 1 : p, xp = x < w - 1 ? p + 1 : p, ym = y > 0 ? p - w : p, yp = y < h - 1 ? p + w : p;
    const gx = L[xp] - L[xm], gy = L[yp] - L[ym];
    const v = 255 - Math.min(255, Math.hypot(gx, gy) * 2.2);
    const i = p * 4; d[i] = d[i + 1] = d[i + 2] = v * 0.95 + 10;
  }
}

function drawVignette(ctx, w, h, amt) {
  if (!amt) return;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.85 * amt})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

const grainCache = {};
function grainPattern(ctx, seed) {
  const k = seed % 4;
  if (!grainCache[k]) {
    const c = mkCanvas(128, 128), x = c.getContext('2d'); const id = x.createImageData(128, 128); const r = mulberry32(k + 99);
    for (let i = 0; i < id.data.length; i += 4) { const v = r() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    x.putImageData(id, 0, 0); grainCache[k] = c;
  }
  return ctx.createPattern(grainCache[k], 'repeat');
}
function drawGrain(ctx, w, h, amt, seed) {
  if (!amt) return;
  ctx.save(); ctx.globalAlpha = amt * 0.35; ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = grainPattern(ctx, seed); const s = Math.max(1, Math.round(w / 640));
  ctx.translate((seed * 37) % 128, (seed * 61) % 128); ctx.scale(s, s); ctx.fillRect(-128, -128, w / s + 256, h / s + 256);
  ctx.restore();
}
function drawScratches(ctx, w, h, seed) {
  const r = mulberry32(seed * 31 + 7);
  ctx.save(); ctx.strokeStyle = 'rgba(255,250,230,0.35)'; ctx.lineWidth = Math.max(1, w / 900);
  const n = Math.floor(r() * 3);
  for (let i = 0; i < n; i++) { const x = r() * w; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (r() - .5) * 20, h); ctx.stroke(); }
  if (r() < 0.25) { ctx.fillStyle = 'rgba(20,15,10,0.5)'; ctx.beginPath(); ctx.arc(r() * w, r() * h, r() * w / 120 + 1, 0, 7); ctx.fill(); }
  ctx.restore();
}

// ---------- Titles ----------
const FONTS = {
  serif: 'Georgia, "Times New Roman", serif', sans: '-apple-system, "Helvetica Neue", Roboto, Arial, sans-serif',
  mono: 'ui-monospace, Menlo, "Courier New", monospace', rounded: '"Arial Rounded MT Bold", "Trebuchet MS", sans-serif',
  hand: '"Marker Felt", "Comic Sans MS", "Chalkboard SE", cursive', display: 'Impact, "Arial Black", sans-serif',
};
export const TITLE_STYLES = { classic: 'Classic', silent: 'Silent film', comic: 'Comic', soft: 'Soft', retro: 'Retro', neon: 'Neon', credits: 'Rolling credits', plain: 'Plain (transparent)' };
export const TITLE_ANIMS = { none: 'None', fade: 'Fade in', type: 'Typewriter', zoom: 'Zoom in', slide: 'Slide up', scroll: 'Scroll (credits)' };

export function drawTitle(ctx, w, h, t, progress) {
  const fontFam = FONTS[t.font] || FONTS.serif;
  const base = Math.min(w, h * 1.6) / 12 * (t.size || 1);
  ctx.save();
  // background
  if (t.style !== 'plain') {
    if (t.style === 'retro') { const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#f6a04d'); g.addColorStop(.5, '#e0533d'); g.addColorStop(1, '#5b2a6e'); ctx.fillStyle = g; }
    else if (t.style === 'soft') { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#ffd1e8'); g.addColorStop(1, '#c9e4ff'); ctx.fillStyle = g; }
    else if (t.style === 'comic') ctx.fillStyle = t.bg && t.bg !== '#000000' ? t.bg : '#ffd60a';
    else if (t.style === 'neon') ctx.fillStyle = '#07051a';
    else ctx.fillStyle = t.bg || '#000';
    ctx.fillRect(0, 0, w, h);
  }
  if (t.style === 'comic') { // starburst rays
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 24; i++) { ctx.rotate(Math.PI / 12); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.hypot(w, h), -base * 0.6); ctx.lineTo(Math.hypot(w, h), base * 0.6); ctx.fill(); i++; ctx.rotate(Math.PI / 12); }
    ctx.restore();
  }
  if (t.style === 'silent') { // double ornamental border
    ctx.strokeStyle = t.fg || '#fff'; ctx.lineWidth = Math.max(2, w / 300);
    const m = w * 0.05; ctx.strokeRect(m, m, w - 2 * m, h - 2 * m);
    ctx.lineWidth = Math.max(1, w / 700); ctx.strokeRect(m * 1.4, m * 1.4, w - 2.8 * m, h - 2.8 * m);
    for (const [x, y] of [[m * 1.4, m * 1.4], [w - m * 1.4, m * 1.4], [m * 1.4, h - m * 1.4], [w - m * 1.4, h - m * 1.4]]) { ctx.beginPath(); ctx.arc(x, y, m * 0.25, 0, 7); ctx.stroke(); }
  }
  if (t.style === 'retro') { ctx.fillStyle = 'rgba(255,255,255,0.12)'; for (let i = 0; i < 5; i++) ctx.fillRect(0, h * (0.62 + i * 0.07), w, h * 0.025); }

  // animation
  let alpha = 1, scale = 1, dy = 0, text = t.text || '';
  const p = Math.max(0, Math.min(1, progress));
  const anim = t.style === 'credits' && t.anim === 'none' ? 'scroll' : t.anim;
  if (anim === 'fade') alpha = Math.min(1, p * 2.5);
  if (anim === 'zoom') { const e = Math.min(1, p * 2); scale = 0.4 + 0.6 * (1 - Math.pow(1 - e, 3)); alpha = Math.min(1, p * 3); }
  if (anim === 'slide') { const e = Math.min(1, p * 2); dy = (1 - (1 - Math.pow(1 - e, 3))) * h * 0.4; alpha = Math.min(1, p * 3); }
  if (anim === 'type') { const total = text.length + (t.sub || '').length; const n = Math.floor(Math.min(1, p * 1.4) * total); text = text.slice(0, n); t = Object.assign({}, t, { sub: (t.sub || '').slice(0, Math.max(0, n - (t.text || '').length)) }); }

  ctx.globalAlpha = alpha;
  const fg = t.style === 'comic' ? '#111' : t.style === 'soft' ? (t.fg === '#ffffff' ? '#5a3d73' : t.fg) : (t.fg || '#fff');
  const lines = text.split('\n');
  const subLines = (t.sub || '').split('\n').filter(Boolean);
  const lh = base * 1.2, slh = base * 0.6;
  const blockH = lines.length * lh + (subLines.length ? subLines.length * slh + base * 0.4 : 0);
  ctx.textAlign = t.align || 'center'; ctx.textBaseline = 'middle';
  const x = ctx.textAlign === 'left' ? w * 0.1 : ctx.textAlign === 'right' ? w * 0.9 : w / 2;
  let y0 = h / 2 - blockH / 2 + lh / 2 + dy;
  if (anim === 'scroll') y0 = h + lh - p * (h + blockH + lh * 2);
  ctx.translate(w / 2, h / 2); ctx.scale(scale, scale); ctx.translate(-w / 2, -h / 2);
  const weight = t.style === 'comic' || t.font === 'display' ? '900 ' : t.style === 'retro' ? 'bold ' : '';
  ctx.font = `${weight}${base}px ${fontFam}`;
  if (t.style === 'neon') { ctx.shadowColor = t.fg === '#ffffff' ? '#29f0ff' : t.fg; ctx.shadowBlur = base * 0.5; }
  lines.forEach((ln, i) => {
    const y = y0 + i * lh;
    if (t.style === 'comic' || t.style === 'plain') { ctx.lineWidth = base * 0.12; ctx.strokeStyle = t.style === 'comic' ? '#fff' : '#000'; ctx.lineJoin = 'round'; ctx.strokeText(ln, x, y); }
    if (t.style === 'retro') { ctx.fillStyle = '#2b1240'; ctx.fillText(ln, x + base * 0.06, y + base * 0.06); }
    ctx.fillStyle = fg; ctx.fillText(ln, x, y);
  });
  if (subLines.length) {
    ctx.font = `${base * 0.5}px ${fontFam}`;
    subLines.forEach((ln, i) => { const y = y0 + lines.length * lh + base * 0.2 + i * slh; if (t.style === 'plain') { ctx.lineWidth = base * 0.08; ctx.strokeText(ln, x, y); } ctx.fillStyle = fg; ctx.fillText(ln, x, y); });
  }
  ctx.restore();
}

// ---------- Main entry ----------
// assets: { chromaBg: drawable|null, overlay: drawable|null }
export async function renderFrame(ctx, p, idx, w, h, opts = {}) {
  const s = p.settings, f = p.frames[idx];
  const sub = opts.sub || 0;
  ctx.save();
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  if (!f) { ctx.restore(); return; }
  const seed = frameStartTick(p, idx) + sub + 1;

  if (f.type === 'title') {
    if (f.title.overPrev || f.title.style === 'plain') {
      let prev = idx - 1; while (prev >= 0 && p.frames[prev].type !== 'photo') prev--;
      if (prev >= 0) await renderFrame(ctx, p, prev, w, h, Object.assign({}, opts, { sub: 0, noFade: true, noTitleOverlay: true }));
    }
    drawTitle(ctx, w, h, f.title, (sub + 0.5) / (f.hold || 1));
    if (f.paint) { const pi = await loadImage(f.paint); if (pi) ctx.drawImage(pi, 0, 0, w, h); }
  } else {
    // 1. photo (or paper for tracing/rotoscope output)
    const img = s.tracing.hidePhotos ? null : await loadImage(f.img);
    if (s.tracing.hidePhotos) { ctx.fillStyle = s.tracing.paperColor; ctx.fillRect(0, 0, w, h); }
    else if (img) drawCover(ctx, img, w, h);

    const filt = s.filter.name, adj = s.adjust;
    const needChroma = s.chroma.on && !s.tracing.hidePhotos;
    const gain = s.deflicker && opts.gains ? (opts.gains[idx] || 1) : 1;
    const needPix = filt !== 'none' || adj.brightness || adj.contrast || adj.saturation || adj.warmth || gain !== 1;

    // 2. green screen composite
    if (needChroma) {
      const id = ctx.getImageData(0, 0, w, h);
      const a = chromaKey(id.data, s.chroma.color, s.chroma.tolerance, s.chroma.softness, s.chroma.spill);
      const bgc = mkCanvas(w, h), bx = bgc.getContext('2d');
      if (s.chroma.bgType === 'color' || !opts.assets?.chromaBg) { bx.fillStyle = s.chroma.bgColor; bx.fillRect(0, 0, w, h); }
      else if (s.chroma.bgType === 'transparent') { /* keep alpha */ }
      else drawCover(bx, opts.assets.chromaBg, w, h, s.chroma.bgFit);
      const bd = bx.getImageData(0, 0, w, h).data, d = id.data;
      const keepAlpha = s.chroma.bgType === 'transparent';
      for (let i = 0, q = 0; i < d.length; i += 4, q++) {
        const al = a[q]; if (al >= 1) continue;
        if (keepAlpha) { d[i + 3] = al * 255; continue; }
        d[i] = d[i] * al + bd[i] * (1 - al); d[i + 1] = d[i + 1] * al + bd[i + 1] * (1 - al); d[i + 2] = d[i + 2] * al + bd[i + 2] * (1 - al);
      }
      ctx.putImageData(id, 0, 0);
    }
    // 3. paint layer (drawn before filters so drawings get the movie look)
    if (f.paint) { const pi = await loadImage(f.paint); if (pi) ctx.drawImage(pi, 0, 0, w, h); }

    if (filt === 'pixel') {
      const k = Math.max(4, Math.round(w / 96)); const sc = mkCanvas(Math.ceil(w / k), Math.ceil(h / k)); const sx = sc.getContext('2d');
      sx.drawImage(ctx.canvas, 0, 0, sc.width, sc.height); ctx.imageSmoothingEnabled = false; ctx.drawImage(sc, 0, 0, w, h); ctx.imageSmoothingEnabled = true;
    }
    if (needPix) {
      const id = ctx.getImageData(0, 0, w, h);
      processPixels(id, w, h, { filter: filt, amount: s.filter.amount, adjust: adj, gain, seed });
      ctx.putImageData(id, 0, 0);
    }
    drawVignette(ctx, w, h, adj.vignette);
    drawGrain(ctx, w, h, adj.grain, seed);
    if (filt === 'oldfilm') drawScratches(ctx, w, h, seed);
  }

  // 4. foreground overlay
  if (s.overlay.on && opts.assets?.overlay) { ctx.globalAlpha = s.overlay.opacity; drawCover(ctx, opts.assets.overlay, w, h, 'stretch'); ctx.globalAlpha = 1; }
  // 5. watermark / caption
  if (s.watermark.on && s.watermark.text) {
    const fs = Math.max(10, h / 24); ctx.font = `600 ${fs}px -apple-system, Roboto, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillText(s.watermark.text, w - fs * 0.6 + 1, h - fs * 0.5 + 1); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillText(s.watermark.text, w - fs * 0.6, h - fs * 0.5);
  }
  // 6. fades
  if (!opts.noFade && (s.fade.inSec || s.fade.outSec)) {
    const tick = frameStartTick(p, idx) + sub, total = totalTicks(p), fps = p.fps;
    const t = tick / fps, end = total / fps;
    let a = 0;
    if (s.fade.inSec && t < s.fade.inSec) a = Math.max(a, 1 - t / s.fade.inSec);
    if (s.fade.outSec && t > end - s.fade.outSec) a = Math.max(a, 1 - (end - t - 1 / fps) / s.fade.outSec);
    if (a > 0) { ctx.globalAlpha = Math.min(1, a); ctx.fillStyle = s.fade.color; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1; }
  }
  ctx.restore();
}

// Per-frame brightness gains so the movie doesn't flicker (uses lum stored with thumbnails).
export function deflickerGains(p) {
  const L = p.frames.map(f => f.type === 'photo' && f.lum ? f.lum : null);
  return L.map((l, i) => {
    if (!l) return 1;
    let sum = 0, n = 0;
    for (let j = i - 4; j <= i + 4; j++) if (L[j]) { sum += L[j]; n++; }
    return Math.max(0.7, Math.min(1.4, (sum / n) / l));
  });
}

export function aspectSize(aspect, longSide) {
  const ar = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16, '3:4': 3 / 4, '2.39:1': 2.39 }[aspect] || 16 / 9;
  let w, h;
  if (ar >= 1) { w = longSide; h = Math.round(longSide / ar); } else { h = longSide; w = Math.round(longSide * ar); }
  return { w: w & ~1, h: h & ~1 };
}
