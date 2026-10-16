// Top banners (SPEC 2.4). Only real dangers and states worth knowing; no backup reminder (Wei, 2026-10-16:
// the yellow 7-day banner showed all the time and got in the way). The last backup date is a quiet line in 我的.
import { SHRINK_RATIO } from './config.js';

// The library shrank by 20% or more since the last backup: data may be lost.
export function shrinkState(favCount, lastExport, ratio = SHRINK_RATIO) {
  return lastExport && lastExport.count > 0 && favCount < lastExport.count * ratio ? { now: favCount, then: lastExport.count } : null;
}

// -> [{kind: 'fail' | 'info', text, btn?, action?}]; action names what app.js does on the button.
export function bannerSpecs({ standalone = true, shrink = null, mockOffline = false, mock = false, updateReady = false } = {}) {
  const out = [];
  if (!standalone) out.push({ kind: 'fail', text: '现在是在 Safari 标签页里：这里的数据和主屏幕 App 是两份。请从主屏幕图标打开。' });
  if (shrink) out.push({ kind: 'fail', text: `数据可能丢了：词库现在 ${shrink.now} 个词，上次备份时有 ${shrink.then} 个。请从备份恢复。`, btn: '去恢复', action: 'restore' });
  if (mockOffline) out.push({ kind: 'info', text: '模拟断网：每次调用都按连不上百炼处理。' });
  else if (mock) out.push({ kind: 'info', text: '模拟模式：返回的是假数据，不调百炼。' });
  if (updateReady) out.push({ kind: 'info', text: '新版本已经下载好，下次打开生效。' });
  return out;
}
