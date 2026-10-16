// System text-to-speech (Web Speech): the best installed English voice, or the one chosen in settings.
//
// iOS notes (SPEC 2.1 #11, v0.3):
// - The ringer switch mutes Web Speech in Safari. navigator.audioSession.type = 'playback' (Safari 16.4+) is set
//   before speaking, which may lift that; the Qwen voice (tts.js) plays through an <audio> element, which always sounds.
// - WebKit lets speak() start only inside a tap until one utterance has been started from a tap; after that the
//   restriction is gone for the page. Hence:
//   * A cancel() right before speak() can drop the new utterance in WebKit (bugs 191745, 238189). So speak() never
//     follows a cancel() in the same moment, whoever called cancel(): stop() and speak() both go through cancelNow(),
//     which remembers when it ran.
//   * idle, and no cancel() in the last 60 ms: speak() at once, inside the tap.
//   * busy: cancel(), then speak a fresh utterance 60 ms later.
//   * idle, but cancel() ran less than 60 ms ago (the usual case: a tap stops what was playing, then speaks the new
//     text): speak the fresh utterance once 60 ms have passed since that cancel(), with no second cancel().
//   Deferring cannot lose the tap: there is something to cancel only after an earlier speak() ran inside a tap (or
//   prime() did), and WebKit lifts the tap restriction for the page the first time speak() is called in a tap.
// - The utterance being spoken is held in a module variable. One that only the engine references can be garbage
//   collected in WebKit, and then its end event never comes.

// Novelty and robotic macOS/iOS voices are useless for pronunciation.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/;
export const RESTART_DELAY_MS = 60;

function rank(v) {
  let r = /^en[-_]US/i.test(v.lang) ? 0 : /^en[-_]GB/i.test(v.lang) ? 10 : 20;
  r += /Premium/i.test(v.name) ? 0 : /Enhanced|Natural|Neural/i.test(v.name) ? 1 : /Ava|Samantha|Allison|Zoe|Evan|Nathan|Daniel|Karen|Moira/i.test(v.name) ? 2 : 3;
  return r;
}

// Safari 16.4+ Audio Session API: 'playback' plays with the ringer switch on silent. Never throws.
export function setPlaybackSession(nav = globalThis.navigator) {
  try {
    if (nav && nav.audioSession && nav.audioSession.type !== 'playback') nav.audioSession.type = 'playback';
  } catch (e) { /* not supported */ }
}

let held = null;   // the utterance in flight, kept against garbage collection
export const heldUtterance = () => held;   // for tests

