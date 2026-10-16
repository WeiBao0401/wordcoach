// Boot: settings, data, tabs, banners, badge, service worker.
import { VERSION, DEFAULT_SETTINGS, DEFAULT_MODELS } from './config.js';
import { idbStore } from './db.js';
import { createAI } from './ai.js';
import { createWords } from './words.js';
import { createDict } from './dict.js';
import { createSpeech } from './speech.js';
import { createTTS, createPlayer, createVoice } from './tts.js';
import { bannerSpecs, shrinkState } from './banners.js';
import { h, icon, toast } from './ui-dom.js';
import { createEntryView } from './ui-entry.js';
import { createLookTab } from './ui-look.js';
import { createLibTab } from './ui-lib.js';
import { createReviewTab } from './ui-review.js';
import { createMeTab } from './ui-me.js';
import { hasExtras } from './words.js';

const params = new URLSearchParams(location.search);
// ?mock=offline: mock mode where every model call fails like a dropped connection (tests the dictionary fallback)
const mockOffline = params.get('mock') === 'offline';
const mockForced = params.get('mock') === '1' || mockOffline;
const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

let settings = structuredClone(DEFAULT_SETTINGS);
let lastExport = null;      // {at, count, total}
let shrink = null;          // {now, then} when the library shrank by 20%+ since the last export
let updateReady = false;
let busyCount = 0;
let tab = 'look';
const scrollPos = {};
const views = new Set();

const liveSettings = () => ({ ...settings, mock: !!settings.mock || mockForced, mockFail: mockOffline ? 'network' : '' });
const ai = createAI({ getSettings: liveSettings });
// Offline base dictionary (SPEC 2.1 #12): same-origin files, cached by the service worker.
// A network failure is an English TypeError on iOS ("Load failed"), so it gets a Chinese message here.
const DICT_NET_MSG = '网络不通，连上网后点“重试”';
const dict = createDict({
  fetchText: async name => {
    let res;
    try { res = await fetch('data/' + name); } catch (e) { console.warn('dictionary fetch:', (e && e.message) || e); throw new Error(DICT_NET_MSG); }
    if (!res.ok) throw new Error(`下载 ${name} 失败（${res.status}）`);
    try { return await res.text(); } catch (e) { console.warn('dictionary read:', (e && e.message) || e); throw new Error(DICT_NET_MSG); }
  },
});
const words = createWords({ store: idbStore, ai, dict });
const speech = createSpeech({ getVoiceName: () => settings.voice });
// Pronunciation (SPEC 2.1 #11): Qwen voice through one shared <audio> element (sounds on silent), clips cached in
// IndexedDB; the system voice is the free choice and the fallback.
const tts = createTTS({ getSettings: liveSettings, store: idbStore });
const voice = createVoice({ speech, tts, player: createPlayer(), getSettings: liveSettings, notify: msg => toast(msg, 3500),
  onProblem: () => { if (me) me.onChange(); } });

let look, lib, review, me;
let sheetView = null;

const TABS = [['look', '查词', 'search'], ['lib', '词库', 'book'], ['review', '复习', 'cards'], ['me', '我的', 'me']];

const app = {
  words, dict, speech, tts, voice, store: idbStore, version: VERSION,
  say: (text, button, opts) => voice.say(text, button, opts),
  settings: () => settings,
  async saveSettings(patch) {
    settings = { ...settings, ...patch, models: { ...settings.models, ...(patch.models || {}) } };
    if ('newPerDay' in patch) updateBadge();
    await idbStore.setMeta('settings', settings);
  },
  mockForced: () => mockForced,
  lookup(q, opts) { closeSheet(); showTab('look'); look.lookup(q, opts); },
  backToZh() { look.backToZh(); },
  async toggleFav(slug, on) {
    try {
      await words.favorite(slug, on);
      toast(on ? '已收藏，进入词库和复习' : '已取消收藏，移回“最近查过”');
    } catch (e) { toast(e.message || String(e)); }
  },
  async regen(e) {
    try {
      const r = await words.lookup(e.headword, '', { force: true });
      if (!r.ok) toast(r.message, 3000);
      else if (r.found === false) toast('模型这次没认出这个词，讲解没变。', 3000);
      else toast('核心释义已更新，其余部分正在生成');
    } catch (err) { toast(err.message || String(err), 3500); }
  },
  registerView: v => views.add(v),
  unregisterView: v => views.delete(v),
  showTab: t => showTab(t),
  currentTab: () => tab,
  scrollTop: () => window.scrollTo(0, 0),
  topInset: () => 0,
  openSheet: slug => openSheet(slug),
  updateBadge: () => updateBadge(),
  refreshBanners: () => { checkShrink(); renderBanners(); },
  lastExport: () => lastExport,
  async recordExport({ at = new Date().toISOString(), count, total }) {
    lastExport = { at, count, total };
    await idbStore.setMeta('lastExport', lastExport);
    checkShrink();
    renderBanners();
  },
  busy: d => { busyCount = Math.max(0, busyCount + d); },
};

