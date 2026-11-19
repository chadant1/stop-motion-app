import { uid } from './db.js';

export const ASPECTS = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16, '3:4': 3 / 4, '2.39:1': 2.39 };

export function newProject(name = 'My Movie') {
  return {
    id: uid(), name, created: Date.now(), updated: Date.now(), version: 1,
    fps: 12, aspect: '16:9',
    frames: [],
    audio: [],
    settings: defaultSettings(),
  };
}

export function defaultSettings() {
  return {
    onion: { on: true, opacity: 0.4, count: 1, next: false },
    grid: 'off', // off | thirds | fine | center
    playback: { loop: true, pingpong: false },
    chroma: { on: false, color: '#00ff00', tolerance: 0.32, softness: 0.12, spill: 0.5, bgType: 'color', bgColor: '#1e90ff', bgBlob: null, bgFit: 'cover' },
    filter: { name: 'none', amount: 1 },
    adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0, vignette: 0, grain: 0 },
    deflicker: false,
    fade: { inSec: 0, outSec: 0, color: '#000000' },
    overlay: { blob: null, opacity: 1, on: false },   // foreground image (PNG with transparency) baked into export
    reference: { blob: null, kind: null, opacity: 0.5, on: false, sync: true }, // rotoscope / guide layer, NOT exported
    tracing: { hidePhotos: false, paperColor: '#ffffff' },
    capture: { framesPerShot: 1, mirror: false, resolution: 1080, quality: 0.92 },
    timer: { delay: 0, interval: 5, count: 0 },
    theme: 'none',
    watermark: { on: false, text: '' },
  };
}

// Ensure older/imported projects have every field.
export function migrate(p) {
  const d = defaultSettings();
  p.settings = p.settings || {};
  for (const k of Object.keys(d)) {
    if (p.settings[k] === undefined) p.settings[k] = d[k];
    else if (typeof d[k] === 'object' && d[k] && !Array.isArray(d[k])) p.settings[k] = Object.assign({}, d[k], p.settings[k]);
  }
  p.frames = p.frames || [];
  p.audio = p.audio || [];
  p.fps = p.fps || 12;
  p.aspect = p.aspect || '16:9';
  for (const f of p.frames) { f.hold = f.hold || 1; f.type = f.type || 'photo'; }
  return p;
}

export function newPhotoFrame(img, thumb) { return { id: uid(), type: 'photo', img, thumb, paint: null, hold: 1 }; }

export function newTitleFrame(opts = {}) {
  return {
    id: uid(), type: 'title', hold: opts.hold || 24, paint: null,
    title: Object.assign({ text: 'The End', sub: '', style: 'classic', fg: '#ffffff', bg: '#000000', font: 'serif', size: 1, align: 'center', anim: 'none', overPrev: false }, opts),
  };
}

// Movie length in "ticks" (one tick = 1/fps second); each frame lasts `hold` ticks.
export function totalTicks(p) { return p.frames.reduce((a, f) => a + (f.hold || 1), 0); }
export function frameStartTick(p, idx) { let t = 0; for (let i = 0; i < idx && i < p.frames.length; i++) t += p.frames[i].hold || 1; return t; }
export function frameAtTick(p, tick) {
  let t = 0;
  for (let i = 0; i < p.frames.length; i++) { const h = p.frames[i].hold || 1; if (tick < t + h) return { idx: i, sub: tick - t }; t += h; }
  return { idx: p.frames.length - 1, sub: 0 };
}

export const THEMES = {
  none: { label: 'None' },
  silent: { label: 'Silent Film', filter: 'oldfilm', adjust: { contrast: 0.15, vignette: 0.6, grain: 0.35 }, fade: { inSec: 1, outSec: 1, color: '#000000' }, titleStyle: 'silent' },
  noir: { label: 'Noir', filter: 'noir', adjust: { contrast: 0.3, vignette: 0.7, grain: 0.15 }, fade: { inSec: 1, outSec: 1.5, color: '#000000' }, titleStyle: 'classic' },
  comic: { label: 'Comic Book', filter: 'comic', adjust: { saturation: 0.4, contrast: 0.2 }, fade: { inSec: 0, outSec: 0.5, color: '#ffffff' }, titleStyle: 'comic' },
  dreamy: { label: 'Dreamy', filter: 'dreamy', adjust: { brightness: 0.05, warmth: 0.25, vignette: 0.3 }, fade: { inSec: 1.5, outSec: 1.5, color: '#ffffff' }, titleStyle: 'soft' },
  retro: { label: 'Retro 70s', filter: 'retro', adjust: { warmth: 0.35, grain: 0.25, vignette: 0.4 }, fade: { inSec: 0.8, outSec: 0.8, color: '#000000' }, titleStyle: 'retro' },
  space: { label: 'Neon Space', filter: 'cool', adjust: { contrast: 0.2, saturation: 0.3, vignette: 0.5 }, fade: { inSec: 1, outSec: 1, color: '#000000' }, titleStyle: 'neon' },
};

export const FILTERS = {
  none: 'None', bw: 'Black & White', sepia: 'Sepia', noir: 'Noir', oldfilm: 'Old Film', retro: 'Retro',
  warm: 'Warm', cool: 'Cool', vivid: 'Vivid', faded: 'Faded', dreamy: 'Dreamy', comic: 'Comic', invert: 'Negative', thermal: 'Thermal', pixel: 'Pixel', sketch: 'Sketch',
};
