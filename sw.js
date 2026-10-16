// Offline shell for Word Coach: cache-first, versioned.
// Keep VERSION identical to VERSION in js/config.js and bump both on every release, or phones keep the old files.
const VERSION = '0.4';
const CACHE = 'wordcoach-' + VERSION;
// The offline dictionary (data/, about 4.6 MB, 2 MB gzipped) changes rarely, so it lives in its own cache that
// survives app updates and is only downloaded when missing. Bump DATA_VERSION whenever a file in data/ changes.
const DATA_VERSION = '1';
const DATA_CACHE = 'wordcoach-data-' + DATA_VERSION;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
  'js/app.js', 'js/config.js', 'js/prompts.js', 'js/ai.js', 'js/db.js', 'js/words.js', 'js/fsrs.js', 'js/speech.js', 'js/tts.js', 'js/dict.js',
  'js/banners.js', 'js/ui-dom.js', 'js/ui-entry.js', 'js/ui-look.js', 'js/ui-lib.js', 'js/ui-review.js', 'js/ui-me.js',
  'data/dict.txt', 'data/lemma.txt', 'data/ECDICT-LICENSE.txt',
];
const isData = u => u.startsWith('data/');
const BASE = new URL('./', self.location).href;          // https://weibao0401.github.io/wordcoach/
const CHECK = new URL('./check/', self.location).pathname; // the check page has its own worker

const fresh = u => new Request(new URL(u, BASE), { cache: 'reload' });

self.addEventListener('install', e => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(SHELL.filter(u => !isData(u)).map(fresh))),
    caches.open(DATA_CACHE).then(async c => {
      const missing = [];
      for (const u of SHELL.filter(isData)) if (!(await c.match(new URL(u, BASE)))) missing.push(u);
      return c.addAll(missing.map(fresh));
    }),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('wordcoach-') && k !== CACHE && k !== DATA_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only same-origin files. Bailian (dashscope.aliyuncs.com) and anything else go straight to the network, never cached.
  if (url.origin !== self.location.origin || !url.href.startsWith(BASE) || url.pathname.startsWith(CHECK)) return;

  if (req.mode === 'navigate') {
    // The shell loads js/ by relative path, so it only works at the app root. A mistyped path goes back to
    // /wordcoach/ (keeping ?mock=1 and the like), and /wordcoach/check without the slash goes to the check page.
    const root = new URL(BASE).pathname;
    if (url.pathname !== root && url.pathname !== root + 'index.html') {
      e.respondWith(Response.redirect(url.pathname === CHECK.slice(0, -1) ? new URL(CHECK, BASE).href : BASE + url.search, 302));
      return;
    }
    e.respondWith(caches.match(BASE, { cacheName: CACHE }).then(hit => hit || fetch(req)).catch(() => caches.match(BASE)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true, cacheName: CACHE })
    .then(hit => hit || caches.match(req, { ignoreSearch: true, cacheName: DATA_CACHE }))
    .then(hit => hit || fetch(req).then(res => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(isData(url.href.slice(BASE.length)) ? DATA_CACHE : CACHE).then(c => c.put(req, copy));
      }
      return res;
    })));
});