export function createSpeech({
  getVoiceName = () => '',
  synth = (typeof globalThis !== 'undefined' && globalThis.speechSynthesis) || null,
  Utterance = globalThis.SpeechSynthesisUtterance,
  nav = globalThis.navigator,
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = t => clearTimeout(t),
  now = () => (globalThis.performance ? performance.now() : Date.now()),   // monotonic: only gaps are measured
} = {}) {
  let voices = [];
  let primed = false;
  let pending = 0;      // timer of a deferred start (busy, or right after a cancel)
  let active = null;    // {u, finish} of the utterance started last
  let cancelledAt = -Infinity;   // when synth.cancel() last ran
  const voiceListeners = new Set();

  function refresh() {
    if (!synth) return voices;
    try {
      voices = synth.getVoices().filter(v => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name)).sort((a, b) => rank(a) - rank(b));
    } catch (e) { voices = []; }
    return voices;
  }
  // iOS often returns no voices until voiceschanged fires; listeners hear only real changes (the settings
  // list re-renders on it, and Chromium fires the event several times)
  const names = () => voices.map(v => v.name).join('\n');
  const onChanged = () => {
    const before = names();
    refresh();
    if (names() === before) return;
    for (const fn of voiceListeners) { try { fn(); } catch (e) { /* ignore */ } }
  };
  if (synth) {
    refresh();
    try { synth.addEventListener('voiceschanged', onChanged); } catch (e) { synth.onvoiceschanged = onChanged; }
  }

  function pick() {
    if (!voices.length) refresh();
    const want = getVoiceName();
    return (want && voices.find(v => v.name === want)) || voices[0] || null;
  }

  const busy = () => !!(pending || (synth && (synth.speaking || synth.pending)));

  // Ends the current utterance's callbacks once; events that arrive later for it are ignored.
  function settle(how) {
    const a = active;
    if (!a) return;
    active = null;
    a.finish(how);
  }

  function start(u) {
    held = u;
    try { if (synth.paused) synth.resume(); } catch (e) { /* ignore */ }
    synth.speak(u);
  }

  function cancelNow() {
    try { synth.cancel(); } catch (e) { /* ignore */ }
    cancelledAt = now();
  }

  // Returns the utterance, or false when there is no speech engine or no text.
  // opts.onend(how) is called once: 'end', 'error' or 'stopped'.
  function speak(text, { rate = 0.92, onstart, onend, onerror } = {}) {
    if (!synth || !Utterance || !text) return false;
    setPlaybackSession(nav);
    const wasBusy = busy();
    const since = now() - cancelledAt;
    if (pending) { unschedule(pending); pending = 0; }
    settle('stopped');
    const u = new Utterance(String(text));
    const v = pick();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = rate;
    let done = false, watchdog = 0;
    const finish = how => {
      if (done) return;
      done = true;
      unschedule(watchdog);
      if (held === u) held = null;
      try { if (how === 'error' && onerror) onerror(); } catch (e) { /* ignore */ }
      try { if (onend) onend(how); } catch (e) { /* ignore */ }
    };
    active = { u, finish };
    u.onstart = () => { if (!done && onstart) { try { onstart(); } catch (e) { /* ignore */ } } };
    u.onend = () => { if (active && active.u === u) settle('end'); };
    u.onerror = ev => {
      // cancel() reports 'canceled' / 'interrupted' on the old utterance; that is not an error of this one
      if (!(active && active.u === u)) return;
      const err = ev && ev.error;
      settle(err === 'canceled' || err === 'interrupted' ? 'stopped' : 'error');
    };
    // iOS sometimes never sends end (audio interrupted, app in background): free the button anyway
    watchdog = schedule(() => { if (active && active.u === u) settle('end'); }, 4000 + String(text).length * 110 / rate);
    primed = true;
    const later = ms => { pending = schedule(() => { pending = 0; if (active && active.u === u) start(u); }, ms); };
    if (wasBusy) { cancelNow(); later(RESTART_DELAY_MS); }
    else if (since >= 0 && since < RESTART_DELAY_MS) later(RESTART_DELAY_MS - since);   // a cancel() just ran (stop() before this)
    else start(u);
    return u;
  }

  function stop() {
    if (pending) { unschedule(pending); pending = 0; }
    const was = !!active || (synth && (synth.speaking || synth.pending));
    settle('stopped');
    if (was && synth) cancelNow();
  }

  // Inside a tap, before an await whose result may fall back to this voice: a silent utterance lifts
  // WebKit's tap restriction for the page, so the later speak() is allowed. Once per page.
  function prime() {
    if (!synth || !Utterance || primed) return;
    primed = true;
    if (busy()) return;
    try {
      const u = new Utterance(' ');
      u.volume = 0;
      u.lang = 'en-US';
      held = u;
      synth.speak(u);
    } catch (e) { /* ignore */ }
  }

  return {
    supported: !!(synth && Utterance),
    speak,
    stop,
    prime,
    speaking: () => !!active,
    list: () => refresh().map(v => ({ name: v.name, lang: v.lang })),
    current: () => { const v = pick(); return v ? v.name : ''; },
    onVoices: fn => { voiceListeners.add(fn); return () => voiceListeners.delete(fn); },
  };
}
