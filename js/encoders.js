// Small self-contained encoders: animated GIF and ZIP (store, no compression).

// ---------- GIF ----------
// Builds a 256-colour palette per frame (popularity of 5-bit colour cells), optional ordered dithering, LZW compression.
export class GifEncoder {
  constructor(w, h, { loop = 0, dither = true } = {}) {
    this.w = w; this.h = h; this.loop = loop; this.dither = dither;
    this.out = []; this.len = 0;
    this.writeStr('GIF89a'); this.writeU16(w); this.writeU16(h);
    this.bytes([0x00, 0, 0]); // no global colour table
    if (loop !== null) { this.bytes([0x21, 0xFF, 0x0B]); this.writeStr('NETSCAPE2.0'); this.bytes([0x03, 0x01]); this.writeU16(loop); this.bytes([0]); }
  }
  bytes(a) { this.out.push(Uint8Array.from(a)); }
  writeStr(s) { this.bytes([...s].map(c => c.charCodeAt(0))); }
  writeU16(v) { this.bytes([v & 255, (v >> 8) & 255]); }

  addFrame(rgba, delayCs) {
    const { palette, indices } = quantize(rgba, this.w, this.h, this.dither);
    this.bytes([0x21, 0xF9, 0x04, 0x00]); this.writeU16(Math.max(2, Math.round(delayCs))); this.bytes([0, 0]);
    this.bytes([0x2C]); this.writeU16(0); this.writeU16(0); this.writeU16(this.w); this.writeU16(this.h);
    this.bytes([0x87]); // local colour table, 256 entries
    this.out.push(palette);
    this.bytes([8]);
    const lzw = lzwEncode(indices, 8);
    for (let i = 0; i < lzw.length; i += 255) { const n = Math.min(255, lzw.length - i); const blk = new Uint8Array(n + 1); blk[0] = n; blk.set(lzw.subarray(i, i + n), 1); this.out.push(blk); }
    this.bytes([0]);
  }
  finish() { this.bytes([0x3B]); return new Blob(this.out, { type: 'image/gif' }); }
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v / 16 - 0.5) * 24);

function quantize(rgba, w, h, dither) {
  const counts = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += 16) counts[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)]++;
  // pick the most popular cells, with a spread pass so we don't waste entries on near-duplicates
  const cells = [];
  for (let c = 0; c < 32768; c++) if (counts[c]) cells.push(c);
  cells.sort((a, b) => counts[b] - counts[a]);
  const pal = [];
  const near = (c, d) => { const r = (c >> 10) - (d >> 10), g = ((c >> 5) & 31) - ((d >> 5) & 31), b = (c & 31) - (d & 31); return r * r + g * g + b * b; };
  for (const minD of [6, 2, 0]) {
    for (const c of cells) { if (pal.length >= 256) break; if (pal.includes(c)) continue; if (minD && pal.some(p => near(p, c) < minD)) continue; pal.push(c); }
    if (pal.length >= 256) break;
  }
  while (pal.length < 256) pal.push(0);
  const palette = new Uint8Array(768);
  const pr = new Int16Array(256), pg = new Int16Array(256), pb = new Int16Array(256);
  pal.forEach((c, i) => { pr[i] = ((c >> 10) << 3) + 4; pg[i] = (((c >> 5) & 31) << 3) + 4; pb[i] = ((c & 31) << 3) + 4; palette[i * 3] = pr[i]; palette[i * 3 + 1] = pg[i]; palette[i * 3 + 2] = pb[i]; });
  const lookup = new Int16Array(32768).fill(-1);
  const indices = new Uint8Array(w * h);
  for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
    const i = p * 4;
    const dv = dither ? BAYER[(y & 3) * 4 + (x & 3)] : 0;
    const r = Math.max(0, Math.min(255, rgba[i] + dv)), g = Math.max(0, Math.min(255, rgba[i + 1] + dv)), b = Math.max(0, Math.min(255, rgba[i + 2] + dv));
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = lookup[key];
    if (idx < 0) {
      let best = 1e9; idx = 0;
      for (let k = 0; k < 256; k++) { const dr = pr[k] - r, dg = pg[k] - g, db = pb[k] - b; const d = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (d < best) { best = d; idx = k; } }
      lookup[key] = idx;
    }
    indices[p] = idx;
  }
  return { palette, indices };
}

function lzwEncode(pixels, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  const out = []; let cur = 0, bits = 0;
  let codeSize = minCode + 1, next = eoi + 1;
  const emit = c => { cur |= c << bits; bits += codeSize; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  let dict = new Map();
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = prefix * 256 + k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << codeSize) && codeSize < 12) codeSize++; }
    else { emit(clear); dict = new Map(); codeSize = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

// ---------- ZIP (stored) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }
  async add(name, data) {
    const u8 = data instanceof Uint8Array ? data : typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer());
    const nameB = new TextEncoder().encode(name), crc = crc32(u8);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, u8.length, true); h.setUint32(22, u8.length, true);
    h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
    this.parts.push(new Uint8Array(h.buffer), nameB, u8);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, u8.length, true); c.setUint32(24, u8.length, true);
    c.setUint16(28, nameB.length, true); c.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(c.buffer), nameB);
    this.offset += 30 + nameB.length + u8.length;
    this.count = (this.count || 0) + 1;
  }
  finish() {
    const cdSize = this.central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.count || 0, true); e.setUint16(10, this.count || 0, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }
}

export async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer()), v = new DataView(buf.buffer);
  let e = buf.length - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file');
  const n = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true);
  const files = {};
  for (let i = 0; i < n; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    const lnl = v.getUint16(off + 26, true), lxl = v.getUint16(off + 28, true);
    const start = off + 30 + lnl + lxl;
    let data = buf.slice(start, start + size);
    if (method === 8) {
      if (!self.DecompressionStream) throw new Error('This zip is compressed; re-export it from Frameloom.');
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    }
    files[name] = data;
    p += 46 + nl + xl + cl;
  }
  return files;
}
