// Audio: voice recording, imported music, synthesized sound effects, synced playback, mixdown.
import { db } from './db.js';

let ctx = null;
export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const bufCache = new Map();
export async function decodeClip(blobKey) {
  if (bufCache.has(blobKey)) return bufCache.get(blobKey);
  const p = (async () => {
    const b = await db.getBlob(blobKey);
    if (!b) return null;
    const ab = await b.arrayBuffer();
    return await new Promise((res, rej) => { const r = audioCtx().decodeAudioData(ab, res, rej); if (r && r.then) r.then(res, rej); });
  })().catch(e => { console.warn('decode failed', e); return null; });
  bufCache.set(blobKey, p);
  return p;
}

// ---------- Recording ----------
export class VoiceRecorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
    const mimeType = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.rec.start(100);
    this.t0 = performance.now();
  }
  stop() {
    return new Promise(res => {
      this.rec.onstop = () => { this.stream.getTracks().forEach(t => t.stop()); res(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' })); };
      this.rec.stop();
    });
  }
}

// ---------- Sound effects (synthesized, so they're original and royalty-free) ----------
export const SFX = {
  pop: 'Pop', boing: 'Boing', whoosh: 'Whoosh', click: 'Click', ding: 'Ding', laser: 'Laser', boom: 'Boom', step: 'Footstep',
  drum: 'Drum hit', crash: 'Crash', squeak: 'Squeak', magic: 'Magic sparkle', slide: 'Slide whistle', thud: 'Thud', alarm: 'Alarm', tada: 'Ta-da!',
};

export async function synthSfx(name) {
  const sr = 44100, len = { boom: 1.6, crash: 1.4, tada: 1.3, magic: 1.2, slide: 1.0, alarm: 1.2, whoosh: 0.7, ding: 1.2 }[name] || 0.5;
  const oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, Math.ceil(sr * len), sr);
  const out = oc.createGain(); out.gain.value = 0.8; out.connect(oc.destination);
  const noise = () => { const b = oc.createBuffer(1, sr * len, sr); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = oc.createBufferSource(); s.buffer = b; return s; };
  const osc = (type, f) => { const o = oc.createOscillator(); o.type = type; o.frequency.value = f; return o; };
  const env = (a, d, peak = 1, t0 = 0) => { const g = oc.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + a); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d); return g; };
  const play = (src, node, t0 = 0, t1 = len) => { src.connect(node); node.connect(out); src.start(t0); src.stop(t1); };
  switch (name) {
    case 'pop': { const o = osc('sine', 600); o.frequency.exponentialRampToValueAtTime(120, 0.08); play(o, env(0.002, 0.1)); break; }
    case 'boing': { const o = osc('triangle', 180); for (let i = 0; i < 10; i++) o.frequency.setValueAtTime(180 + Math.sin(i) * 60 + i * 15, i * 0.04); play(o, env(0.005, 0.45)); break; }
    case 'whoosh': { const n = noise(); const f = oc.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2; f.frequency.setValueAtTime(300, 0); f.frequency.exponentialRampToValueAtTime(3000, 0.35); f.frequency.exponentialRampToValueAtTime(400, 0.7); n.connect(f); const g = env(0.25, 0.4, 0.9); f.connect(g); g.connect(out); n.start(); break; }
    case 'click': { const n = noise(); const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2000; n.connect(f); const g = env(0.001, 0.03); f.connect(g); g.connect(out); n.start(); n.stop(0.1); break; }
    case 'ding': { [880, 1760, 2640].forEach((fr, i) => play(osc('sine', fr), env(0.003, 1.1, 0.6 / (i + 1)))); break; }
    case 'laser': { const o = osc('sawtooth', 1800); o.frequency.exponentialRampToValueAtTime(150, 0.3); play(o, env(0.005, 0.3, 0.5)); break; }
    case 'boom': { const o = osc('sine', 90); o.frequency.exponentialRampToValueAtTime(30, 1.2); play(o, env(0.005, 1.4)); const n = noise(); const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600; n.connect(f); const g = env(0.005, 1.2, 0.9); f.connect(g); g.connect(out); n.start(); break; }
    case 'step': { const n = noise(); const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500; n.connect(f); const g = env(0.003, 0.12); f.connect(g); g.connect(out); n.start(); const o = osc('sine', 70); play(o, env(0.003, 0.1, 0.6)); break; }
    case 'drum': { const o = osc('sine', 160); o.frequency.exponentialRampToValueAtTime(50, 0.2); play(o, env(0.002, 0.35)); break; }
    case 'crash': { const n = noise(); const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3000; n.connect(f); const g = env(0.002, 1.3, 0.7); f.connect(g); g.connect(out); n.start(); break; }
    case 'squeak': { const o = osc('sine', 1400); o.frequency.linearRampToValueAtTime(2200, 0.1); o.frequency.linearRampToValueAtTime(1600, 0.25); play(o, env(0.01, 0.25, 0.5)); break; }
    case 'magic': { for (let i = 0; i < 12; i++) { const o = osc('sine', 1200 + i * 180 + Math.random() * 200); play(o, env(0.005, 0.3, 0.25, i * 0.07), i * 0.07, i * 0.07 + 0.4); } break; }
    case 'slide': { const o = osc('sine', 300); o.frequency.exponentialRampToValueAtTime(1500, 0.9); play(o, env(0.05, 0.9, 0.5)); break; }
    case 'thud': { const o = osc('sine', 60); play(o, env(0.002, 0.25)); const n = noise(); const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 250; n.connect(f); const g = env(0.002, 0.15, 0.8); f.connect(g); g.connect(out); n.start(); break; }
    case 'alarm': { const o = osc('square', 800); for (let i = 0; i < 6; i++) o.frequency.setValueAtTime(i % 2 ? 600 : 900, i * 0.2); play(o, env(0.01, 1.15, 0.25)); break; }
    case 'tada': { [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.36]].forEach(([fr, t]) => { const o = osc('triangle', fr); play(o, env(0.01, t === 0.36 ? 0.9 : 0.25, 0.35, t), t, t + 1.3); }); break; }
  }
  const buf = await oc.startRendering();
  return encodeWav(buf);
}