// ---------------------------------------------------------------- tabs
const tabbar = document.getElementById('tabbar');
const tabButtons = {};
function buildTabbar() {
  tabbar.replaceChildren();
  for (const [k, label, ic] of TABS) {
    const b = h('button', { type: 'button', className: 'tb' + (k === tab ? ' on' : ''), 'aria-label': label, dataset: { tab: k },
      on: { click: () => (k === tab ? reselect(k) : showTab(k)) } },
    icon(ic, 'ic tb-ic'), h('span', { className: 'tb-label', text: label }), k === 'review' ? h('span', { className: 'tb-badge', hidden: true }) : null);
    if (k === tab) b.setAttribute('aria-current', 'page');
    tabButtons[k] = b;
    tabbar.append(b);
  }
}
function showTab(t, { force = false } = {}) {
  if (!TABS.some(x => x[0] === t)) return;
  if (t === tab && !force) return;
  voice.stop();
  scrollPos[tab] = window.scrollY;
  if (tab === 'lib' && lib) lib.hide();
  tab = t;
  for (const [k] of TABS) {
    document.getElementById('tab-' + k).hidden = k !== t;
    const b = tabButtons[k];
    if (b) { b.classList.toggle('on', k === t); if (k === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  }
  const mod = { look, lib, review, me }[t];
  if (mod && mod.show) mod.show();
  window.scrollTo(0, scrollPos[t] || 0);
}
function reselect(t) {
  if (t === 'lib' && lib.inDetail()) { lib.back(); return; }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (t === 'look') look.focus();
}

// ---------------------------------------------------------------- live updates
let changeTimer = 0;
words.onChange(({ slug }) => {
  for (const v of views) {
    if (!slug || v.slug === slug) v.update(v.slug ? words.get(v.slug) : undefined);
  }
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    look && look.onChange();
    lib && lib.onChange();
    review && review.onChange();
    me && me.onChange();
    updateBadge();
  }, 50);
});

// ---------------------------------------------------------------- sheet (full entry from a flashcard)
const sheet = document.getElementById('sheet');
function openSheet(slug) {
  const e = words.get(slug);
  if (!e) return;
  closeSheet();
  sheetView = createEntryView(app, { where: 'sheet' });
  sheet.replaceChildren(
    h('div', { className: 'sheet-bar' }, h('button', { type: 'button', className: 'back', text: '完成', on: { click: closeSheet } })),
    sheetView.el);
  views.add(sheetView);
  sheetView.show(e, {});
  sheet.hidden = false;
  sheet.scrollTop = 0;
  document.body.classList.add('sheet-open');
  if (!hasExtras(e) || e.needs_core) words.enrich(slug).catch(() => {});
}
function closeSheet() {
  if (!sheetView) return;
  voice.stop();
  views.delete(sheetView);
  sheetView.destroy();
  sheetView = null;
  sheet.hidden = true;
  sheet.replaceChildren();
  document.body.classList.remove('sheet-open');
}

// ---------------------------------------------------------------- banners, badge
function checkShrink() {
  shrink = shrinkState(words.favorites().length, lastExport);
}
// No backup reminder here any more (SPEC 2.4): only the red warnings, the mock-mode notes and the update note.
function renderBanners() {
  const box = document.getElementById('banners');
  const actions = { restore: () => showTab('me') };
  box.replaceChildren(...bannerSpecs({ standalone, shrink, mockOffline, mock: !!settings.mock || mockForced, updateReady }).map(b =>
    h('div', { className: 'banner ' + b.kind, role: b.kind === 'fail' ? 'alert' : 'status' },
      h('span', { className: 'banner-text', text: b.text }),
      b.btn ? h('button', { type: 'button', className: 'banner-btn', text: b.btn, on: { click: actions[b.action] } }) : null)));
}

