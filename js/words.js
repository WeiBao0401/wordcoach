// Lookup and library rules, mirroring server.py (api_lookup, store_lookup, record_lookup, enrich).
// No DOM access: the store (IndexedDB or an in-memory fake) and the AI client are injected.
import { userMsg, zhUserMsg, LEXICON_KEYS, PRACTICE_KEYS, CORE_KEYS } from './prompts.js';
import * as F from './fsrs.js';
import { planImport, buildExport } from './db.js';

// ---------------------------------------------------------------- pure helpers

const pad = n => String(n).padStart(2, '0');
// Local time without a zone, like Python's datetime.now().isoformat(timespec="seconds"), so
// timestamps from the Mac and the phone compare correctly as strings.
export function localIso(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function localDay(d = new Date()) { return localIso(d).slice(0, 10); }

const chars = s => Array.from(String(s ?? ''));
const cut = (s, n) => chars(s).slice(0, n).join('');

export function slugify(word) {
  let s = String(word ?? '').trim().toLowerCase();
  s = s.replace(/[^\p{L}\p{N}_\s'-]/gu, '');
  s = s.replace(/[\s']+/g, '-').replace(/^-+|-+$/g, '');
  return cut(s, 80) || 'word';
}

export const isChinese = q => /[一-鿿]/.test(String(q ?? ''));
export const normalizeQuery = q => String(q ?? '').trim().replace(/\s+/g, ' ');

// Cheap checks before spending an API call. Returns an error string or null.
export function prefilter(q) {
  if (!q) return '请输入一个单词或短语。';
  if (isChinese(q)) return chars(q).length > 60 ? '中文请控制在 60 个字以内。' : null;
  if (chars(q).length > 60 || q.split(/\s+/).filter(Boolean).length > 6) {
    return '输入太长了：请输入单词或短语（6 个词以内），整句可以放到“原句”框里。';
  }
  if (!/[A-Za-z]/.test(q)) return '没有识别到英文字母。';
  return null;
}

// Real lookups only: skip the Youdao import record and "regenerate" clicks.
export const lookupEvents = e => (e.history || []).filter(h => h && h.source !== 'youdao' && !h.regen);
// Lookups after the word was favorited: a sign it was forgotten.
export function relookups(e) {
  const favAt = e.favorited_at || '';
  return e.favorited && favAt ? lookupEvents(e).filter(h => String(h.at) > favAt) : [];
}
export function lookupStats(e) {
  const ev = lookupEvents(e);
  return { lookups: ev.length, relookups: relookups(e).length, last_lookup: ev.length ? ev[ev.length - 1].at : '' };
}

export function hasExtras(e) {
  if (e.not_standard) return true;
  return !!e.reading && e.collocations != null && !e.needs_core;
}
export const hasLexicon = e => !!e.not_standard || e.collocations != null;
export const hasPractice = e => !!e.not_standard || !!e.reading;

// Append a lookup to the history. A favorited word looked up again comes back into today's review.
export function recordLookup(rec, item, now = new Date()) {
  (rec.history || (rec.history = [])).push(item);
  if (rec.favorited && rec.fsrs && String(item.at) > (rec.favorited_at || '')) {
    if (new Date(rec.fsrs.due) > F.endOfDay(now)) {
      rec.fsrs = { ...rec.fsrs, due: now.toISOString() };
      item.pulled_review = true;
    }
  }
  return rec;
}

export function aliasKeys(e) {
  const out = [];
  for (const h of e.history || []) {
    const q = String((h && h.query) || '').trim().toLowerCase();
    if (q && !/[一-鿿，,]/.test(q)) out.push(q);
  }
  if (e.headword) out.push(String(e.headword).toLowerCase());
  return out;
}

export function lastSeen(e) {
  const h = e.history || [];
  return (h.length && h[h.length - 1].at) || e.created || '';
}

export function summary(e) {
  return {
    slug: e.slug, headword: e.headword, brief_cn: e.brief_cn || '', favorited: !!e.favorited,
    favorited_at: e.favorited_at || '', created: e.created || '', last_seen: lastSeen(e),
    due: (e.fsrs && e.fsrs.due) || '', mastery: F.mastery(e.fsrs), ...lookupStats(e),
  };
}

// zh cache key: same as server.py, sha1("query\nscene")[:16].
export async function zhKey(text) {
  const c = globalThis.crypto;
  if (c && c.subtle) {
    const buf = await c.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const ch of text) { const c2 = ch.codePointAt(0); h1 = Math.imul(h1 ^ c2, 16777619) >>> 0; h2 = Math.imul(h2 + c2, 2246822519) >>> 0; }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

// ---------------------------------------------------------------- paste helpers

const STOP = new Set(('a an the and or but if then than so as at by for from in into of off on onto out over to up with ' +
  'is am are was were be been being do does did done have has had having can could will would shall should may might must ' +
  'i me my mine we us our you your he him his she her it its they them their this that these those there here what which who whom whose ' +
  'when where why how all any both each few more most other some such no nor not only own same too very just also now again ever ' +
  'about after before between during through under while because until against among within without across along around behind ' +
  'get got make made take took go went come came see saw know knew think thought say said tell told give gave use used ' +
  'one two three first new old good bad big small many much lot lots like well way day time year people thing things ' +
  'yes okay ok hi hello please thanks thank let lets don doesn didn isn aren wasn weren won wouldn couldn shouldn ' +
  'im ive id ill youre theyre weve its whats thats theres').split(/\s+/));

export function pasteCandidates(text, limit = 12) {
  const seen = new Set(), out = [];
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z'’-]*[A-Za-z]/g)) {
    const w = m[0].replace(/’/g, "'");
    const lw = w.toLowerCase();
    const bare = lw.replace(/'s$/, '').replace(/'/g, '');
    if (bare.length < 3 || STOP.has(bare) || seen.has(bare)) continue;
    seen.add(bare);
    out.push(lw.replace(/'s$/, ''));
    if (out.length >= limit) break;
  }
  return out;
}

// What a pasted text should do: look it up directly, or use it as the context sentence.
export function classifyPaste(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { type: 'empty' };
  if (isChinese(text)) return chars(text).length <= 60 ? { type: 'word', value: text } : { type: 'toolong' };
  const core = text.replace(/^[\s"'“”‘’(（\[]+|[\s"'“”‘’)）\].,!?;:。，！？]+$/g, '');
  const words = core.split(' ').filter(Boolean);
  if (core && words.length <= 6 && chars(core).length <= 60 && !/[.,!?;:。，！？"“”]/.test(core) && /[A-Za-z]/.test(core)) {
    return { type: 'word', value: core };
  }
  return { type: 'context', value: cut(text, 600), candidates: pasteCandidates(text) };
}

// ---------------------------------------------------------------- service

const errMsg = e => (e && e.message) || String(e);
const REFAV_MS = 10 * 60 * 1000;

// Put fields back after a failed write (undefined = the key was absent).
function restore(rec, prev) {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete rec[k]; else rec[k] = v; }
}
// A favorited word looked up again while it was still a new card (SPEC 2.1 #4): due today, outside the new-card quota.
const pulledNew = e => e.fsrs.state === F.State.New && (e.history || []).some(h => h && h.pulled_review);
// Most recent phone-side interest in a word: favorited, or looked up again after favoriting.
function interest(e) {
  const r = relookups(e);
  const last = r.length ? String(r[r.length - 1].at || '') : '';
  const fav = String(e.favorited_at || '');
  return last > fav ? last : fav;
}

// dict (optional): the offline dictionary (dict.js); its lemma table maps "went" to an existing "go" entry.
export function createWords({ store, ai, dict = null, now = () => new Date(), hash = zhKey }) {
  const entries = new Map();     // slug -> entry (in-memory mirror of the entries store)
  const aliases = new Map();     // query form (lowercase) -> slug
  const pending = new Map();     // slug -> extras job started next to the core call
  const inflight = new Map();    // slug -> enrich promise (one per slug)
  const enrichErrors = new Map();
  const unfavorited = new Map(); // slug -> {favorited_at, t} for recent unfavorites
  const listeners = new Set();
  let zhCount = 0;
  let dailyNew = { date: '', count: 0 };

  const emit = (type, slug) => { for (const fn of listeners) { try { fn({ type, slug }); } catch (e) { console.error(e); } } };
  const remember = e => { for (const k of aliasKeys(e)) aliases.set(k, e.slug); };
  const save = e => store.putEntry(e);
  const log = rec => { Promise.resolve().then(() => store.addLog(rec)).catch(() => {}); };

  // Alias table first (spellings seen before), then the slug, then the dictionary form of an inflected form.
  function findEntry(q) {
    const hit = entries.get(aliases.get(normalizeQuery(q).toLowerCase()) || slugify(q));
    if (hit || !dict) return hit || null;
    const lem = dict.lemma(q);
    return (lem && entries.get(aliases.get(lem.toLowerCase()) || slugify(lem))) || null;
  }

  async function load() {
    const list = await store.loadEntries();
    entries.clear(); aliases.clear();
    for (const e of list) if (e && e.slug) entries.set(e.slug, e);
    for (const e of entries.values()) remember(e);
    zhCount = (await store.countZh()) || 0;
    dailyNew = (await store.getMeta('dailyNew')) || { date: '', count: 0 };
  }

  function startExtras(q, context, fromCn) {
    const ctrl = new AbortController();
    const u = userMsg(q, context, fromCn);
    const wrap = p => p.then(data => ({ data }), error => ({ error }));
    return {
      lexicon: wrap(ai.askJSON('lexicon', u, { signal: ctrl.signal })),
      practice: wrap(ai.askJSON('practice', u, { signal: ctrl.signal })),
      abort: () => ctrl.abort(),
    };
  }

  function storeLookup(core, query, context, fromCn, regen) {
    const slug = slugify(core.headword);
    const at = localIso(now());
    const item = { at, query, context };
    if (fromCn) item.from_cn = fromCn;
    if (regen) item.regen = true;
    // allowlist: an unexpected key from the model must never overwrite favorited, note, fsrs, slug...
    const fields = { headword: core.headword };
    for (const k of CORE_KEYS) if (k in core) fields[k] = core[k];
    let rec = entries.get(slug);
    if (rec) {
      Object.assign(rec, fields);
      if (rec.needs_core) rec.needs_core = false;
    } else {
      rec = { ...fields, created: at, history: [], note: '', favorited: false, slug };
      entries.set(slug, rec);
    }
    rec.slug = slug;
    recordLookup(rec, item, now());
    remember(rec);
    rec.updated = at;
    return rec;
  }

  async function lookup(rawQ, rawContext = '', { force = false, fromCn = '', signal } = {}) {
    const q = normalizeQuery(rawQ);
    const context = cut(String(rawContext ?? '').trim(), 600);
    const from_cn = cut(String(fromCn ?? '').trim(), 60);
    const at = localIso(now());
    const err = prefilter(q);
    if (err) { log({ at, query: q, result: 'rejected-local', reason: err }); return { ok: false, message: err }; }
    if (isChinese(q)) return lookupZh(q, context, force, signal);

    let cached = force ? null : findEntry(q);
    // a lookup right after launch may beat the dictionary; wait a little so "went" still finds "go"
    if (!cached && !force && dict && !dict.loaded() && (await dict.whenReady(800))) cached = findEntry(q);
    if (cached) {
      const item = { at, query: q, context, cached: true };
      if (from_cn) item.from_cn = from_cn;
      recordLookup(cached, item, now());
      remember(cached);
      await save(cached);
      log({ at, query: q, result: 'cached', headword: cached.headword });
      emit('entry', cached.slug);
      return { ok: true, found: true, cached: true, entry: cached, pending: !hasExtras(cached),
        stats: lookupStats(cached), pulled_review: !!item.pulled_review };
    }

    const extras = startExtras(q, context, from_cn);   // runs in parallel with the core call
    let core;
    try {
      core = await ai.askJSON('core', userMsg(q, context, from_cn), { signal });
    } catch (e) { extras.abort(); throw e; }
    const status = core.status || 'ok';
    if (status !== 'ok') {
      extras.abort();
      const suggestions = Array.isArray(core.suggestions) ? core.suggestions.filter(s => typeof s === 'string' && s.trim()) : [];
      log({ at: localIso(now()), query: q, result: status, suggestions });
      return { ok: true, found: false, status: status === 'typo' ? 'typo' : 'invalid', suggestions };
    }
    core.headword = String(core.headword || q).trim() || q;
    const rec = storeLookup(core, q, context, from_cn, force);
    await save(rec);
    pending.set(rec.slug, { ...extras, force });
    log({ at: localIso(now()), query: q, result: 'found', headword: rec.headword });
    emit('entry', rec.slug);
    const last = rec.history[rec.history.length - 1];
    const enrichPromise = enrich(rec.slug);
    enrichPromise.catch(() => {});   // callers may ignore it; errors also land in enrichStatus
    return { ok: true, found: true, entry: rec, pending: true, stats: lookupStats(rec),
      pulled_review: !!last.pulled_review, enrichPromise };
  }

  async function lookupZh(q, context, force, signal) {
    const at = localIso(now());
    const key = await hash(`${q}\n${context}`);
    if (!force) {
      const hit = await store.getZh(key);
      if (hit) { log({ at, query: q, result: 'zh-cached' }); return { ok: true, mode: 'zh', cached: true, result: hit }; }
    }
    const data = await ai.askJSON('zh', zhUserMsg(q, context), { signal });
    const options = Array.isArray(data.options) ? data.options.filter(o => o && typeof o.en === 'string' && o.en.trim()) : [];
    if (data.status === 'invalid' || !options.length) {
      log({ at, query: q, result: 'zh-invalid' });
      return { ok: true, mode: 'zh', found: false, message: `没能理解“${q}”的意思，换个说法试试。` };
    }
    Object.assign(data, { options, query: q, scene: context, at: localIso(now()), key });
    await store.putZh(data);
    zhCount = (await store.countZh()) || zhCount + 1;
    log({ at, query: q, result: 'zh', options: options.map(o => o.en) });
    return { ok: true, mode: 'zh', result: data };
  }

  // Fill in lexicon + practice (and core for imported words). One run per slug at a time.
  function enrich(slug) {
    if (inflight.has(slug)) return inflight.get(slug);
    const p = doEnrich(slug).finally(() => {
      inflight.delete(slug);
      emit('enrich-done', slug);
      // a regenerate that started while this run was busy left its job in `pending`
      if (pending.has(slug)) enrich(slug).catch(() => {});
    });
    inflight.set(slug, p);
    emit('enrich', slug);
    return p;
  }

  async function doEnrich(slug) {
    const rec = entries.get(slug);
    if (!rec) throw new Error('找不到这个词。');
    const job0 = pending.get(slug);
    pending.delete(slug);
    if (hasExtras(rec) && !(job0 && job0.force)) {
      if (job0) job0.abort();
      enrichErrors.delete(slug);
      return { entry: rec, errors: {} };
    }
    const job = job0 || startExtras(rec.headword, '');
    const coreJob = rec.needs_core
      ? ai.askJSON('core', userMsg(rec.headword, '')).then(data => ({ data }), error => ({ error })) : null;
    const errors = {};
    let invalid = 0, gotParts = false;
    const apply = async parts => {
      const cur = entries.get(slug);
      if (!cur) return;
      Object.assign(cur, parts);
      cur.updated = localIso(now());
      await save(cur);
      emit('entry', slug);
    };
    const tasks = [];
    if (coreJob) {
      tasks.push(coreJob.then(async r => {
        if (r.error) { errors.core = errMsg(r.error); return; }
        const parts = {};
        if ((r.data.status || 'ok') === 'ok') {
          for (const k of CORE_KEYS) if (k in r.data) parts[k] = r.data[k];
        }
        parts.needs_core = false;
        await apply(parts);
      }));
    }
    for (const [name, keys] of [['lexicon', LEXICON_KEYS], ['practice', PRACTICE_KEYS]]) {
      tasks.push(job[name].then(async r => {
        if (r.error) { errors[name] = errMsg(r.error); return; }
        if (!r.data || r.data.invalid) { invalid++; return; }
        const parts = {};
        for (const k of keys) parts[k] = r.data[k] ?? null;
        gotParts = true;
        await apply(parts);
      }));
    }
    await Promise.all(tasks);
    const cur = entries.get(slug);
    if (invalid === 2 && !Object.keys(errors).length) await apply({ not_standard: true });
    // false rather than delete, so a newer `updated` carries the removal through an import merge
    else if (gotParts && cur && cur.not_standard) { cur.not_standard = false; await save(cur); emit('entry', slug); }
    if (Object.keys(errors).length) enrichErrors.set(slug, errors); else enrichErrors.delete(slug);
    return { entry: entries.get(slug), errors };
  }

  async function favorite(slug, on = true) {
    const rec = entries.get(slug);
    if (!rec) throw new Error('找不到这个词。');
    const prev = { favorited: rec.favorited, favorited_at: rec.favorited_at, fsrs: rec.fsrs };
    const t = now();
    if (on && !rec.favorited) {
      // re-favorited soon after an unfavorite (a mis-tap): keep the original date
      const u = unfavorited.get(slug);
      rec.favorited = true;
      rec.favorited_at = u && u.favorited_at && t - u.t < REFAV_MS ? u.favorited_at : localIso(t);
      if (!rec.fsrs) rec.fsrs = F.newCard(t);
    } else if (!on && rec.favorited) {
      unfavorited.set(slug, { favorited_at: rec.favorited_at, t: t.getTime() });
      rec.favorited = false;
    }
    try { await save(rec); } catch (e) { restore(rec, prev); throw e; }
    if (on) unfavorited.delete(slug);
    emit('favorite', slug);
    return rec;
  }

  async function setNote(slug, note) {
    const rec = entries.get(slug);
    if (!rec) throw new Error('找不到这个词。');
    rec.note = cut(String(note ?? ''), 4000);
    rec.updated = localIso(now());
    await save(rec);
    emit('note', slug);
    return rec;
  }

  function newDoneToday(t = now()) { return dailyNew.date === localDay(t) ? dailyNew.count : 0; }

  async function review(slug, rating, mode = 'card') {
    const rec = entries.get(slug);
    if (!rec || !rec.favorited) throw new Error('这个词不在词库里。');
    const t = now();
    const prev = { fsrs: rec.fsrs, reviews: rec.reviews ? rec.reviews.slice() : undefined };
    const before = rec.fsrs || F.newCard(t);
    rec.fsrs = F.schedule(before, rating, t);
    (rec.reviews || (rec.reviews = [])).push({ at: localIso(t), rating, mode });
    // a failed write must not leave the rating in memory, or a retry schedules the card twice
    try { await save(rec); } catch (e) { restore(rec, prev); throw e; }
    if (before.state === F.State.New) {
      dailyNew = { date: localDay(t), count: newDoneToday(t) + 1 };
      try { await store.setMeta('dailyNew', dailyNew); } catch (e) { /* the rating itself is saved */ }
    }
    emit('review', slug);
    return rec;
  }

  function reviewQueue(newPerDay, t = now()) {
    const eod = F.endOfDay(t);
    const due = [], fresh = [];
    for (const e of entries.values()) {
      if (!e.favorited || !e.fsrs || new Date(e.fsrs.due) > eod) continue;
      (e.fsrs.state === F.State.New && !pulledNew(e) ? fresh : due).push(e);
    }
    due.sort((a, b) => F.retrievability(a.fsrs, t) - F.retrievability(b.fsrs, t) || new Date(a.fsrs.due) - new Date(b.fsrs.due));
    // newest interest first, so a word favorited today is not stuck behind the imported Youdao backlog
    const key = new Map(fresh.map(e => [e, interest(e)]));
    fresh.sort((a, b) => key.get(b).localeCompare(key.get(a)) || new Date(a.fsrs.due) - new Date(b.fsrs.due));
    const quota = Math.max(0, newPerDay - newDoneToday(t));
    return { due, fresh: fresh.slice(0, quota), freshTotal: fresh.length, quota, newDone: newDoneToday(t) };
  }

  function dueCount(newPerDay, t = now()) {
    const q = reviewQueue(newPerDay, t);
    return q.due.length + q.fresh.length;
  }

  function tomorrowCount(newPerDay, t = now()) {
    const tm = new Date(t); tm.setDate(tm.getDate() + 1);
    const eot = F.endOfDay(tm);
    let rev = 0, fresh = 0;
    for (const e of entries.values()) {
      if (!e.favorited || !e.fsrs || new Date(e.fsrs.due) > eot) continue;
      if (e.fsrs.state === F.State.New && !pulledNew(e)) fresh++; else rev++;
    }
    return rev + Math.min(fresh, newPerDay);
  }

  const favorites = () => [...entries.values()].filter(e => e.favorited);
  const recent = (limit = 40) => [...entries.values()].filter(e => !e.favorited)
    .sort((a, b) => lastSeen(b).localeCompare(lastSeen(a))).slice(0, limit);

  function stats(newPerDay, t = now()) {
    let library = 0, cache = 0, mastered = 0, fresh = 0, learning = 0, reviews = 0, withExtras = 0;
    for (const e of entries.values()) {
      if (e.favorited) {
        library++;
        const m = F.mastery(e.fsrs);
        if (m === 'mastered') mastered++; else if (m === 'new') fresh++; else learning++;
      } else cache++;
      reviews += (e.reviews || []).length;
      if (hasExtras(e) && !e.not_standard) withExtras++;
    }
    return { library, cache, mastered, fresh, learning, reviews, withExtras, zh: zhCount, due: dueCount(newPerDay, t), total: entries.size };
  }

  async function exportData() {
    const zh = await store.getAllZh();
    return buildExport({ entries: [...entries.values()], zh, source: 'phone', now: now() });
  }

  // zh keys are recomputed here so Mac and phone caches line up whatever the file says.
  async function planFor(data) {
    const zhIn = [];
    for (const z of Array.isArray(data.zh) ? data.zh : []) {
      if (!z || typeof z.query !== 'string' || !Array.isArray(z.options)) continue;
      zhIn.push({ ...z, scene: z.scene || '', key: await hash(`${z.query}\n${z.scene || ''}`) });
    }
    const localZh = new Set((await store.getAllZh()).map(z => z.key));
    return planImport(entries, localZh, { ...data, zh: zhIn }, now());
  }

  // Dry run for the confirm step: what an import would add or merge.
  async function previewImport(data) {
    const plan = await planFor(data);
    const incomingFav = data.entries.filter(e => e && e.favorited).length;
    return { ...plan.counts, incomingFav, before: { library: favorites().length, total: entries.size } };
  }

  async function importData(data) {
    const before = { library: favorites().length, total: entries.size };
    const plan = await planFor(data);
    // memory first: an enrich part or note saved during the bulk write then lands on the merged object,
    // and its own write is queued after this one
    for (const e of plan.puts) { entries.set(e.slug, e); remember(e); }
    try {
      if (plan.puts.length) await store.putEntries(plan.puts);
    } catch (err) {
      try { await load(); } catch (e) { /* keep memory as is */ }
      throw err;
    }
    if (plan.zhPuts.length) await store.putZhMany(plan.zhPuts);
    zhCount = (await store.countZh()) || zhCount;
    emit('import', null);
    return { ...plan.counts, before, after: { library: favorites().length, total: entries.size } };
  }

  // Distinct words rated today (flashcards and "先猜再看" both count).
  function reviewedToday(t = now()) {
    const day = localDay(t);
    let n = 0;
    for (const e of entries.values()) if ((e.reviews || []).some(r => String(r.at || '').startsWith(day))) n++;
    return n;
  }

  return {
    load, lookup, enrich, favorite, setNote, review, reviewQueue, dueCount, tomorrowCount, stats,
    exportData, importData, previewImport, reviewedToday, recent, favorites,
    get: slug => entries.get(slug),
    all: () => [...entries.values()],
    size: () => entries.size,
    resolve: q => findEntry(q),
    enrichStatus: slug => ({ running: inflight.has(slug), errors: enrichErrors.get(slug) || null }),
    enriching: () => inflight.size > 0,
    inToday: (slug, newPerDay, t = now()) => { const q = reviewQueue(newPerDay, t); return [...q.due, ...q.fresh].some(e => e.slug === slug); },
    newDoneToday,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
