// Offline base dictionary (SPEC 2.1 #5, #12): data/dict.txt + data/lemma.txt, trimmed from ECDICT (MIT).
// No DOM access, so Node can test it with the real files. The files are fetched once, after the first paint,
// and parsed in small time slices so typing never stalls. Lines stay inside the big text; a word's fields
// are only split out when it is looked up.

export const TAG_CN = { zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE' };
const TAG_ORDER = Object.keys(TAG_CN);
export const FILES = ['dict.txt', 'lemma.txt'];

// Query form -> key: lowercase, straight apostrophe, single spaces.
export const norm = s => String(s ?? '').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');

// "c5,ox,zk,gk,ielts,r35" -> {collins: 5, oxford: true, tags: ['zk', 'gk', 'ielts'], rank: 35}
export function parseFlags(s) {
  const out = { collins: 0, oxford: false, tags: [], rank: 0 };
  for (const t of String(s ?? '').split(',')) {
    const f = t.trim();
    if (/^c[1-5]$/.test(f)) out.collins = +f[1];
    else if (f === 'ox') out.oxford = true;
    else if (/^r\d+$/.test(f)) out.rank = +f.slice(1);
    else if (f in TAG_CN && !out.tags.includes(f)) out.tags.push(f);
  }
  out.tags.sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b));
  return out;
}

// ECDICT phonetics come as "mә'tikjulәs", sometimes with stray [ ] or / around them.
export const cleanPhonetic = s => String(s ?? '').trim().replace(/^[\s[/]+|[\s\]/]+$/g, '');
export const cleanMeaning = s => String(s ?? '').replace(/\\[rnt]/g, '').replace(/\s+/g, ' ').replace(/^[；;，,\s]+|[；;，,\s]+$/g, '');

const RANK_RE = /(?:^|,)r(\d+)(?:,|$)/;

// Splits text into lines, calling onLine(start, end) for each; yields after ~budgetMs of work.
function* scan(text, onLine, budgetMs, clock) {
  const len = text.length;
  let pos = 0, n = 0, t0 = clock();
  while (pos < len) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = len;
    let e = end;
    if (e > pos && text.charCodeAt(e - 1) === 13) e--;          // \r\n
    if (e > pos && text.charCodeAt(pos) !== 35) onLine(pos, e); // skip "#" header lines
    pos = end + 1;
    if (++n % 256 === 0 && clock() - t0 > budgetMs) { yield; t0 = clock(); }
  }
}

function dictLines(text) {
  const keys = [], starts = [], ends = [], ranks = [];
  const map = new Map();
  let sorted = true, prev = '';
  const onLine = (s, e) => {
    const t1 = text.indexOf('\t', s);
    if (t1 < 0 || t1 >= e) return;
    const key = text.slice(s, t1).toLowerCase();
    if (!key || map.has(key)) return;
    const tf = text.lastIndexOf('\t', e - 1);
    const m = tf > t1 ? RANK_RE.exec(text.slice(tf + 1, e)) : null;
    if (key < prev) sorted = false;
    prev = key;
    map.set(key, keys.length);
    keys.push(key); starts.push(s); ends.push(e); ranks.push(m ? +m[1] : 0);
  };
  const pack = (k, s, e, r, m) => ({ text, keys: k, starts: Uint32Array.from(s), ends: Uint32Array.from(e), ranks: Uint32Array.from(r), map: m });
  const finish = () => {
    if (sorted) return pack(keys, starts, ends, ranks, map);
    // the builder writes the file sorted; this only guards a hand-edited one
    const order = keys.map((_, i) => i).sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
    const re = arr => order.map(i => arr[i]);
    const k2 = re(keys);
    return pack(k2, re(starts), re(ends), re(ranks), new Map(k2.map((k, i) => [k, i])));
  };
  return { onLine, finish };
}

function lemmaLines(text) {
  const map = new Map();
  const onLine = (s, e) => {
    const t = text.indexOf('\t', s);
    if (t < 0 || t >= e) return;
    const form = text.slice(s, t).toLowerCase(), lemma = text.slice(t + 1, e).trim();
    if (form && lemma && !map.has(form)) map.set(form, lemma);
  };
  return { onLine, finish: () => map };
}

const nowMs = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

// Synchronous parse, for tests and small samples.
export function buildIndex(dictText, lemmaText = '') {
  const d = dictLines(String(dictText));
  for (const _ of scan(String(dictText), d.onLine, Infinity, nowMs)) { /* no yields */ }
  const l = lemmaLines(String(lemmaText));
  for (const _ of scan(String(lemmaText), l.onLine, Infinity, nowMs)) { /* no yields */ }
  return { ...d.finish(), lemmas: l.finish() };
}

async function buildIndexAsync(dictText, lemmaText, { budgetMs, pause, clock }) {
  const d = dictLines(dictText);
  for (const _ of scan(dictText, d.onLine, budgetMs, clock)) await pause();
  const l = lemmaLines(lemmaText);
  for (const _ of scan(lemmaText, l.onLine, budgetMs, clock)) await pause();
  return { ...d.finish(), lemmas: l.finish() };
}