function updateBadge() {
  const n = words.dueCount(settings.newPerDay);
  const b = tabButtons.review && tabButtons.review.querySelector('.tb-badge');
  if (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); }
  if (tabButtons.review) tabButtons.review.setAttribute('aria-label', n ? `复习，还有 ${n} 个` : '复习');
  try {
    if ('setAppBadge' in navigator && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- service worker
// Nothing that a reload would break: no lookup or enrich call running, no review session, sheet,
// unsent text, pending import preview or packed backup.
function isIdle() {
  const a = document.activeElement;
  const typing = a && /INPUT|TEXTAREA/.test(a.tagName) && a.value;
  return !busyCount && !(look && look.isBusy()) && !(review && review.inSession()) && !sheetView && !typing &&
    !words.enriching() && !(me && me.holding());
}
// Stricter, for a reload while the app is in use: nothing being read either.
const isQuiet = () => isIdle() && !(tab === 'look' && look && look.hasResult()) && !(tab === 'lib' && lib && lib.inDetail());

let swReg = null;
let reloaded = false;
function reloadOnce() { if (reloaded) return; reloaded = true; location.reload(); }
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!((location.protocol === 'https:' && !local) || params.has('sw'))) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // the very first install also fires this (clients.claim); only a real update reloads
    if (!hadController || reloaded) return;
    if (isQuiet()) reloadOnce(); else { updateReady = true; renderBanners(); }
  });
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then(r => { swReg = r; }).catch(() => {});
}
// iOS resumes a Home Screen app from memory instead of reloading it: that is the "next open".
function onResumeSW() {
  if (updateReady && isIdle()) reloadOnce();
  else if (swReg) swReg.update().catch(() => {});
}

// ---------------------------------------------------------------- boot
function fatal(err) {
  const box = document.getElementById('tab-look');
  box.replaceChildren(
    h('div', { className: 'brand' }, h('span', { className: 'mark' }, 'Word ', h('i', { text: 'Coach' }))),
    h('div', { className: 'err-box big' },
      h('p', { text: '打不开本机数据：' + ((err && err.message) || err) }),
      h('p', { className: 'small', text: '上滑关掉 App 再打开。还不行的话，把这句话截图发给 Claude。' }),
      h('div', { className: 'btn-row' }, h('button', { type: 'button', className: 'btn', text: '重新载入', on: { click: () => location.reload() } }))));
}

async function boot() {
  buildTabbar();
  registerSW();
  try {
    const saved = await idbStore.getMeta('settings');
    if (saved && typeof saved === 'object') settings = { ...settings, ...saved, models: { ...DEFAULT_MODELS, ...(saved.models || {}) } };
    lastExport = (await idbStore.getMeta('lastExport')) || null;
    await words.load();
  } catch (e) {
    console.error(e);
    fatal(e);
    return;
  }
  look = createLookTab(app);
  lib = createLibTab(app);
  review = createReviewTab(app);
  me = createMeTab(app);
  checkShrink();
  renderBanners();
  updateBadge();
  showTab('look', { force: true });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  speech.onVoices(() => me.onChange());   // iOS lists the system voices a moment after launch
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { voice.stop(); return; }
    voice.clearProblem();   // back in the app: the next tap tries the Qwen voice again
    updateBadge();
    renderBanners();
    review.onChange();
    onResumeSW();
  });
  document.documentElement.dataset.ready = '1';
  // the dictionary loads after the first paint, in small slices; views that rendered before it get the extras
  dict.ready.then(() => {
    for (const v of views) v.update();
    me.onChange();
  });
  let dictStarted = false;
  const startDict = () => {
    if (dictStarted) return;
    dictStarted = true;
    dict.load().catch(e => { console.warn('dictionary:', (e && e.message) || e); me.onChange(); });
  };
  requestAnimationFrame(() => setTimeout(startDict, 60));
  setTimeout(startDict, 1500);   // no animation frames in a background tab
}

boot();
