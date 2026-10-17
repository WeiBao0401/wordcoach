// Keep VERSION identical to VERSION in sw.js; bump both on every release.
export const VERSION = '0.5';

export const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// Models (SPEC 5): picked 2026-10-16 from the Bailian docs. note = price in CNY per 1M tokens, input / output.
export const DEFAULT_MODELS = { core: 'qwen3.8-flash', extras: 'qwen3.7-plus', zh: 'qwen3.8-max' };
// Changing DEFAULT_MODELS reaches every profile whose models were never changed in 我的 (settings.modelsChosen false):
// loadSettings in db.js swaps them on the next launch. A model picked in 我的 sets modelsChosen and is never replaced.
// OLD_DEFAULT_MODEL is the default up to v0.3, saved before modelsChosen existed: there, three of it count as never
// changed (SPEC 2.4).
export const OLD_DEFAULT_MODEL = 'qwen-plus';
export const MODEL_CHOICES = [
  { id: 'qwen3.8-flash', label: '快速 · 查词推荐', tier: 'fast', note: '0.8 / 2.7 元' },
  { id: 'qwen3.7-flash', label: '快速 · 最省钱', tier: 'fast', note: '0.2 / 0.8 元' },
  { id: 'qwen3.7-plus', label: '均衡 · 扩展推荐', tier: 'balanced', note: '2 / 8 元' },
  { id: 'qwen3.8-max', label: '最强 · 中译英推荐', tier: 'max', note: '12 / 36 元' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek · 实验', tier: 'experimental', note: '12 / 24 元' },
  { id: 'qwen-plus', label: '旧版 · 兜底', tier: 'legacy', note: '0.8 / 2 元' },
];
// 我的 → 模型 → 测一下速度: the real core prompt for this word, once per model, with this timeout each
export const SPEED_WORD = 'meticulous';
export const SPEED_TIMEOUT_MS = 30000;

// No max_tokens: the Bailian json-mode doc says not to set it with structured output. A reply cut off anyway
// (finish_reason "length") is asked for once more, then reported (ai.js).
export const RETRY_DELAYS = [1500, 3000];
export const TIMEOUT_MS = { core: 40000, lexicon: 60000, practice: 60000, zh: 45000, story: 60000 };

// The word data. DB_VERSION never goes down (IndexedDB cannot downgrade); it stays 1 as long as nothing needs a
// new store or index there. Disposable data gets its own database instead (SPEC 4.1).
export const DB_NAME = 'wordcoach';
export const DB_VERSION = 1;
// Qwen voice clips (v0.3), separate so the word database keeps its version and a rollback stays safe
export const AUDIO_DB_NAME = 'wordcoach-audio';
export const AUDIO_DB_VERSION = 1;
export const DB_TIMEOUT_MS = 8000;
export const LOG_CAP = 3000;

export const NEW_PER_DAY = 10;
export const LIB_CHUNK = 150;
export const SHRINK_RATIO = 0.8;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  models: { ...DEFAULT_MODELS },
  modelsChosen: false, // true once a model is changed in 我的; while false, the models follow DEFAULT_MODELS (loadSettings)
  mock: false,
  guessFirst: true,
  newPerDay: NEW_PER_DAY,
  voice: '',          // system voice name ('' = best installed English voice)
  voiceMode: '',      // 'qwen' | 'system'; '' = Qwen when an API key is set, else system (see voiceMode() in tts.js)
  qwenVoice: 'Jennifer',
};

// Qwen TTS (SPEC 5.1): same Bailian key and host as the chat calls. The audio comes back as a 24 h link
// on one of the result buckets below (all send Access-Control-Allow-Origin: *); index.html's CSP lists them.
export const TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const TTS_MODEL = 'qwen3-tts-flash';
export const TTS_RESULT_HOSTS = ['dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 'dashscope-result-sh.oss-cn-shanghai.aliyuncs.com',
  'dashscope-result-hz.oss-cn-hangzhou.aliyuncs.com'];
export const TTS_VOICES = [['Jennifer', '美式女声'], ['Aiden', '美式男声'], ['Cherry', '女声，中英文都自然']];
export const TTS_CHUNK = 500;          // characters per request (the API takes up to 600; a Chinese character counts 2)
export const TTS_TEXT_CAP = 3000;      // longest text read aloud in one tap (a reading passage)
export const TTS_TIMEOUT_MS = 15000;
export const TTS_CACHE = { clips: 2000, bytes: 150 * 1024 * 1024 };
