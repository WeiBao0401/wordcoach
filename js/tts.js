// Qwen TTS (SPEC 5.1): the cloud voice that also sounds with the ringer on silent.
// Nothing here touches the DOM at import time, so the pure parts run in Node (tests/run.mjs).
//
// - synthesis: POST qwen3-tts-flash on DashScope (same key and host as the chat calls), which answers with a
//   24-hour link to a WAV file on an OSS result bucket, often as http://. The link is rewritten to https and
//   fetched as a Blob (the buckets send Access-Control-Allow-Origin: *).
// - cache: every clip is kept in IndexedDB (store "audio", key = model | voice | text), at most 2000 clips /
//   150 MB, least recently played first out. Hearing a word again costs nothing and needs no network.
// - player: ONE shared <audio> element. iOS only lets a media element start inside a tap; once it has started
//   there, later play() calls on the same element are allowed. So the tap plays a tiny silent clip on it at once
//   (unlock), and the clip that arrives after the await reuses that element. <audio> plays on silent; Web Speech
//   does not.
// - controller: chooses Qwen or the system voice, shows loading / playing on the button, a second tap stops,
//   and on any Qwen failure falls back to the system voice with a short toast (the same reason at most once a
//   minute). A failure that a retry will not fix (bad key, model not enabled, billing, unknown result host) pauses
//   Qwen for 10 minutes: taps go straight to the system voice, inside the tap, with no request.
import { TTS_URL, TTS_MODEL, TTS_RESULT_HOSTS, TTS_CHUNK, TTS_TEXT_CAP, TTS_TIMEOUT_MS, TTS_CACHE } from './config.js';
import { setPlaybackSession } from './speech.js';

export class TTSError extends Error {
  constructor(message, code = 'http') { super(message); this.name = 'TTSError'; this.code = code; }
}

// Settings default (SPEC 2.4): Qwen when a key is set, else the system voice; an explicit choice wins.
export function voiceMode(s) {
  if (s && (s.voiceMode === 'qwen' || s.voiceMode === 'system')) return s.voiceMode;
  return s && s.apiKey ? 'qwen' : 'system';
}

const CJK = /[㐀-鿿豈-﫿]/;
export const ttsLanguage = text => (CJK.test(String(text)) ? 'Auto' : 'English');
// Billing length: a Chinese character counts 2, everything else 1.
export const ttsLength = text => { let n = 0; for (const ch of String(text)) n += CJK.test(ch) ? 2 : 1; return n; };

// Text -> request-sized pieces, split at sentence ends (then commas, then spaces), at most `limit` each.
export function splitForTTS(text, limit = TTS_CHUNK, cap = TTS_TEXT_CAP) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (ttsLength(t) > cap) {
    let cut = '';
    for (const ch of t) { if (ttsLength(cut + ch) > cap) break; cut += ch; }
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = (end > cap / 2 ? cut.slice(0, end + 1) : cut).trim();
  }
  if (ttsLength(t) <= limit) return [t];
  const pieces = [];
  const hardSplit = s => {
    // a sentence over the limit: commas first, then spaces, then raw characters
    for (const sep of [/(?<=[,;:，；：])\s*/, /\s+/]) {
      const parts = s.split(sep).filter(Boolean);
      if (parts.length > 1 && parts.every(p => ttsLength(p) <= limit)) return parts;
    }
    const out = [];
    let cur = '';
    for (const ch of s) { if (ttsLength(cur + ch) > limit) { out.push(cur); cur = ''; } cur += ch; }
    if (cur) out.push(cur);
    return out;
  };
  const sentences = t.split(/(?<=[.!?。！？])\s+/).flatMap(s => (ttsLength(s) > limit ? hardSplit(s) : [s]));
  let cur = '';
  for (const s of sentences) {
    const next = cur ? cur + ' ' + s : s;
    if (ttsLength(next) <= limit) cur = next;
    else { if (cur) pieces.push(cur); cur = s; }
  }
  if (cur) pieces.push(cur);
  return pieces.map(p => p.trim()).filter(Boolean);
}

// The API often returns http:// links; the page is https, so they are rewritten. Only the known result buckets
// pass (they are the ones index.html's CSP allows).
export function httpsAudioUrl(url, hosts = TTS_RESULT_HOSTS) {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw new TTSError('音频地址不对：' + url, 'host'); }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) throw new TTSError('音频在没见过的地址：' + u.hostname, 'host');
  return u.href;
}

