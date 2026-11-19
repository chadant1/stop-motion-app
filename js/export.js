// Export: MP4 (WebCodecs, faster than real time), WebM/MP4 via MediaRecorder fallback, GIF, image sequence, project backup.
import { renderFrame, aspectSize, deflickerGains, mkCanvas } from './render.js';
import { totalTicks, frameAtTick } from './project.js';
import { mixdown } from './audio.js';
import { GifEncoder, ZipWriter, readZip } from './encoders.js';
import { db, projectBlobKeys, uid } from './db.js';
import { migrate } from './project.js';

export const RESOLUTIONS = { 360: 'Small (360p)', 480: 'SD (480p)', 720: 'HD (720p)', 1080: 'Full HD (1080p)', 1440: 'QHD (1440p)', 2160: '4K (2160p)' };

function sizeFor(p, res) {
  // res is the short side height in landscape terms
  const long = { 360: 640, 480: 854, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }[res] || 1280;
  return aspectSize(p.aspect, long);
}

function* movieTicks(p) {
  const total = totalTicks(p);
  const order = [];
  for (let t = 0; t < total; t++) order.push(t);
  if (p.settings.playback.pingpong) for (let t = total - 2; t > 0; t--) order.push(t);
  for (const t of order) yield t;
}
export function movieTickCount(p) { const t = totalTicks(p); return p.settings.playback.pingpong ? Math.max(t, 2 * t - 2) : t; }

async function frameRenderer(p, w, h, assets) {
  const c = mkCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  const gains = p.settings.deflicker ? deflickerGains(p) : null;
  return {
    canvas: c,
    async draw(tick) {
      const { idx, sub } = frameAtTick(p, tick);
      await renderFrame(x, p, idx, w, h, { sub, assets: await assets(tick), gains });
      return c;
    },
  };
}

export function canUseWebCodecs() { return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'; }

async function pickVideoCodec(w, h, fps, bitrate) {
  const candidates = [
    { codec: 'avc1.640034', mux: 'avc' }, { codec: 'avc1.4d0034', mux: 'avc' }, { codec: 'avc1.42003e', mux: 'avc' }, { codec: 'avc1.42001f', mux: 'avc' },
    { codec: 'hvc1.1.6.L153.B0', mux: 'hevc' }, { codec: 'vp09.00.51.08', mux: 'vp9' }, { codec: 'av01.0.12M.08', mux: 'av1' },
  ];
  for (const c of candidates) {
    try {
      const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps };
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return { ...c, cfg: r.config || cfg };
    } catch (e) { }
  }
  return null;
}

async function pickAudioCodec(sr) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac' }, { codec: 'opus', mux: 'opus' }]) {
    try { const cfg = { codec: c.codec, sampleRate: sr, numberOfChannels: 2, bitrate: 160000 }; const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { ...c, cfg }; } catch (e) { }
  }
  return null;
}

// ---- MP4 via WebCodecs ----
export async function exportMP4(p, { res = 1080, quality = 'high', audio = true, assets, onProgress, signal }) {
  const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.mjs');
  const { w, h } = sizeFor(p, res);
  const fps = p.fps;
  const bitrate = Math.round(w * h * fps * ({ low: 0.08, medium: 0.14, high: 0.22 }[quality] || 0.18));
  const vc = await pickVideoCodec(w, h, fps, bitrate);
  if (!vc) throw new Error('NO_WEBCODECS');
  const nTicks = movieTickCount(p), dur = nTicks / fps;
  let mixed = null, ac = null;
  if (audio && p.audio.length) { mixed = await mixdown(p, dur, 48000); if (mixed) ac = await pickAudioCodec(48000); }
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: vc.mux, width: w, height: h, frameRate: fps },
    audio: ac ? { codec: ac.mux, sampleRate: 48000, numberOfChannels: 2 } : undefined,
  });
  let err = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => err = e });
  venc.configure(vc.cfg);
  const r = await frameRenderer(p, w, h, assets);
  let i = 0;
  for (const tick of movieTicks(p)) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (err) throw err;
    const c = await r.draw(tick);
    const vf = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    while (venc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 5));
    i++;
    onProgress?.(i / nTicks * (ac ? 0.9 : 1));
  }
  await venc.flush();
  if (ac && mixed) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => err = e });
    aenc.configure(ac.cfg);
    const L = mixed.getChannelData(0), R = mixed.getChannelData(1), N = 1024 * 4;
    for (let o = 0; o < mixed.length; o += N) {
      const n = Math.min(N, mixed.length - o);
      const data = new Float32Array(n * 2); data.set(L.subarray(o, o + n), 0); data.set(R.subarray(o, o + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(o / 48000 * 1e6), data });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush();
  }
  if (err) throw err;
  muxer.finalize();
  onProgress?.(1);
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4', audioDropped: !!(mixed && !ac) };
}

