// 我的 tab (SPEC 2.4): API key, models, switches, voice, import, export backup, storage status, stats.
import { h, icon, toast, ago, fmtBytes, localYmd } from './ui-dom.js';
import { MODEL_CHOICES, VERSION } from './config.js';
import { gzipJSON, parseExportBytes } from './db.js';

const MODEL_ROWS = [['core', '核心释义', '拼写判断、释义、巧记，要快'], ['extras', '扩展讲解', '搭配、同义词、阅读、小测'], ['zh', '中译英', '中文找英文说法']];

export function createMeTab(app) {
  const root = document.getElementById('tab-me');
  root.replaceChildren();
  let prepared = null;     // {file, json, count, total, size}
  let importState = null;  // {name, data, preview} | {done} | {error}

  const group = (title, ...rows) => h('section', { className: 'group-box' }, title ? h('h2', { className: 'group-title', text: title }) : null,
    h('div', { className: 'group-card' }, ...rows));
  const row = (label, sub, right, extra) => h('div', { className: 'set-row' + (extra ? ' col' : '') },
    h('div', { className: 'set-main' }, h('div', { className: 'set-label', text: label }), sub ? h('div', { className: 'set-sub', text: sub }) : null),
    right ? h('div', { className: 'set-right' }, right) : null, extra || null);

  function toggle(on, onChange, { disabled = false, label = '' } = {}) {
    const input = h('input', { type: 'checkbox', className: 'switch', role: 'switch', 'aria-label': label, checked: !!on, disabled });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { className: 'switch-wrap' }, input);
  }

  // ---------------------------------------------------------------- sections
  function keySection() {
    const s = app.settings();
    const has = !!s.apiKey;
    const status = h('span', { className: 'key-mask', text: has ? '····' + s.apiKey.slice(-4) : '还没填' });
    const edit = h('div', { className: 'key-edit', hidden: true });
    const input = h('input', { type: 'password', className: 'field', placeholder: 'sk-…', autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false', 'aria-label': '百炼 API Key' });
    edit.append(input, h('div', { className: 'btn-row' },
      h('button', { type: 'button', className: 'btn primary', text: '保存', on: { click: async () => {
        // chat apps often add invisible characters; any left over would break the request header
        const v = input.value.replace(/[\s​-‍⁠﻿]/g, '');
        if (!v) { toast('先粘贴 Key'); return; }
        if (!/^[\x21-\x7e]+$/.test(v)) { toast('Key 里有不认识的字符，回百炼控制台重新复制一次', 3500); return; }
        await app.saveSettings({ apiKey: v });
        input.value = '';
        toast('Key 已保存在这台手机里');
        render();
      } } }),
      h('button', { type: 'button', className: 'btn', text: '取消', on: { click: () => { input.value = ''; edit.hidden = true; } } }),
      has ? h('button', { type: 'button', className: 'textbtn danger', text: '清除 Key', on: { click: async () => { await app.saveSettings({ apiKey: '' }); toast('已清除'); render(); } } }) : null));
    const btn = h('button', { type: 'button', className: 'btn small-btn', text: has ? '修改' : '填写', on: { click: () => { edit.hidden = !edit.hidden; if (!edit.hidden) input.focus(); } } });
    return group('百炼 API Key',
      row('Key', '只存在这台手机里，不进备份文件', h('div', { className: 'inline' }, status, btn), edit),
      h('p', { className: 'group-note', text: '建议在百炼控制台给这个 Key 只开要用的模型，并设每月预算上限。' }));
  }

  function modelSection() {
    const s = app.settings();
    const forced = app.mockForced();
    return group('模型',
      ...MODEL_ROWS.map(([k, label, sub]) => {
        const cur = s.models[k];
        const sel = h('select', { className: 'select', 'aria-label': label });
        const choices = [...new Set([...MODEL_CHOICES, cur].filter(Boolean))];
        for (const m of choices) sel.append(h('option', { value: m, text: m }));
        sel.append(h('option', { value: '__custom', text: '自己填…' }));
        sel.value = cur;
        const custom = h('div', { className: 'key-edit', hidden: true });
        const ci = h('input', { type: 'text', className: 'field', placeholder: '模型名，比如 qwen-plus-latest', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': '自定义模型名' });
        custom.append(ci, h('div', { className: 'btn-row' },
          h('button', { type: 'button', className: 'btn primary', text: '保存', on: { click: async () => {
            const v = ci.value.trim();
            if (!v) return;
            await app.saveSettings({ models: { ...app.settings().models, [k]: v } });
            toast(`${label}改用 ${v}`);
            render();
          } } }),
          h('button', { type: 'button', className: 'btn', text: '取消', on: { click: () => { custom.hidden = true; sel.value = cur; } } })));
        sel.addEventListener('change', async () => {
          if (sel.value === '__custom') { custom.hidden = false; ci.focus(); return; }
          await app.saveSettings({ models: { ...app.settings().models, [k]: sel.value } });
          toast(`${label}改用 ${sel.value}`);
        });
        return row(label, sub, sel, custom);
      }),
      row('模拟模式', forced ? '地址里带了 ?mock=1，这次打开一直是模拟模式' : '不调百炼，返回假数据（会存进本机词库），只在测试时打开',
        toggle(s.mock || forced, v => app.saveSettings({ mock: v }).then(() => { toast(v ? '已打开模拟模式' : '已关闭模拟模式'); app.refreshBanners(); }), { disabled: forced, label: '模拟模式' })));
  }

  function studySection() {
    const s = app.settings();
    const num = h('span', { className: 'num', text: String(s.newPerDay) });
    const step = d => async () => {
      const v = Math.max(0, Math.min(200, app.settings().newPerDay + d));
      await app.saveSettings({ newPerDay: v });
      num.textContent = String(v);
    };
    const stepper = h('div', { className: 'stepper' },
      h('button', { type: 'button', className: 'step', 'aria-label': '减少', text: '−', on: { click: step(-5) } }), num,
      h('button', { type: 'button', className: 'step', 'aria-label': '增加', text: '+', on: { click: step(5) } }));
    const voices = app.speech.list();
    const vsel = h('select', { className: 'select', 'aria-label': '发音' });
    vsel.append(h('option', { value: '', text: '自动选择' }));
    for (const v of voices) vsel.append(h('option', { value: v.name, text: `${v.name} · ${v.lang}` }));
    vsel.value = voices.some(v => v.name === s.voice) ? s.voice : '';
    vsel.addEventListener('change', () => app.saveSettings({ voice: vsel.value }));
    return group('查词与复习',
      row('先猜再看', '查到收藏过的词时，先想意思再看答案，并记一次复习', toggle(s.guessFirst, v => app.saveSettings({ guessFirst: v }), { label: '先猜再看' })),
      row('每天新词上限', '复习里每天最多出现几个新词', stepper),
      row('发音', app.speech.supported ? (voices.length ? `${voices.length} 个英文语音可选。` : '还没读到系统语音。') + '手机开着静音时可能没声音' : '这个浏览器不支持朗读', vsel,
        h('div', { className: 'btn-row' }, h('button', { type: 'button', className: 'btn small-btn', on: { click: () => app.speech.speak('meticulous. She is meticulous about details.') } }, icon('speak', 'ic ic-s'), '试听'))));
  }

  function dataSection() {
    const le = app.lastExport();
    const st = app.words.stats(app.settings().newPerDay);
    const exportBox = h('div', { className: 'export-box' });
    if (!prepared) {
      exportBox.append(h('button', { type: 'button', className: 'btn primary wide', text: '导出备份', on: { click: prepare } }));
    } else if (prepared.downloaded) {
      // a download gives no signal that a file was saved, so ask before clearing the reminder
      exportBox.append(
        h('p', { className: 'small', text: `已经开始下载“${prepared.file.name}”。确认文件存好了，再点“存好了”。` }),
        h('div', { className: 'btn-row' },
          h('button', { type: 'button', className: 'btn primary', text: '存好了', on: { click: () => exported('download') } }),
          h('button', { type: 'button', className: 'btn', text: '存到“文件”', on: { click: share } }),
          h('button', { type: 'button', className: 'btn', text: '再下载一次', on: { click: () => download(prepared.file) } })));
    } else {
      exportBox.append(
        h('p', { className: 'small', text: `备份文件准备好了：${prepared.file.name}（${fmtBytes(prepared.size)}，${prepared.total} 个词）。在分享面板里选“存储到文件”。` }),
        h('div', { className: 'btn-row' },
          h('button', { type: 'button', className: 'btn primary', text: '存到“文件”', on: { click: share } }),
          h('button', { type: 'button', className: 'btn', text: '改用下载', on: { click: () => download(prepared.file) } })));
    }
    const fileIn = h('input', { type: 'file', className: 'visually-hidden', accept: '.json,.gz,application/json,application/gzip', 'aria-label': '选择导入文件', tabIndex: -1 });
    fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (f) readImport(f); });
    const importBox = h('div', { className: 'import-box' }, fileIn,
      h('button', { type: 'button', className: 'btn wide', text: '导入文件', on: { click: () => fileIn.click() } }));
    if (importState) importBox.append(importCard());
    return group('数据',
      row('备份', le ? `上次：${ago(le.at)}（${le.count} 个收藏）` : '还没备份过。删掉主屏幕图标会删掉全部数据', null, exportBox),
      row('导入', 'Mac 导出的 wordcoach-export 文件或手机备份（.json / .json.gz），合并，不删除任何东西', null, importBox),
      row('存储', storageText, null),
      row('统计', `词库 ${st.library}（新词 ${st.fresh} · 学习中 ${st.learning} · 已掌握 ${st.mastered}）· 最近查过 ${st.cache} · 中译英 ${st.zh} · 复习记录 ${st.reviews} · 查询日志 ${logCount}`, null),
      badgeRow());
  }

  function badgeRow() {
    const can = 'setAppBadge' in navigator && typeof Notification !== 'undefined';
    if (!can) return row('图标角标', '这里不支持（只有从主屏幕打开才有）', null);
    const p = Notification.permission;
    if (p === 'granted') return row('图标角标', '已开启：图标上显示今天还剩几个要复习', null);
    if (p === 'denied') return row('图标角标', '通知被关掉了，到 iPhone 设置 → 通知 里打开', null);
    return row('图标角标', '允许通知后，图标上显示今天还剩几个要复习（不会发通知）',
      h('button', { type: 'button', className: 'btn small-btn', text: '开启', on: { click: () => {
        Notification.requestPermission().then(() => { app.updateBadge(); render(); }, () => {});
      } } }));
  }

  function importCard() {
    const s = importState;
    if (s.error) return h('div', { className: 'err-box' }, h('p', { text: s.error }));
    if (s.busy) return h('p', { className: 'small muted dots', text: s.busy });
    if (s.done) {
      const r = s.done;
      return h('div', { className: 'ok-box' },
        h('p', { text: `导入完成：新增 ${r.added} 个，合并 ${r.merged} 个，${r.unchanged} 个没变化${r.zhAdded ? `，中译英 ${r.zhAdded} 条` : ''}。` }),
        h('p', { className: 'small', text: `词库 ${r.before.library} → ${r.after.library} 个，全部 ${r.before.total} → ${r.after.total} 个。` }));
    }
    const d = s.data, p = s.preview;
    const src = d.source === 'mac' ? 'Mac 上' : d.source === 'phone' ? '手机上' : '';
    return h('div', { className: 'confirm-box' },
      h('p', { className: 'small', text: `“${s.name}”：${src}导出于 ${localYmd(d.exported_at) || '未知日期'}，${p.total} 个词（收藏 ${p.incomingFav} 个），中译英 ${(d.zh || []).length} 条。` }),
      h('p', { className: 'small', text: `导入后：新增 ${p.added} 个，合并 ${p.merged} 个，${p.unchanged} 个没变化${p.skipped ? `，${p.skipped} 条格式不对跳过` : ''}。现在词库 ${p.before.library} 个。导入不会删除任何东西。` }),
      h('div', { className: 'btn-row' },
        h('button', { type: 'button', className: 'btn primary', text: '导入', on: { click: doImport } }),
        h('button', { type: 'button', className: 'btn', text: '取消', on: { click: () => { importState = null; render(); } } })));
  }

  function aboutSection() {
    return group('',
      h('div', { className: 'about' },
        h('p', { text: `Word Coach 网页版 v${VERSION}` }),
        h('p', { className: 'small muted', text: '数据只在这台手机里。永远从主屏幕图标打开；不要删图标再添加，那样会丢掉全部数据。' }),
        h('p', {}, h('a', { href: './check/', className: 'link', text: '设备体检页' }))));
  }

  // ---------------------------------------------------------------- export
  let preparing = false;
  async function prepare() {
    if (preparing) return;
    preparing = true;
    try {
      app.busy(+1);
      toast('正在打包…', 4000);
      const at = new Date();
      const data = await app.words.exportData();
      const gz = await gzipJSON(data);
      const name = `wordcoach-backup-${localYmd(at)}.json.gz`;
      prepared = { file: new File([gz], name, { type: 'application/gzip' }), data, size: gz.byteLength, at: at.toISOString(),
        count: data.entries.filter(e => e.favorited).length, total: data.entries.length };
      render();
      toast('备份文件准备好了');
    } catch (e) {
      toast('打包失败：' + (e.message || e), 4000);
    } finally { preparing = false; app.busy(-1); }
  }
  async function exported(how) {
    if (!prepared) return;
    // the snapshot time, not the share time: the 7-day reminder follows the age of the data in the file
    await app.recordExport({ at: prepared.at, count: prepared.count, total: prepared.total });
    toast(how === 'share' ? '备份好了' : '记下了这次备份');
    prepared = null;
    render();
  }
  function share() {
    const p = prepared;
    if (!p) return;
    const canFiles = files => { try { return !!(navigator.canShare && navigator.canShare({ files })); } catch (e) { return false; } };
    let files = [p.file];
    if (!canFiles(files)) {
      // some browsers refuse .gz in the share sheet; plain JSON is bigger but goes through
      const plain = new File([JSON.stringify(p.data)], p.file.name.replace(/\.gz$/, ''), { type: 'application/json' });
      files = canFiles([plain]) ? [plain] : null;
    }
    if (!files || !navigator.share) { download(p.file); return; }
    navigator.share({ files, title: files[0].name }).then(() => exported('share'), err => {
      if (err && err.name === 'AbortError') toast('取消了，还没保存');
      // no automatic download here: the tap is used up, and iOS may silently drop it
      else toast('没存成：' + ((err && err.message) || err) + '。可以点“改用下载”', 4000);
    });
  }
  function download(file) {
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: file.name, className: 'visually-hidden' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
    if (prepared) prepared.downloaded = true;
    render();
  }

  // ---------------------------------------------------------------- import
  async function readImport(file) {
    importState = { busy: `正在读“${file.name}”` };
    render();
    try {
      const data = await parseExportBytes(await file.arrayBuffer());
      const preview = await app.words.previewImport(data);
      importState = { name: file.name, data, preview };
    } catch (e) {
      importState = { error: '导入失败：' + (e.message || e) };
    }
    render();
  }
  async function doImport() {
    const s = importState;
    if (!s || !s.data) return;
    importState = { busy: '正在导入，词多的话要十几秒' };
    render();
    app.busy(+1);
    try {
      const r = await app.words.importData(s.data);
      importState = { done: r };
      toast('导入完成');
      app.refreshBanners();
      app.updateBadge();
    } catch (e) {
      importState = { error: '导入失败：' + (e.message || e) };
    } finally { app.busy(-1); }
    render();
  }

  // ---------------------------------------------------------------- storage + render
  let storageText = '检查中…';
  let logCount = 0;
  async function refreshStorage() {
    const parts = [];
    try {
      if (navigator.storage && navigator.storage.persisted) parts.push((await navigator.storage.persisted()) ? '已获得持久存储' : '没有持久存储（从主屏幕打开时通常会有）');
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        parts.push(`已用 ${fmtBytes(est.usage || 0)}` + (est.quota ? ` / 可用 ${fmtBytes(est.quota)}` : ''));
      }
    } catch (e) { parts.push('读不到存储状态'); }
    storageText = parts.join(' · ') || '这个浏览器不提供存储状态';
    try { logCount = await app.store.countLog(); } catch (e) { /* ignore */ }
  }

  function render() {
    root.replaceChildren(
      h('header', { className: 'tab-head' }, h('h1', { text: '我的' })),
      keySection(), modelSection(), studySection(), dataSection(), aboutSection());
  }

  const typing = () => root.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  let changeTimer = 0;
  render();
  return {
    show() { refreshStorage().then(() => { if (!typing()) render(); }); },
    onChange() {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => { if (app.currentTab() === 'me' && !(importState && importState.busy) && !typing()) render(); }, 200);
    },
    startExport() { app.showTab('me'); prepare(); },   // always fresh data
    // something on this tab would be lost by an automatic reload
    holding: () => !!prepared || preparing || !!(importState && (importState.data || importState.busy)),
  };
}