// 16-bit mono PCM WAV. freq 0 = silence. Used for the mock clip and the unlock clip.
export function makeWav({ seconds = 0.3, freq = 660, rate = 24000, volume = 0.25 } = {}) {
  const n = Math.max(1, Math.round(seconds * rate));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  const fade = Math.min(n / 4, rate * 0.02);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    const s = freq ? Math.sin(2 * Math.PI * freq * i / rate) * volume * env : 0;
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

// Base64 audio from the response (when there is no link): a WAV file as is, raw PCM (24 kHz mono 16-bit) wrapped.
export function wavFromBase64(b64) {
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bin.slice(0, 4) === 'RIFF') return bytes;
  const head = makeWav({ seconds: 0, freq: 0 }).slice(0, 44);
  const v = new DataView(head.buffer);
  v.setUint32(4, 36 + bytes.length, true);
  v.setUint32(40, bytes.length, true);
  const out = new Uint8Array(44 + bytes.length);
  out.set(head, 0); out.set(bytes, 44);
  return out;
}

// Least recently played out first until both caps hold. list: [[key, used, size], ...]
export function planTrim(list, { clips = TTS_CACHE.clips, bytes = TTS_CACHE.bytes } = {}) {
  const sorted = [...list].sort((a, b) => a[1] - b[1]);
  let count = sorted.length, total = sorted.reduce((s, x) => s + (x[2] || 0), 0);
  const out = [];
  for (const [key, , size] of sorted) {
    if (count <= clips && total <= bytes) break;
    out.push(key);
    count--; total -= size || 0;
  }
  return out;
}

