// Notices at the top (SPEC 2.4). Only real dangers and states worth knowing; no backup reminder (Wei, 2026-10-16:
// the yellow 7-day banner showed all the time and got in the way). The last backup date is a quiet line in 我.
// v0.5 (design v2): every notice goes into ONE quiet status line under the running head; pickStatus() chooses which.
import { SHRINK_RATIO } from './config.js';

// The library shrank by 20% or more since the last backup: data may be lost.
export function shrinkState(favCount, lastExport, ratio = SHRINK_RATIO) {
  return lastExport && lastExport.count > 0 && favCount < lastExport.count * ratio ? { now: favCount, then: lastExport.count } : null;
}

// -> [{id, kind: 'fail' | 'info', text, btn?, action?}], most important first; action names what app.js does on the button.
export function bannerSpecs({ standalone = true, shrink = null, mockOffline = false, mock = false, updateReady = false, online = true } = {}) {
  const out = [];
  if (shrink) out.push({ id: 'shrink', kind: 'fail', text: `数据可能丢了：现在 ${shrink.now} 个词，上次备份时 ${shrink.then} 个。`, btn: '去恢复', action: 'restore' });
  if (!standalone) out.push({ id: 'safari', kind: 'fail', text: '这是 Safari 标签页，数据和主屏幕图标里的是两份。' });
  if (!online) out.push({ id: 'offline', kind: 'info', text: '没连上网络，只能查离线词典' });
  if (updateReady) out.push({ id: 'update', kind: 'info', text: '新版本已经下载好，下次打开生效。' });
  if (mockOffline) out.push({ id: 'mock-offline', kind: 'info', text: '模拟断网：每次调用都按连不上百炼处理' });
  else if (mock) out.push({ id: 'mock', kind: 'info', text: '模拟模式：返回假数据，不调百炼' });
  return out;
}

// Which notice the one status line shows, in this order: lost data, a Safari tab, offline, a new version, mock modes.
// Only the lost-data warning is red (danger); the rest are quiet muted text in the same slot. `more` counts the others.
export const STATUS_ORDER = ['shrink', 'safari', 'offline', 'update', 'mock-offline', 'mock'];
export const STATUS_ICON = { shrink: 'alert', safari: 'phone', offline: 'offline', update: 'refresh', 'mock-offline': 'offline', mock: 'info' };
export function pickStatus(specs = []) {
  const rank = s => { const i = STATUS_ORDER.indexOf(s.id); return i < 0 ? STATUS_ORDER.length : i; };
  const list = specs.slice().sort((a, b) => rank(a) - rank(b));
  if (!list.length) return null;
  const top = list[0];
  return { ...top, icon: STATUS_ICON[top.id] || 'info', danger: top.id === 'shrink', more: list.length - 1 };
}
