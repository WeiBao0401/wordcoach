// Boot: settings, data, routes (three tabs, 我 pushed from 词库), the status line, badge, sheet, service worker.
import { VERSION, DEFAULT_SETTINGS } from './config.js';
import { idbStore, loadSettings } from './db.js';
import { createAI } from './ai.js';
import { createWords } from './words.js';
import { createDict } from './dict.js';
import { createSpeech } from './speech.js';
import { createTTS, createPlayer, createVoice } from './tts.js';
import { bannerSpecs, shrinkState, pickStatus } from './banners.js';
import { TABS, resolveRoute, reselectAction } from './nav.js';
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
let route = 'look';         // look | lib | review | me (me lives under the 词库 tab)
const scrollPos = {};
const views = new Set();
const statusSlots = new Set();

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

const app = {
  words, dict, speech, tts, voice, ai, store: idbStore, version: VERSION,
  say: (text, button, opts) => voice.say(text, button, opts),
  settings: () => settings,
  async saveSettings(patch) {
    settings = { ...settings, ...patch, models: { ...settings.models, ...(patch.models || {}) } };
    if ('newPerDay' in patch) updateBadge();
    await idbStore.setMeta('settings', settings);
  },
  mockForced: () => mockForced,
  lookup(q, opts) { closeSheet(); showRoute('look'); look.lookup(q, opts); },
  backToZh() { look.backToZh(); },
  async toggleFav(slug, on) {
    try {
      await words.favorite(slug, on);
      toast(on ? '已划进词库' : '已移出词库，回到“最近查过”');
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
  // 'me' (the old 我的 tab name) opens the settings page under 词库
  showTab: t => (resolveRoute(t).name === 'me' ? app.openMe() : showRoute(t)),
  openMe: (opts = {}) => { showRoute('me'); me.show(opts); },
  closeMe: () => showRoute('lib'),
  currentTab: () => resolveRoute(route).tab,
  currentRoute: () => route,
  scrollTop: () => window.scrollTo(0, 0),
  openSheet: (slug, opts) => openSheet(slug, opts),
  updateBadge: () => updateBadge(),
  refreshBanners: () => { checkShrink(); renderStatus(); },
  // every tab root has one status slot under its running head; they all show the same line
  statusSlot: el => { statusSlots.add(el); renderStatusInto(el); },
  chrome: () => chrome(),
  lastExport: () => lastExport,
  async recordExport({ at = new Date().toISOString(), count, total }) {
    lastExport = { at, count, total };
    await idbStore.setMeta('lastExport', lastExport);
    checkShrink();
    renderStatus();
  },
  busy: d => { busyCount = Math.max(0, busyCount + d); },
};

// ---------------------------------------------------------------- routes and the tab bar
const tabbar = document.getElementById('tabbar');
const tabButtons = {};
function buildTabbar() {
  tabbar.replaceChildren();
  const lit = resolveRoute(route).tab;
  for (const [k, label, ic] of TABS) {
    const b = h('button', { type: 'button', className: 'tb' + (k === lit ? ' on' : ''), 'aria-label': label, dataset: { tab: k },
      on: { click: () => (k === resolveRoute(route).tab ? reselect() : showRoute(k)) } },
    icon(ic), h('span', { className: 'tb-label', text: label }), k === 'review' ? h('span', { className: 'count', hidden: true }) : null);
    if (k === lit) b.setAttribute('aria-current', 'page');
    tabButtons[k] = b;
    tabbar.append(b);
  }
}
function showRoute(name, { force = false } = {}) {
  const r = resolveRoute(name);
  if (r.name === route && !force) return;
  voice.stop();
  scrollPos[route] = window.scrollY;
  if (route === 'lib' && lib) lib.hide();
  route = r.name;
  for (const s of ['look', 'lib', 'review', 'me']) document.getElementById('tab-' + s).hidden = s !== r.section;
  for (const [k] of TABS) {
    const b = tabButtons[k];
    if (b) { b.classList.toggle('on', k === r.tab); if (k === r.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  }
  const mod = { look, lib, review, me }[r.name];
  if (mod && mod.show && r.name !== 'me') mod.show();
  chrome();
  window.scrollTo(0, scrollPos[route] || 0);
}
function reselect() {
  const a = reselectAction(route);
  if (a.go) { showRoute(a.go); return; }
  if (route === 'lib' && lib.inDetail()) { lib.back(); return; }
  if (route === 'look' && look.isPushed()) { look.back(); return; }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (route === 'look') look.focus();
}
// A pushed word page brings its own action bar, so the tab bar steps aside; so it does during a review round.
function chrome() {
  const pushed = (route === 'look' && look && look.isPushed()) || (route === 'lib' && lib && lib.isPushed());
  document.body.classList.toggle('pushed', !!pushed);
  document.body.classList.toggle('in-session', !!(route === 'review' && review && review.inSession()));
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

// ---------------------------------------------------------------- sheet (the full entry from a flashcard)
// A pushed page with ‹ 复习 and the round's position on the right; back returns to the same card's back face.
const sheet = document.getElementById('sheet');
function openSheet(slug, { session = '' } = {}) {
  const e = words.get(slug);
  if (!e) return;
  closeSheet();
  sheetView = createEntryView(app, { where: 'sheet', back: { label: '复习', onClick: closeSheet }, session, scrollRoot: sheet });
  sheet.replaceChildren(sheetView.el);
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

// ---------------------------------------------------------------- status line, badge
function checkShrink() {
  shrink = shrinkState(words.favorites().length, lastExport);
}
// One quiet line under the running head (design v2): the most important notice only (banners.js pickStatus).
// No backup reminder here (SPEC 2.4): only the red warnings, offline, the update note and the mock modes.
let statusNow = null;
function renderStatus() {
  const online = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
  statusNow = pickStatus(bannerSpecs({ standalone, shrink, mockOffline, mock: !!settings.mock || mockForced, updateReady, online }));
  for (const el of statusSlots) renderStatusInto(el);
}
function renderStatusInto(el) {
  const s = statusNow;
  const actions = { restore: () => app.openMe({ open: 'import' }) };
  el.replaceChildren(...(s ? [h('p', { className: 'status-line' + (s.danger ? ' danger' : ''), role: s.danger ? 'alert' : 'status' },
    icon(s.icon), h('span', { text: s.text }),
    s.btn ? h('button', { type: 'button', className: 'text-btn accent', text: s.btn, on: { click: actions[s.action] } }) : null)] : []));
}

function updateBadge() {
  const n = words.dueCount(settings.newPerDay);
  const b = tabButtons.review && tabButtons.review.querySelector('.count');
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
const isQuiet = () => isIdle() && !(look && look.hasResult()) && !(lib && lib.inDetail());

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
    if (isQuiet()) reloadOnce(); else { updateReady = true; renderStatus(); }
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
  box.replaceChildren(h('div', { className: 'fatal' },
    h('header', { className: 'runhead' }, h('span', { className: 'runhead-title' }, 'Wei', h('span', { className: 'sub', text: ' 的词典' }))),
    h('p', { className: 'status-line danger', role: 'alert' }, icon('alert'), h('span', { text: '打不开本机数据：' + ((err && err.message) || err) })),
    h('p', { className: 'small', text: '上滑关掉 App 再打开。还不行的话，把这句话截图发给 Claude。' }),
    h('div', { className: 'btn-row' }, h('button', { type: 'button', className: 'btn', text: '重新载入', on: { click: () => location.reload() } }))));
}

async function boot() {
  buildTabbar();
  registerSW();
  try {
    const loaded = loadSettings(await idbStore.getMeta('settings'));
    settings = loaded.settings;
    // models never changed in 我 follow DEFAULT_MODELS (SPEC 2.4); if this write fails, the next launch does it again
    if (loaded.migrated) await idbStore.setMeta('settings', settings).catch(e => console.warn('settings migration:', (e && e.message) || e));
    lastExport = (await idbStore.getMeta('lastExport')) || null;
    await words.load();
  } catch (e) {
    console.error(e);
    fatal(e);
    return;
  }
  checkShrink();
  look = createLookTab(app);
  lib = createLibTab(app);
  review = createReviewTab(app);
  me = createMeTab(app);
  renderStatus();
  updateBadge();
  showRoute('look', { force: true });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  speech.onVoices(() => me.onChange());   // iOS lists the system voices a moment after launch
  window.addEventListener('online', renderStatus);
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { voice.stop(); return; }
    voice.clearProblem();   // back in the app: the next tap tries the Qwen voice again
    updateBadge();
    renderStatus();
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