function httpError(status, data) {
  const code = String((data && (data.code || (data.error && data.error.code))) || '');
  const msg = String((data && (data.message || (data.error && data.error.message))) || '').slice(0, 160);
  const blob = (code + ' ' + msg).toLowerCase();
  if (status === 401 || blob.includes('invalidapikey') || blob.includes('invalid_api_key')) return new TTSError('百炼 Key 不对', 'badkey');
  if (blob.includes('arrearage') || blob.includes('overdue')) return new TTSError('百炼欠费或预算用完', 'billing');
  if (status === 429 || blob.includes('throttl') || blob.includes('ratelimit')) return new TTSError('百炼限流了', 'ratelimit');
  if (blob.includes('datainspection') || blob.includes('data_inspection')) return new TTSError('内容没通过安全检查', 'inspection');
  if (status === 403 || blob.includes('accessdenied') || blob.includes('model_not_found') || blob.includes('modelnotfound')) {
    return new TTSError(`这个 Key 用不了 ${TTS_MODEL}`, 'model');
  }
  if (status >= 500) return new TTSError(`百炼服务出错（${status}）`, 'server');
  return new TTSError(`千问语音出错（${status}${code ? ' ' + code : ''}）`, 'http');
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// getSettings() -> {apiKey, mock, mockFail, qwenVoice}; store: {getAudio, putAudio, audioIndex, deleteAudio}
export function createTTS({ getSettings, store = null, fetchImpl, sleep = sleepMs, now = () => Date.now(), memSize = 60,
  caps = TTS_CACHE, timeoutMs = TTS_TIMEOUT_MS, online = () => !(globalThis.navigator && navigator.onLine === false) } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const mem = new Map();          // key -> Blob, most recent last
  const inflight = new Map();     // key -> Promise<Blob>
  const links = new Map();        // key -> {url, until}: a paid synthesis whose download failed; the next tap fetches it again
  const counts = { synth: 0, memHits: 0, storeHits: 0 };
  let puts = 0;

  const modelOf = s => (s.mock ? 'mock' : TTS_MODEL);   // mock beeps never mix with real clips
  const keyOf = (text, voice, s = getSettings()) => `${modelOf(s)}|${voice || s.qwenVoice || 'Jennifer'}|${text}`;
  function remember(key, blob) {
    mem.delete(key);
    mem.set(key, blob);
    while (mem.size > memSize) mem.delete(mem.keys().next().value);
  }

  async function withTimeout(fn) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try { return await fn(ctrl.signal); } catch (e) {
      if (e instanceof TTSError) throw e;
      if (timedOut) throw new TTSError('千问语音太慢', 'timeout');
      throw new TTSError('连不上百炼', 'network');
    } finally { clearTimeout(timer); }
  }

  async function synthesize(text, voice, key) {
    const s = getSettings();
    if (s.mock) {
      counts.synth++;
      await sleep(300 + Math.floor(Math.random() * 200));
      if (s.mockFail) throw new TTSError('连不上百炼', 'network');
      const wav = makeWav({ seconds: Math.min(1.2, 0.18 + String(text).length * 0.012), freq: 660 });
      return new Blob([wav], { type: 'audio/wav' });
    }
    if (!s.apiKey) throw new TTSError('还没填百炼 Key', 'nokey');
    if (!/^[\x21-\x7e]+$/.test(s.apiKey)) throw new TTSError('Key 格式不对', 'badkey');
    if (!online()) throw new TTSError('连不上百炼', 'network');
    const link = links.get(key);
    let url = link && link.until > now() ? link.url : '';
    if (!url) {
      links.delete(key);
      counts.synth++;
      const data = await withTimeout(async signal => {
        const res = await doFetch(TTS_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + s.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: TTS_MODEL, input: { text, voice, language_type: ttsLanguage(text) } }),
          signal,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw httpError(res.status, body);
        return body;
      });
      const audio = data && data.output && data.output.audio;
      if (audio && audio.data && !audio.url) return new Blob([wavFromBase64(audio.data)], { type: 'audio/wav' });
      if (!audio || !audio.url) throw new TTSError('千问语音没返回音频', 'http');
      url = httpsAudioUrl(audio.url);
      // this synthesis is paid for: if the download fails, the next tap only downloads again (the link lives 24 h;
      // it is dropped 10 minutes early)
      const expires = Number(audio.expires_at) > 0 ? Number(audio.expires_at) * 1000 : now() + 36e5;
      links.set(key, { url, until: Math.min(expires, now() + 864e5) - 6e5 });
      while (links.size > 50) links.delete(links.keys().next().value);
    }
    const blob = await withTimeout(async signal => {
      const res = await doFetch(url, { signal });
      if (!res.ok) throw new TTSError(`音频没下载下来（${res.status}）`, 'audio');
      const b = await res.blob();
      if (!b.size) throw new TTSError('音频是空的', 'audio');
      return /^audio\//.test(b.type) ? b : new Blob([b], { type: 'audio/wav' });
    });
    links.delete(key);
    return blob;
  }

  async function save(key, voice, text, blob) {
    if (!store) return;
    const bytes = await blob.arrayBuffer();   // ArrayBuffer, not Blob: safest in WebKit's IndexedDB
    await store.putAudio({ key, voice, text, type: blob.type || 'audio/wav', bytes, size: bytes.byteLength, used: now(), at: now() });
    if (puts++ % 10 === 0) {
      const del = planTrim(await store.audioIndex(), caps);
      if (del.length) await store.deleteAudio(del);
    }
  }

  // The clip for this text: memory, then IndexedDB, then one synthesis (concurrent asks share it).
  async function clip(text, { voice } = {}) {
    const s = getSettings();
    const v = voice || s.qwenVoice || 'Jennifer';
    const key = keyOf(text, v, s);
    const hit = mem.get(key);
    if (hit) { counts.memHits++; remember(key, hit); return hit; }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      if (store) {
        let rec = null;
        try { rec = await store.getAudio(key); } catch (e) { /* a cache miss, not an error */ }
        if (rec && rec.bytes) {
          counts.storeHits++;
          const blob = new Blob([rec.bytes], { type: rec.type || 'audio/wav' });
          remember(key, blob);
          if (now() - (rec.used || 0) > 36e5) store.putAudio({ ...rec, used: now() }).catch(() => {});
          return blob;
        }
      }
      const blob = await synthesize(text, v, key);
      remember(key, blob);
      save(key, v, text, blob).catch(e => console.warn('tts cache:', (e && e.message) || e));
      return blob;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  return {
    clip,
    peek: (text, voice) => mem.get(keyOf(text, voice)) || null,   // synchronous: lets a tap play without an await
    stats: () => ({ ...counts }),
    clearMemory: () => mem.clear(),
  };
}

// ---------------------------------------------------------------- player (browser only)

