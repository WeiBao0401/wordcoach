// Offline shell for Word Coach: cache-first, versioned.
// Keep VERSION identical to VERSION in js/config.js and bump both on every release, or phones keep the old files.
const VERSION = '0.1';
const CACHE = 'wordcoach-' + VERSION;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
  'js/app.js', 'js/config.js', 'js/prompts.js', 'js/ai.js', 'js/db.js', 'js/words.js', 'js/fsrs.js', 'js/speech.js',
  'js/ui-dom.js', 'js/ui-entry.js', 'js/ui-look.js', 'js/ui-lib.js', 'js/ui-review.js', 'js/ui-me.js',
];
const BASE = new URL('./', self.location).href;          // https://weibao0401.github.io/wordcoach/
const CHECK = new URL('./check/', self.location).pathname; // the check page has its own worker

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(new URL(u, BASE), { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('wordcoach-') && k !== CACHE).map(k => caches.delete(k))))
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
  e.respondWith(caches.match(req, { ignoreSearch: true, cacheName: CACHE }).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
