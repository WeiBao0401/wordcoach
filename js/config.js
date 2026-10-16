// Keep VERSION identical to VERSION in sw.js; bump both on every release.
export const VERSION = '0.2';

export const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

export const DEFAULT_MODELS = { core: 'qwen-plus', extras: 'qwen-plus', zh: 'qwen-plus' };
export const MODEL_CHOICES = ['qwen-flash', 'qwen3.7-flash', 'qwen-plus', 'qwen3.7-plus'];

// Output token budgets per call; doubled on truncation up to MAX_BUDGET.
export const BUDGET = { core: 1500, lexicon: 2500, practice: 2500, zh: 2000, story: 2500 };
export const MAX_BUDGET = 6000;
export const RETRY_DELAYS = [1500, 3000];
export const TIMEOUT_MS = { core: 40000, lexicon: 60000, practice: 60000, zh: 45000, story: 60000 };

export const DB_NAME = 'wordcoach';
export const DB_VERSION = 1;
export const DB_TIMEOUT_MS = 8000;
export const LOG_CAP = 3000;

export const NEW_PER_DAY = 30;
export const LIB_CHUNK = 150;
export const BACKUP_REMIND_DAYS = 7;
export const SHRINK_RATIO = 0.8;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  models: { ...DEFAULT_MODELS },
  mock: false,
  guessFirst: true,
  newPerDay: NEW_PER_DAY,
  voice: '',
};