export function createPlayer({ AudioCtor = globalThis.Audio, createURL = b => URL.createObjectURL(b), revokeURL = u => URL.revokeObjectURL(u) } = {}) {
  let el = null, url = '', end = null, silent = '';
  const element = () => {
    if (!el) {
      el = new AudioCtor();
      el.preload = 'auto';
      try { el.setAttribute('playsinline', ''); } catch (e) { /* ignore */ }
    }
    return el;
  };
  const release = () => { if (url) { revokeURL(url); url = ''; } };

  function stop() {
    const done = end;
    end = null;
    if (el) { try { el.pause(); } catch (e) { /* ignore */ } }
    release();
    if (done) done('stopped');
  }

  // Inside the tap: start a 50 ms silent clip on the shared element so iOS allows the later play().
  function unlock() {
    const a = element();
    stop();
    if (!silent) {
      const wav = makeWav({ seconds: 0.05, freq: 0, rate: 8000 });
      let bin = '';
      for (const b of wav) bin += String.fromCharCode(b);
      silent = 'data:audio/wav;base64,' + btoa(bin);
    }
    try {
      a.src = silent;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});   // the real clip interrupting it is expected
    } catch (e) { /* ignore */ }
  }

  // Resolves 'ended' or 'stopped'; rejects TTSError('play' | 'blocked').
  function play(blob) {
    const a = element();
    stop();
    url = createURL(blob);
    return new Promise((resolve, reject) => {
      let settled = false, watchdog = 0;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        a.onended = a.onerror = a.onloadedmetadata = null;
        if (end === done) end = null;
        fn(v);
      };
      const done = how => finish(resolve, how);
      end = done;
      a.onended = () => done('ended');
      a.onerror = () => finish(reject, new TTSError('音频放不出来', 'play'));
      // iOS sometimes never sends ended; free the button after the clip's length
      a.onloadedmetadata = () => {
        if (isFinite(a.duration) && a.duration > 0) watchdog = setTimeout(() => done('ended'), a.duration * 1000 + 1500);
      };
      try {
        a.src = url;
        const p = a.play();
        if (p && p.catch) p.catch(err => finish(reject, new TTSError((err && err.message) || '音频放不出来', err && err.name === 'NotAllowedError' ? 'blocked' : 'play')));
      } catch (err) { finish(reject, new TTSError((err && err.message) || '音频放不出来', 'play')); }
    });
  }

  return { unlock, play, stop, busy: () => !!end };
}

// ---------------------------------------------------------------- controller

const WHY = {
  nokey: '还没填百炼 Key', badkey: '百炼 Key 不对', network: '连不上千问语音', timeout: '千问语音太慢',
  billing: '百炼欠费或预算用完', ratelimit: '百炼限流了', model: `这个 Key 没开通 ${TTS_MODEL}`, inspection: '这段内容没通过安全检查',
  server: '百炼服务出错', host: '千问语音的音频地址变了', audio: '音频没下载下来', play: '音频放不出来', blocked: '音频放不出来',
};
export const fallbackMessage = code => `${WHY[code] || '千问语音出错了'}，先用系统语音（静音时没声音）`;
// the lasting line in 我的 while Qwen is paused
export const problemMessage = code => `千问语音用不了：${WHY[code] || '出错了'}。现在用系统语音，静音时没声音；点“试听”再试一次。`;
// Failures a retry will not fix soon. Each tap would wait for a round trip and fall back anyway ('host' also pays for
// a synthesis it cannot download), so Qwen pauses for QWEN_PAUSE_MS. Changing the key or the voice, the 试听 button,
// and coming back to the app end the pause early. Network, timeout, rate limit, server, audio and play stay retried.
const PAUSING = new Set(['badkey', 'model', 'billing', 'host']);
export const QWEN_PAUSE_MS = 10 * 60 * 1000;
export const NOTE_GAP_MS = 60 * 1000;   // the same reason's toast at most once a minute