// Lookup functions over an index (shared by createDict and tests on samples).
export function queries(ix) {
  function info(i) {
    const [word, ph, cn, flags] = ix.text.slice(ix.starts[i], ix.ends[i]).split('\t');
    return { word, phonetic: cleanPhonetic(ph), cn: cleanMeaning(cn), ...parseFlags(flags) };
  }
  const get = w => { const i = ix.map.get(norm(w)); return i === undefined ? null : info(i); };
  // The dictionary form of an inflected form listed in lemma.txt ("went" -> "go"), else null.
  const lemma = form => { const l = ix.lemmas.get(norm(form)); return l && norm(l) !== norm(form) ? l : null; };
  // The word itself, else its dictionary form (marked with `via`: what was typed).
  function find(q) {
    const hit = get(q);
    if (hit) return hit;
    const l = lemma(q);
    const base = l ? get(l) : null;
    return base ? { ...base, via: String(q).trim() } : null;
  }
  // Up to n words starting with prefix: exact match first, then the dictionary form of an inflected
  // prefix ("went" -> go), then by frequency rank (unranked last), shorter first. "Exact" means the same
  // letters in the same case, so "co" does not put the abbreviation "Co" (钴) above "could".
  function suggest(prefix, n = 8) {
    const p = norm(prefix);
    if (!p || n <= 0) return [];
    const { keys, ranks } = ix;
    let lo = 0, hi = keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid] < p) lo = mid + 1; else hi = mid; }
    const rk = i => ranks[i] || Infinity;
    const ex = i => keys[i] === p && ix.text.startsWith(p, ix.starts[i]);
    // < 0 when word a ranks before word b
    const better = (a, b) => ((ex(a) ? 0 : 1) - (ex(b) ? 0 : 1)) || (rk(a) - rk(b)) ||
      (keys[a].length - keys[b].length) || (keys[a] < keys[b] ? -1 : 1);
    const top = [];
    for (let i = lo; i < keys.length && keys[i].startsWith(p); i++) {
      if (top.length === n && better(i, top[n - 1]) >= 0) continue;
      let j = top.length;
      while (j > 0 && better(i, top[j - 1]) < 0) j--;
      top.splice(j, 0, i);
      if (top.length > n) top.pop();
    }
    const brief = (i, via) => { const d = info(i); return { word: d.word, cn: d.cn, rank: d.rank, ...(via ? { via } : {}) }; };
    const out = top.map(i => brief(i));
    const l = lemma(p);
    const li = l ? ix.map.get(norm(l)) : undefined;
    if (li !== undefined && !top.includes(li)) out.splice(top[0] !== undefined && ex(top[0]) ? 1 : 0, 0, brief(li, String(prefix).trim()));
    return out.slice(0, n);
  }
  return { get, lemma, find, suggest, size: () => ix.keys.length, forms: () => ix.lemmas.size };
}

// fetchText(name) -> Promise<string> for 'dict.txt' and 'lemma.txt'.
export function createDict({ fetchText, budgetMs = 8, pause = () => new Promise(r => setTimeout(r, 0)), clock = nowMs } = {}) {
  let state = 'idle';        // idle | loading | ready | error
  let q = null, error = '', loading = null;
  const stats = { words: 0, forms: 0, chars: 0, fetchMs: 0, parseMs: 0 };
  let markReady;
  const ready = new Promise(r => { markReady = r; });   // resolves once loaded; never rejects

  function load() {
    if (state === 'ready') return Promise.resolve(stats);
    if (loading) return loading;
    state = 'loading'; error = '';
    loading = (async () => {
      const t0 = clock();
      const [dt, lt] = await Promise.all(FILES.map(f => fetchText(f)));
      const t1 = clock();
      const ix = await buildIndexAsync(String(dt), String(lt), { budgetMs, pause, clock });
      if (!ix.keys.length) throw new Error('词典文件是空的');
      q = queries(ix);
      Object.assign(stats, { words: ix.keys.length, forms: ix.lemmas.size, chars: dt.length + lt.length,
        fetchMs: Math.round(t1 - t0), parseMs: Math.round(clock() - t1) });
      state = 'ready';
      markReady(stats);
      return stats;
    })().catch(e => {
      state = 'error'; error = (e && e.message) || String(e); loading = null;   // a later load() tries again
      throw e;
    });
    return loading;
  }

  return {
    load,
    ready,
    loaded: () => state === 'ready',
    // A lookup that needs the dictionary: starts the load if nothing started it yet, then waits up to ms.
    // true once loaded; false on timeout, or at once after a failed load.
    whenReady(ms) {
      if (state === 'ready') return Promise.resolve(true);
      if (state === 'idle') load().catch(() => {});
      if (state !== 'loading') return Promise.resolve(false);
      return new Promise(res => { const t = setTimeout(() => res(false), ms); ready.then(() => { clearTimeout(t); res(true); }); });
    },
    status: () => ({ state, error, ...stats }),
    get: w => (q ? q.get(w) : null),
    lemma: f => (q ? q.lemma(f) : null),
    find: w => (q ? q.find(w) : null),
    suggest: (p, n = 8) => (q ? q.suggest(p, n) : []),
    size: () => (q ? q.size() : 0),
  };
}
