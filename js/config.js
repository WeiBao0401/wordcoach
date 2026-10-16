// Keep VERSION identical to VERSION in sw.js; bump both on every release.
export const VERSION = '0.3';

export const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

export const DEFAULT_MODELS = { core: 'qwen-plus', extras: 'qwen-plus', zh: 'qwen-plus' };
export const MODEL_CHOICES = ['qwen-flash', 'qwen3.7-flash', 'qwen-plus', 'qwen3.7-plus'];

// Output token budgets per call; doubled on truncation up to MAX_BUDGET.
export const BUDGET = { core: 1500, lexicon: 2500, practice: 2500, zh: 2000, story: 2500 };
export const MAX_BUDGET = 6000;
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

export const NEW_PER_DAY = 30;
export const LIB_CHUNK = 150;
export const SHRINK_RATIO = 0.8;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  models: { ...DEFAULT_MODELS },
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