export function encodeWav(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); ws(8, 'WAVE'); ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, chans[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---------- Playback in sync with the animation ----------
let playing = [];
export async function playTracks(project, fromSec) {
  stopTracks();
  const ac = audioCtx();
  const now = ac.currentTime + 0.05;
  for (const t of project.audio) {
    if (t.muted) continue;
    const buf = await decodeClip(t.blob);
    if (!buf) continue;
    const clipStart = t.start || 0, trimIn = t.trimStart || 0, clipLen = Math.max(0, (t.trimEnd || buf.duration) - trimIn);
    const clipEnd = clipStart + clipLen;
    if (fromSec >= clipEnd) continue;
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = t.volume ?? 1;
    src.connect(g); g.connect(ac.destination);
    if (fromSec >= clipStart) src.start(now, trimIn + (fromSec - clipStart), clipEnd - fromSec);
    else src.start(now + (clipStart - fromSec), trimIn, clipLen);
    playing.push(src);
  }
}
export function stopTracks() { playing.forEach(s => { try { s.stop(); } catch (e) { } }); playing = []; }

// Mix all tracks into one buffer of the movie's length.
export async function mixdown(project, durationSec, sampleRate = 48000) {
  const tracks = project.audio.filter(t => !t.muted);
  if (!tracks.length || durationSec <= 0) return null;
  const oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.ceil(durationSec * sampleRate), sampleRate);
  let any = false;
  for (const t of tracks) {
    const buf = await decodeClip(t.blob);
    if (!buf) continue;
    const trimIn = t.trimStart || 0, clipLen = Math.max(0, (t.trimEnd || buf.duration) - trimIn);
    if ((t.start || 0) >= durationSec) continue;
    const src = oc.createBufferSource(); src.buffer = buf;
    const g = oc.createGain(); g.gain.value = t.volume ?? 1;
    src.connect(g); g.connect(oc.destination);
    src.start(t.start || 0, trimIn, clipLen);
    any = true;
  }
  if (!any) return null;
  return oc.startRendering();
}
