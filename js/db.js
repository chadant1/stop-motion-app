// IndexedDB storage: projects (JSON) + blobs (images, audio, video).
const DB_NAME = 'frameloom';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  listProjects: () => tx('projects', 'readonly', s => s.getAll()).then(a => (a || []).sort((x, y) => y.updated - x.updated)),
  getProject: id => tx('projects', 'readonly', s => s.get(id)),
  putProject: p => { p.updated = Date.now(); return tx('projects', 'readwrite', s => s.put(JSON.parse(JSON.stringify(p)))); },
  deleteProject: id => tx('projects', 'readwrite', s => s.delete(id)),
  getBlob: key => key ? tx('blobs', 'readonly', s => s.get(key)) : Promise.resolve(null),
  putBlob: async (blob, key = uid()) => { await tx('blobs', 'readwrite', s => s.put(blob, key)); return key; },
  deleteBlob: key => tx('blobs', 'readwrite', s => s.delete(key)),
  blobKeys: () => tx('blobs', 'readonly', s => s.getAllKeys()),
  getKV: key => tx('kv', 'readonly', s => s.get(key)),
  setKV: (key, v) => tx('kv', 'readwrite', s => s.put(v, key)),
};

// All blob keys a project refers to.
export function projectBlobKeys(p) {
  const keys = new Set();
  for (const f of p.frames) { for (const k of ['img', 'thumb', 'paint']) if (f[k]) keys.add(f[k]); }
  const s = p.settings;
  for (const k of [s.chroma.bgBlob, s.overlay.blob, s.reference.blob]) if (k) keys.add(k);
  for (const a of p.audio) if (a.blob) keys.add(a.blob);
  return keys;
}

// Delete blobs not referenced by any project (run when leaving a project).
export async function collectGarbage() {
  try {
    const projects = await db.listProjects();
    const used = new Set();
    projects.forEach(p => projectBlobKeys(p).forEach(k => used.add(k)));
    const all = await db.blobKeys();
    for (const k of all) if (!used.has(k)) await db.deleteBlob(k);
  } catch (e) { console.warn('gc', e); }
}

// Simple in-memory cache of decoded images keyed by blob key.
const imgCache = new Map();
const urlCache = new Map();
export async function blobURL(key) {
  if (!key) return null;
  if (urlCache.has(key)) return urlCache.get(key);
  const b = await db.getBlob(key);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(key, u);
  return u;
}
export async function loadImage(key) {
  if (!key) return null;
  if (imgCache.has(key)) return imgCache.get(key);
  const p = (async () => {
    const b = await db.getBlob(key);
    if (!b) return null;
    if (self.createImageBitmap) { try { return await createImageBitmap(b); } catch (e) { /* fall through */ } }
    const url = await blobURL(key);
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  })();
  imgCache.set(key, p);
  if (imgCache.size > 400) { const first = imgCache.keys().next().value; imgCache.delete(first); }
  return p;
}
export function forgetImage(key) { imgCache.delete(key); const u = urlCache.get(key); if (u) { URL.revokeObjectURL(u); urlCache.delete(key); } }