// ---- Real-time fallback via MediaRecorder ----
export async function exportRecorder(p, { res = 720, audio = true, assets, onProgress, signal }) {
  const { w, h } = sizeFor(p, res);
  const fps = p.fps;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const r = await frameRenderer(p, w, h, assets);
  const stream = c.captureStream(0);
  const vtrack = stream.getVideoTracks()[0];
  const nTicks = movieTickCount(p), dur = nTicks / fps;
  let actx = null, srcNode = null;
  if (audio && p.audio.length) {
    const mixed = await mixdown(p, dur, 48000);
    if (mixed) {
      actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const dest = actx.createMediaStreamDestination();
      srcNode = actx.createBufferSource(); srcNode.buffer = mixed; srcNode.connect(dest);
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    }
  }
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.round(w * h * fps * 0.2) });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(res => rec.onstop = res);
  // pre-render all frames so playback timing is exact
  const frames = [];
  let k = 0;
  for (const tick of movieTicks(p)) {
    if (signal?.aborted) throw new Error('Cancelled');
    const fc = await r.draw(tick);
    frames.push(await createImageBitmap(fc));
    onProgress?.(++k / nTicks * 0.5);
  }
  rec.start(250);
  if (srcNode) srcNode.start();
  const t0 = performance.now();
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) break;
    x.drawImage(frames[i], 0, 0);
    vtrack.requestFrame ? vtrack.requestFrame() : null;
    onProgress?.(0.5 + (i + 1) / frames.length * 0.5);
    const wait = t0 + (i + 1) * 1000 / fps - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  rec.stop();
  await done;
  if (actx) actx.close();
  frames.forEach(f => f.close && f.close());
  if (signal?.aborted) throw new Error('Cancelled');
  const type = rec.mimeType || mimeType || 'video/webm';
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}

// ---- GIF ----
export async function exportGIF(p, { res = 360, assets, onProgress, signal }) {
  const { w, h } = sizeFor(p, res);
  const r = await frameRenderer(p, w, h, assets);
  const enc = new GifEncoder(w, h, { loop: p.settings.playback.loop ? 0 : null, dither: true });
  const nTicks = movieTickCount(p);
  // merge consecutive identical ticks (holds) into one GIF frame with a longer delay
  const seq = [...movieTicks(p)].map(t => ({ t, ...frameAtTick(p, t) }));
  let i = 0, done = 0;
  while (i < seq.length) {
    if (signal?.aborted) throw new Error('Cancelled');
    let j = i + 1;
    const f = p.frames[seq[i].idx];
    const static_ = f.type !== 'title' || f.title.anim === 'none';
    const fade = p.settings.fade.inSec || p.settings.fade.outSec || p.settings.adjust.grain || p.settings.filter.name === 'oldfilm';
    if (static_ && !fade) while (j < seq.length && seq[j].idx === seq[i].idx) j++;
    const c = await r.draw(seq[i].t);
    const data = c.getContext('2d').getImageData(0, 0, w, h).data;
    enc.addFrame(data, (j - i) * 100 / p.fps);
    done += j - i; i = j;
    onProgress?.(done / nTicks);
    await new Promise(r => setTimeout(r, 0));
  }
  return { blob: enc.finish(), ext: 'gif' };
}

// ---- Image sequence ----
export async function exportSequence(p, { res = 1080, format = 'png', assets, onProgress, signal }) {
  const { w, h } = sizeFor(p, res);
  const r = await frameRenderer(p, w, h, assets);
  const zip = new ZipWriter();
  const total = totalTicks(p);
  for (let t = 0; t < total; t++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const c = await r.draw(t);
    const blob = await toBlob(c, format === 'png' ? 'image/png' : 'image/jpeg', 0.95);
    await zip.add(`frame_${String(t + 1).padStart(5, '0')}.${format === 'png' ? 'png' : 'jpg'}`, blob);
    onProgress?.((t + 1) / total);
  }
  return { blob: zip.finish(), ext: 'zip' };
}

export async function exportStill(p, idx, { res = 2160, assets }) {
  const { w, h } = sizeFor(p, res);
  const c = mkCanvas(w, h);
  await renderFrame(c.getContext('2d'), p, idx, w, h, { assets: await assets(0) });
  return { blob: await toBlob(c, 'image/png'), ext: 'png' };
}

export function toBlob(c, type = 'image/png', q) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
  return new Promise(r => c.toBlob(r, type, q));
}

// ---- Project backup ----
export async function exportProjectZip(p, onProgress) {
  const zip = new ZipWriter();
  await zip.add('project.json', JSON.stringify({ app: 'frameloom', format: 1, project: p }, null, 1));
  const keys = [...projectBlobKeys(p)];
  let i = 0;
  const types = {};
  for (const k of keys) {
    const b = await db.getBlob(k);
    if (b) { await zip.add('blobs/' + k, b); types[k] = b.type; }
    onProgress?.(++i / keys.length);
  }
  await zip.add('types.json', JSON.stringify(types));
  return zip.finish();
}

export async function importProjectZip(file) {
  const files = await readZip(file);
  if (!files['project.json']) throw new Error('This zip is not a Frameloom project backup.');
  const meta = JSON.parse(new TextDecoder().decode(files['project.json']));
  const types = files['types.json'] ? JSON.parse(new TextDecoder().decode(files['types.json'])) : {};
  const p = migrate(meta.project);
  // re-key blobs so importing twice doesn't collide
  const map = {};
  for (const name of Object.keys(files)) {
    if (!name.startsWith('blobs/')) continue;
    const old = name.slice(6);
    map[old] = await db.putBlob(new Blob([files[name]], { type: types[old] || '' }));
  }
  const re = k => (k && map[k]) || k;
  p.id = uid(); p.name = p.name + (p.name.endsWith('(imported)') ? '' : ' (imported)');
  p.frames.forEach(f => { f.img = re(f.img); f.thumb = re(f.thumb); f.paint = re(f.paint); });
  p.audio.forEach(a => a.blob = re(a.blob));
  const s = p.settings; s.chroma.bgBlob = re(s.chroma.bgBlob); s.overlay.blob = re(s.overlay.blob); s.reference.blob = re(s.reference.blob);
  await db.putProject(p);
  return p;
}

export async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return 'downloaded';
}
