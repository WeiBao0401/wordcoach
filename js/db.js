// IndexedDB "wordcoach" v1 + import/export. Nothing here touches indexedDB at import time,
// so the pure helpers (merge, export format, gzip) can be tested in Node.
import { DB_NAME, DB_VERSION, DB_TIMEOUT_MS, LOG_CAP } from './config.js';
import { fromSM2, newCard } from './fsrs.js';
import { CORE_KEYS } from './prompts.js';

export const EXPORT_FORMAT = 'wordcoach-export';

// ---------------------------------------------------------------- IndexedDB with timeouts
// iOS 26 can stall IndexedDB requests forever; every operation gets a timeout, then one retry on a fresh connection.

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'slug' });
      if (!db.objectStoreNames.contains('zh')) db.createObjectStore('zh', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('数据库被另一个窗口占用了')); };
  });
  return dbPromise;
}

function resetDB() {
  const p = dbPromise;
  dbPromise = null;
  if (p) p.then(db => { try { db.close(); } catch (e) { /* ignore */ } }, () => {});
}

export class DBError extends Error {
  constructor(message) { super(message); this.name = 'DBError'; }
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => { onTimeout && onTimeout(); reject(new DBError('timeout')); }, ms); }),
  ]).finally(() => clearTimeout(timer));
}

// fn(stores) queues requests and returns a value or a function to read results after completion.
function runOnce(storeNames, mode, fn, ms) {
  let tx = null;
  const work = openDB().then(db => new Promise((resolve, reject) => {
    tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries([].concat(storeNames).map(n => [n, tx.objectStore(n)]));
    let out;
    try { out = fn(stores); } catch (e) { try { tx.abort(); } catch (_) { /* ignore */ } reject(e); return; }
    tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out);
    tx.onerror = () => reject(tx.error || new Error('transaction error'));
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  }));
  return withTimeout(work, ms, () => { try { tx && tx.abort(); } catch (e) { /* ignore */ } });
}

async function run(storeNames, mode, fn, ms = DB_TIMEOUT_MS) {
  try {
    return await runOnce(storeNames, mode, fn, ms);
  } catch (e) {
    resetDB();
    try {
      return await runOnce(storeNames, mode, fn, ms);
    } catch (e2) {
      resetDB();
      if (e2 instanceof DBError) throw new DBError('本机数据库没有响应（iOS 26 的已知问题）：上滑关掉 App 再打开。');
      throw new DBError('本机数据库出错：' + (e2 && e2.message || e2));
    }
  }
}

const reqResult = req => () => req.result;

export const idbStore = {
  open: () => run('meta', 'readonly', s => reqResult(s.meta.count())),
  loadEntries: () => run('entries', 'readonly', s => reqResult(s.entries.getAll()), DB_TIMEOUT_MS * 3),
  putEntry: e => run('entries', 'readwrite', s => { s.entries.put(e); }),
  putEntries: list => run('entries', 'readwrite', s => { for (const e of list) s.entries.put(e); }, DB_TIMEOUT_MS * 4),
  getZh: key => run('zh', 'readonly', s => reqResult(s.zh.get(key))),
  putZh: z => run('zh', 'readwrite', s => { s.zh.put(z); }),
  putZhMany: list => run('zh', 'readwrite', s => { for (const z of list) s.zh.put(z); }),
  getAllZh: () => run('zh', 'readonly', s => reqResult(s.zh.getAll())),
  countZh: () => run('zh', 'readonly', s => reqResult(s.zh.count())),
  getMeta: key => run('meta', 'readonly', s => reqResult(s.meta.get(key))),
  setMeta: (key, value) => run('meta', 'readwrite', s => { s.meta.put(value, key); }),
  countLog: () => run('log', 'readonly', s => reqResult(s.log.count())),
  async addLog(rec) {
    const n = await run('log', 'readwrite', s => { s.log.add(rec); return reqResult(s.log.count()); });
    if (n > LOG_CAP) {
      const extra = n - LOG_CAP;
      await run('log', 'readwrite', s => {
        const r = s.log.getAllKeys(null, extra);
        r.onsuccess = () => { for (const k of r.result) s.log.delete(k); };
      });
    }
  },
};

// ---------------------------------------------------------------- import / export (pure)

const byAt = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));

function unionBy(a, b, keyFn) {
  const seen = new Map();
  for (const x of [...(a || []), ...(b || [])]) {
    if (!x || typeof x !== 'object') continue;
    const k = keyFn(x);
    if (!seen.has(k)) seen.set(k, x);
  }
  return [...seen.values()].sort(byAt);
}
const histKey = h => `${h.at}|${h.query || ''}`;
const reviewKey = r => `${r.at}|${r.mode || ''}`;

// Fill fsrs for an entry that has none: from the Mac srs, or a fresh card if it is favorited.
export function ensureFsrs(e, now = new Date()) {
  if (e.fsrs) return e;
  const conv = fromSM2(e.srs);
  if (conv) e.fsrs = conv;
  else if (e.favorited) e.fsrs = newCard(now);
  return e;
}

const arr = x => (Array.isArray(x) ? x : []);

