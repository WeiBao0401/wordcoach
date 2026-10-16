// System text-to-speech: pick the best installed English voice, or the one chosen in settings.

// Novelty and robotic macOS/iOS voices are useless for pronunciation.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/;

function rank(v) {
  let r = /^en[-_]US/i.test(v.lang) ? 0 : /^en[-_]GB/i.test(v.lang) ? 10 : 20;
  r += /Premium/i.test(v.name) ? 0 : /Enhanced|Natural|Neural/i.test(v.name) ? 1 : /Ava|Samantha|Allison|Zoe|Evan|Nathan|Daniel|Karen|Moira/i.test(v.name) ? 2 : 3;
  return r;
}

export function createSpeech({ getVoiceName = () => '' } = {}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let voices = [];

  function refresh() {
    if (!synth) return voices;
    voices = synth.getVoices().filter(v => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name)).sort((a, b) => rank(a) - rank(b));
    return voices;
  }
  if (synth) {
    refresh();
    try { synth.addEventListener('voiceschanged', refresh); } catch (e) { synth.onvoiceschanged = refresh; }
  }

  function pick() {
    if (!voices.length) refresh();
    const want = getVoiceName();
    return (want && voices.find(v => v.name === want)) || voices[0] || null;
  }

  function speak(text, { rate = 0.92 } = {}) {
    if (!synth || !text) return false;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    const v = pick();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = rate;
    synth.speak(u);
    return true;
  }

  return {
    supported: !!synth,
    speak,
    list: () => refresh().map(v => ({ name: v.name, lang: v.lang })),
    current: () => { const v = pick(); return v ? v.name : ''; },
  };
}