// speech: createSpeech(); tts: createTTS(); player: createPlayer(); notify(msg) shows a toast;
// onProblem() runs when the pause starts or ends (我的 re-renders its note).
export function createVoice({ speech, tts, player, getSettings, notify = () => {}, onProblem = () => {}, now = () => Date.now() }) {
  let cur = null;     // {text, button, token, via: 'qwen' | 'system', started}
  let seq = 0;
  let paused = null;  // {code, sig, at}
  const noted = new Map();   // reason -> when its toast was shown
  const note = (code, msg) => {
    const t = noted.get(code);
    if (t !== undefined && now() - t < NOTE_GAP_MS) return;
    noted.set(code, now());
    notify(msg);
  };
  const sigOf = s => `${s.apiKey || ''}|${s.qwenVoice || 'Jennifer'}|${s.mock ? 'mock' : ''}`;
  function problem(s = getSettings()) {
    if (!paused || paused.sig !== sigOf(s) || now() - paused.at >= QWEN_PAUSE_MS) return null;
    return { code: paused.code, message: problemMessage(paused.code) };
  }
  function setPaused(v) {
    if (!v && !paused) return;
    paused = v;
    try { onProblem(); } catch (e) { /* ignore */ }
  }

  function mark(button, state) {
    if (!button || !button.classList) return;
    button.classList.toggle('loading', state === 'loading');
    button.classList.toggle('playing', state === 'playing');
    if (state === 'loading') button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
  }
  const live = token => cur && cur.token === token;
  function done(token) {
    if (!live(token)) return;
    mark(cur.button, '');
    cur = null;
  }

  function stop() {
    seq++;
    const c = cur;
    cur = null;
    if (c) mark(c.button, '');
    if (player) player.stop();
    if (speech) speech.stop();
  }

  // 'loading' until the engine reports start, then 'playing'. An utterance WebKit dropped never starts, so the
  // button keeps blinking and a tap on it starts over instead of counting as "stop".
  function withSystem(text, token) {
    if (!speech || !speech.supported) { note('nospeech', '这个浏览器不能朗读'); done(token); return; }
    cur.via = 'system';
    cur.started = false;
    mark(cur.button, 'loading');
    const ok = speech.speak(text, {
      onstart: () => { if (live(token)) { cur.started = true; mark(cur.button, 'playing'); } },
      onend: () => done(token),
    });
    if (!ok) done(token);
  }

  function fallback(err, rest, token) {
    if (!live(token)) return;
    const code = (err && err.code) || 'http';
    if (!(err instanceof TTSError)) console.warn('tts:', err);
    else if (code !== 'nokey') console.warn('tts:', code, err.message);
    // start the pause once; taps during it do not stretch it
    if (PAUSING.has(code) && !problem()) setPaused({ code, sig: sigOf(getSettings()), at: now() });
    note(code, fallbackMessage(code));
    withSystem(rest, token);
  }

  function withQwen(text, token) {
    const s = getSettings();
    cur.via = 'qwen';
    // no key: known at once, so the system voice still starts inside the tap
    if (!s.mock && !s.apiKey) { fallback(new TTSError('还没填百炼 Key', 'nokey'), text, token); return; }
    const voice = s.qwenVoice || 'Jennifer';
    const parts = splitForTTS(text);
    if (!parts.length) { done(token); return; }
    const first = tts.peek(parts[0], voice);
    // paused: a clip already in memory still plays (no network, sounds on silent); anything else goes to the
    // system voice right here inside the tap, with no unlock, no loading state and no request
    const stuck = !first && problem(s);
    if (stuck) { note(stuck.code, fallbackMessage(stuck.code)); withSystem(text, token); return; }
    if (!first) {
      // the clip comes after an await: unlock the shared element now, and lift the system voice's tap
      // restriction too (once per page) in case this ends in the fallback
      player.unlock();
      if (speech) speech.prime();
      mark(cur.button, 'loading');
    }
    const asked = [];
    const get = i => (asked[i] = asked[i] || tts.clip(parts[i], { voice }));
    (async () => {
      let i = 0;
      try {
        for (; i < parts.length; i++) {
          const blob = i === 0 && first ? first : await get(i);
          if (!live(token)) return;
          if (i + 1 < parts.length) get(i + 1).catch(() => {});   // fetch the next piece while this one plays
          mark(cur.button, 'playing');
          const how = await player.play(blob);   // the first cached clip starts here, still inside the tap
          if (how === 'stopped' || !live(token)) return;
        }
        done(token);
      } catch (e) {
        fallback(e, parts.slice(i).join(' '), token);
      }
    })();
  }

  // One entry point for every speak button. A second tap on what is playing (or on a Qwen clip still being made)
  // stops it; a second tap on a system utterance that has not started yet starts it over.
  // opts.retry (the 试听 button): end a Qwen pause first, so it always tries Qwen again.
  function say(raw, button = null, { retry = false } = {}) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    setPlaybackSession();
    if (cur && cur.text === text && !(cur.via === 'system' && !cur.started)) { stop(); return; }
    stop();
    if (retry) setPaused(null);
    const token = ++seq;
    cur = { text, button, token, via: '', started: false };
    if (voiceMode(getSettings()) === 'qwen' && tts && player) withQwen(text, token);
    else withSystem(text, token);
  }

  return {
    say, stop, busy: () => !!cur, mode: () => voiceMode(getSettings()),
    problem: () => problem(),             // {code, message} while Qwen is paused for the current key and voice
    clearProblem: () => setPaused(null),  // coming back to the app
  };
}