// Two notes -> one, losing nothing: keep the one that contains the other; else both, newer first.
export function mergeNotes(newerNote, olderNote) {
  const a = String(newerNote || ''), b = String(olderNote || '');
  if (!a || b.includes(a)) return b || a;
  if (!b || a.includes(b)) return a;
  return a + '\n' + b;
}

// Merge one incoming entry into the local one (same slug). Never deletes anything.
export function mergeEntry(local, incoming, now = new Date()) {
  if (!local) {
    const e = structuredCloneSafe(incoming);
    for (const k of ['history', 'reviews']) if (e[k] != null) e[k] = arr(e[k]).filter(x => x && typeof x === 'object');
    return ensureFsrs(e, now);
  }
  const incNewer = String(incoming.updated || '') > String(local.updated || '');
  const [older, newer] = incNewer ? [local, incoming] : [incoming, local];
  const out = { ...older };
  for (const [k, v] of Object.entries(newer)) if (v !== null && v !== undefined) out[k] = v;
  // a Youdao placeholder with a newer `updated` (e.g. a Mac note edit) must not wipe an AI core the other side has
  if (newer.needs_core && !older.needs_core && Array.isArray(older.senses) && older.senses.length) {
    for (const k of CORE_KEYS) if (older[k] != null) out[k] = older[k];
    out.needs_core = false;
  }
  out.slug = local.slug;
  const created = [local.created, incoming.created].filter(Boolean).map(String).sort();
  if (created.length) out.created = created[0];
  out.history = unionBy(arr(local.history), arr(incoming.history), histKey);
  out.reviews = unionBy(arr(local.reviews), arr(incoming.reviews), reviewKey);
  if (!out.reviews.length && !local.reviews && !incoming.reviews) delete out.reviews;
  const fav = !!(local.favorited || incoming.favorited);
  out.favorited = fav;
  const favAts = [local.favorited_at, incoming.favorited_at].filter(Boolean).sort();
  if (favAts.length) out.favorited_at = favAts[0];
  out.fsrs = local.fsrs || incoming.fsrs || null;
  if (!out.fsrs) delete out.fsrs;
  out.srs = local.srs || incoming.srs;
  if (!out.srs) delete out.srs;
  // an empty note on the newer side must not wipe the other side's note (SPEC 4.3)
  if ('note' in local || 'note' in incoming) out.note = mergeNotes(newer.note, older.note);
  return ensureFsrs(out, now);
}

export function stableJSON(x) {
  if (Array.isArray(x)) return '[' + x.map(stableJSON).join(',') + ']';
  if (x && typeof x === 'object') {
    return '{' + Object.keys(x).filter(k => x[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stableJSON(x[k])).join(',') + '}';
  }
  return JSON.stringify(x === undefined ? null : x);
}

function structuredCloneSafe(x) {
  return typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x));
}

export function validateExport(data) {
  if (!data || typeof data !== 'object') throw new Error('文件内容不是 Word Coach 导出格式。');
  if (data.format !== EXPORT_FORMAT) throw new Error('这不是 Word Coach 的导出文件（缺少 format: wordcoach-export）。');
  if (!Array.isArray(data.entries)) throw new Error('导出文件里没有词条列表。');
  if (data.version > 1) throw new Error(`导出文件版本 ${data.version} 太新了，先更新 App。`);
  return data;
}

// Plan an import against the local data. Returns the entries/zh to write and counts.
export function planImport(localEntries, localZhKeys, data, now = new Date()) {
  validateExport(data);
  const puts = [];
  let added = 0, merged = 0, unchanged = 0, skipped = 0;
  for (const inc of data.entries) {
    if (!inc || typeof inc !== 'object' || !inc.slug || typeof inc.slug !== 'string' || !inc.headword) { skipped++; continue; }
    const local = localEntries.get(inc.slug);
    let next;
    // one malformed record is skipped, it does not block the whole restore
    try { next = mergeEntry(local, inc, now); } catch (e) { skipped++; continue; }
    if (!local) { added++; puts.push(next); continue; }
    if (stableJSON(next) === stableJSON(local)) unchanged++;
    else { merged++; puts.push(next); }
  }
  const zhPuts = [];
  for (const z of Array.isArray(data.zh) ? data.zh : []) {
    if (!z || !z.query || !Array.isArray(z.options)) continue;
    if (z.key && !localZhKeys.has(z.key)) zhPuts.push(z);
  }
  return { puts, zhPuts, counts: { added, merged, unchanged, skipped, zhAdded: zhPuts.length, total: data.entries.length } };
}

export function buildExport({ entries, zh, source = 'phone', now = new Date() }) {
  return { format: EXPORT_FORMAT, version: 1, source, exported_at: now.toISOString(), entries, zh };
}

export async function gzipJSON(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Accepts .json or .json.gz bytes (detected by the gzip magic number, not the file name).
export async function parseExportBytes(buf) {
  let bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('这台设备不支持解压 .gz，请用 .json 文件。');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  let text = new TextDecoder().decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('文件不是有效的 JSON。'); }
  return validateExport(data);
}
