// 我的 tab (SPEC 2.4): API key, models, switches, pronunciation, import, export backup, storage status, stats.
import { h, icon, toast, ago, fmtBytes, localYmd } from './ui-dom.js';
import { MODEL_CHOICES, VERSION, TTS_VOICES, TTS_MODEL } from './config.js';
import { gzipJSON, parseExportBytes } from './db.js';

const SAMPLE = 'meticulous. She is meticulous about details.';
const MODEL_ROWS = [['core', '核心释义', '拼写判断、释义、巧记，要快'], ['extras', '扩展讲解', '搭配、同义词、阅读、小测'], ['zh', '中译英', '中文找英文说法']];

export function createMeTab(app) {
  const root = document.getElementById('tab-me');
  root.replaceChildren();
  let prepared = null;     // {file, json, count, total, size}
  let importState = null;  // {name, data, preview} | {done} | {error}
  let speed = null;        // speed test: {running, results: [...]} | {error}
  let speedBox = null;     // where the speed test draws (rebuilt by every render)

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
    speedBox = h('div', { className: 'speed-box' });
    paintSpeed();
    return group('模型',
      ...MODEL_ROWS.map(([k, label, sub]) => {
        const cur = s.models[k];
        const sel = h('select', { className: 'select', 'aria-label': label });
        const ids = MODEL_CHOICES.map(c => c.id);
        for (const m of [...new Set([...ids, cur].filter(Boolean))]) {
          const c = MODEL_CHOICES.find(x => x.id === m);
          sel.append(h('option', { value: m, text: c ? `${m} · ${c.label}` : m }));
        }
        sel.append(h('option', { value: '__custom', text: '自己填…' }));
        sel.value = cur;
        const custom = h('div', { className: 'key-edit', hidden: true });
        const ci = h('input', { type: 'text', className: 'field', placeholder: '模型名，比如 qwen-plus-latest', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': '自定义模型名' });
        // modelsChosen: from now on this profile keeps its models when a new version changes the defaults
        const pick = async v => {
          await app.saveSettings({ models: { ...app.settings().models, [k]: v }, modelsChosen: true });
          toast(`${label}改用 ${v}`);
        };
        custom.append(ci, h('div', { className: 'btn-row' },
          h('button', { type: 'button', className: 'btn primary', text: '保存', on: { click: async () => {
            const v = ci.value.trim();
            if (!v) return;
            await pick(v);
            render();
          } } }),
          h('button', { type: 'button', className: 'btn', text: '取消', on: { click: () => { custom.hidden = true; sel.value = cur; } } })));
        sel.addEventListener('change', async () => {
          if (sel.value === '__custom') { custom.hidden = false; ci.focus(); return; }
          await pick(sel.value);
        });
        return row(label, sub, null, h('div', { className: 'model-pick' }, sel, custom));
      }),
      h('div', { className: 'set-row' }, speedBox),
      row('模拟模式', forced ? '地址里带了 ?mock=1，这次打开一直是模拟模式' : '不调百炼，返回假数据（会存进本机词库），只在测试时打开',
        toggle(s.mock || forced, v => app.saveSettings({ mock: v }).then(() => { toast(v ? '已打开模拟模式' : '已关闭模拟模式'); app.refreshBanners(); }), { disabled: forced, label: '模拟模式' })));
  }

  // Speed test (SPEC 2.4): each model once with the saved key, one after another; nothing is stored.
  async function runSpeed() {
    if (speed && speed.running) return;   // a second tap while it runs does nothing
    speed = { running: true, results: [] };
    paintSpeed();
    try {
      await app.ai.speedTest({ onResult: r => { if (speed && speed.results) { speed.results.push(r); paintSpeed(); } } });
      speed.running = false;
    } catch (e) {
      speed = { error: (e && e.message) || String(e) };
    }
    paintSpeed();
  }
  function paintSpeed() {
    if (!speedBox) return;
    const st = speed || {};
    // replaceChildren would print a null as text, so the optional parts are filtered out
    speedBox.replaceChildren(...[
      h('p', { className: 'set-sub', text: '每个模型查一次，总共不到 5 分钱' }),
      h('button', { type: 'button', className: 'textbtn speed-btn', text: st.running ? '正在测…' : '测一下速度', disabled: !!st.running,
        'aria-busy': st.running ? 'true' : null, on: { click: runSpeed } }),
      st.error ? h('p', { className: 'speed-err', role: 'alert', text: st.error }) : null,
      st.results ? speedList(st) : null].filter(Boolean));
  }
  function speedList(st) {
    const done = st.results;
    const good = r => r.ok && r.json;
    // the fastest model whose reply came back as valid JSON, once every model has been tried
    const best = st.running ? null : done.filter(good).sort((a, b) => a.ms - b.ms)[0] || null;
    return h('div', { className: 'speed-result' },
      h('ul', { className: 'speed-list', 'aria-live': 'polite' },
        ...MODEL_CHOICES.map((c, i) => {
          const r = done.find(x => x.id === c.id);
          const sub = h('span', { className: 'speed-sub', text: `${c.label} · ${c.note}` });
          if (!r) {
            const now = st.running && i === done.length;
            return h('li', { className: 'speed-item' + (now ? ' now' : ' wait') },
              h('span', { className: 'speed-id', text: c.id }), h('span', { className: 'speed-val muted' + (now ? ' dots' : ''), text: now ? '正在测' : '等待' }), sub);
          }
          return h('li', { className: 'speed-item' + (r === best ? ' best' : '') },
            h('span', { className: 'speed-id' }, c.id, r === best ? h('span', { className: 'tag', text: '最快' }) : null),
            h('span', { className: 'speed-val' + (good(r) ? '' : ' bad'), text: `${(r.ms / 1000).toFixed(1)} 秒 · ${good(r) ? 'JSON 正常' : r.ok ? 'JSON 出错' : '出错'}` }),
            sub,
            r.error ? h('span', { className: 'speed-err', text: r.error }) : null);
        })),
      h('p', { className: 'speed-foot', text: '价格是每百万 tokens 的输入 / 输出' }));
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
    return group('查词与复习',
      row('先猜再看', '查到收藏过的词时，先想意思再看答案，并记一次复习', toggle(s.guessFirst, v => app.saveSettings({ guessFirst: v }), { label: '先猜再看' })),
      row('每天新词上限', '复习里每天最多出现几个新词', stepper),
      voiceRow(),
      dictRow(),
      h('p', { className: 'group-note', text: '基础释义来自开源词典 ECDICT（MIT 协议）' }));
  }

  // Pronunciation (SPEC 2.4): Qwen voice or system voice; the default follows whether a key is set.
  function voiceRow() {
    const s = app.settings();
    const mode = app.voice.mode();
    const canQwen = !!s.apiKey || !!s.mock || app.mockForced();
    const choice = (val, title, sub) => h('button', { type: 'button', className: 'choice' + (mode === val ? ' on' : ''), role: 'radio',
      'aria-checked': String(mode === val), on: { click: async () => { if (mode === val) return; app.voice.stop(); await app.saveSettings({ voiceMode: val }); render(); } } },
    h('span', { className: 'choice-dot', 'aria-hidden': 'true' }),
    h('span', { className: 'choice-main' }, h('span', { className: 'choice-title', text: title }), h('span', { className: 'choice-sub', text: sub })));
    let picker;
    if (mode === 'qwen') {
      picker = h('select', { className: 'select', 'aria-label': '千问音色' });
      for (const [name, cn] of TTS_VOICES) picker.append(h('option', { value: name, text: `${name} · ${cn}` }));
      picker.value = TTS_VOICES.some(v => v[0] === s.qwenVoice) ? s.qwenVoice : TTS_VOICES[0][0];
      picker.addEventListener('change', () => { app.voice.stop(); app.saveSettings({ qwenVoice: picker.value }); });
    } else {
      const voices = app.speech.list();
      picker = h('select', { className: 'select', 'aria-label': '系统语音' });
      picker.append(h('option', { value: '', text: voices.length ? '自动选择' : '自动选择（还没读到语音）' }));
      for (const v of voices) picker.append(h('option', { value: v.name, text: `${v.name} · ${v.lang}` }));
      picker.value = voices.some(v => v.name === s.voice) ? s.voice : '';
      picker.addEventListener('change', () => app.saveSettings({ voice: picker.value }));
    }
    // 试听 always tries the Qwen voice again, even while it is paused after a failure
    const test = h('button', { type: 'button', className: 'btn small-btn say-test', on: { click: ev => app.say(SAMPLE, ev.currentTarget, { retry: true }) } }, icon('speak', 'ic ic-s'), '试听');
    let note;
    const problem = mode === 'qwen' && canQwen ? app.voice.problem() : null;
    if (problem) note = problem.message;
    else if (mode === 'qwen') {
      note = canQwen ? `按字数计费，一个词不到 0.001 元；听过的存在手机里，再听不花钱${audioCount ? `（已存 ${audioCount} 段）` : ''}。Key 要开通 ${TTS_MODEL}。`
        : '还没填百炼 Key，现在先用系统语音。';
    } else note = app.speech.supported ? '' : '这个浏览器不支持系统语音。';
    return row('发音', null, null, h('div', { className: 'voice-box' },
      h('div', { className: 'choices', role: 'radiogroup', 'aria-label': '发音' },
        choice('qwen', '千问语音', '静音也能播，音质好，花费很少'),
        choice('system', '系统语音', '免费，静音时没声音')),
      h('div', { className: 'voice-pick' }, picker, test),
      note ? h('p', { className: 'set-sub', text: note }) : null));
  }

  function dictRow() {
    const st = app.dict.status();
    if (st.state === 'ready') {
      return row('离线词典', '已载入。查词时先显示基础释义，没网也能看', h('span', { className: 'set-val', text: `${st.words.toLocaleString('zh-CN')} 个词` }));
    }
    if (st.state === 'error') {
      // app.js already words network failures in Chinese; anything else in English gets a plain line
      const why = m => (/[一-鿿]/.test(String(m)) ? String(m) : '网络不通，连上网后点“重试”');
      return row('离线词典', '没载入：' + why(st.error), h('button', { type: 'button', className: 'btn small-btn', text: '重试', on: { click: () => {
        app.dict.load().then(() => toast('离线词典已载入'), e => toast('还是没载入：' + why((e && e.message) || e), 3000)).finally(render);
        render();
      } } }));
    }
    return row('离线词典', '查词时先显示基础释义，没网也能看', h('span', { className: 'set-val muted', text: '正在载入…' }));
  }

  function dataSection() {
    const le = app.lastExport();
    const st = app.words.stats(app.settings().newPerDay);
    const exportBox = h('div', { className: 'export-box' });
    if (!prepared || prepared.carry) {
      exportBox.append(h('button', { type: 'button', className: 'btn primary wide', text: '导出备份', disabled: !!prepared, on: { click: () => prepare(false) } }));
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
      row('备份', le ? `上次备份：${ago(le.at)}（${le.count} 个收藏）` : '上次备份：还没有', null, exportBox),
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
        h('p', { className: 'small', text: `词库 ${r.before.library} → ${r.after.library} 个，全部 ${r.before.total} → ${r.after.total} 个。` }),
        r.carried ? h('p', { className: 'small', text: `百炼 Key 和设置也带过来了。确认词都在以后，就可以删掉旧的图标了。` }) : null);
    }
    const d = s.data, p = s.preview;
    const src = d.source === 'mac' ? 'Mac 上' : d.source === 'phone' ? '手机上' : '';
    return h('div', { className: 'confirm-box' },
      h('p', { className: 'small', text: `“${s.name}”：${src}导出于 ${localYmd(d.exported_at) || '未知日期'}，${p.total} 个词（收藏 ${p.incomingFav} 个），中译英 ${(d.zh || []).length} 条。` }),
      h('p', { className: 'small', text: `导入后：新增 ${p.added} 个，合并 ${p.merged} 个，${p.unchanged} 个没变化${p.skipped ? `，${p.skipped} 条格式不对跳过` : ''}。现在词库 ${p.before.library} 个。导入不会删除任何东西。` }),
      carryNote(d.carry),
      h('div', { className: 'btn-row' },
        h('button', { type: 'button', className: 'btn primary', text: '导入', on: { click: doImport } }),
        h('button', { type: 'button', className: 'btn', text: '取消', on: { click: () => { importState = null; render(); } } })));
  }

  function aboutSection() {
    return group('',
      h('div', { className: 'about' },
        h('p', { text: `Wei 的词典 v${VERSION}` }),
        h('p', { className: 'small muted', text: '数据只在这台手机里。永远从主屏幕图标打开。要换图标，先用“搬到新图标”把数据带过去，再删旧图标。' }),
        h('p', {}, h('a', { href: './check/', className: 'link', text: '设备体检页' }))));
  }

  // ---------------------------------------------------------------- move to a new Home Screen icon
  // Each Home Screen icon keeps its own data. Changing the icon or the name means adding a new icon and moving the data.
  const CARRY_KEYS = ['models', 'modelsChosen', 'guessFirst', 'newPerDay', 'voiceMode', 'qwenVoice', 'voice'];
  function carryFrom(s) {
    const settings = {};
    for (const k of CARRY_KEYS) if (s[k] !== undefined) settings[k] = s[k];
    return { apiKey: s.apiKey || '', settings };
  }
  function carryNote(c) {
    if (!c || typeof c !== 'object') return null;
    const k = typeof c.apiKey === 'string' && c.apiKey ? `百炼 Key（····${c.apiKey.slice(-4)}）和设置` : '设置';
    return h('p', { className: 'small', text: app.settings().apiKey ? `文件里带着${k}。这里已经有 Key，保留这里的。` : `文件里带着${k}，会一起放进来。` });
  }
  // Only fills an empty icon: an existing key and settings are never overwritten.
  async function applyCarry(c) {
    if (!c || typeof c !== 'object' || app.settings().apiKey) return false;
    const patch = {};
    if (typeof c.apiKey === 'string' && /^[\x21-\x7e]{8,200}$/.test(c.apiKey)) patch.apiKey = c.apiKey;
    const st = c.settings && typeof c.settings === 'object' ? c.settings : {};
    for (const k of CARRY_KEYS) if (st[k] !== undefined) patch[k] = st[k];
    if (!Object.keys(patch).length) return false;
    await app.saveSettings(patch);
    return true;
  }
  function moveSection() {
    const box = h('div', { className: 'export-box' });
    if (prepared && prepared.carry) {
      box.append(h('p', { className: 'small', text: `搬家文件准备好了：${prepared.file.name}（${prepared.total} 个词）。点“存到“文件””，在分享面板里选“存储到文件”。这个文件里有你的百炼 Key，只用来搬家，别发给别人。` }),
        h('div', { className: 'btn-row' },
          h('button', { type: 'button', className: 'btn primary', text: '存到“文件”', on: { click: share } }),
          prepared.downloaded
            ? h('button', { type: 'button', className: 'btn', text: '存好了', on: { click: () => exported('download') } })
            : h('button', { type: 'button', className: 'btn', text: '改用下载', on: { click: () => download(prepared.file) } })));
    } else {
      box.append(h('button', { type: 'button', className: 'btn primary wide', text: '第一步：打包我的数据', on: { click: () => prepare(true) } }));
    }
    return group('搬到新图标',
      row('为什么要搬', '主屏幕上每个图标的数据是分开存的。换图标或名字，要先添加新图标，再把数据搬过去。', null),
      row('第一步（在旧图标里）', '打包词库、复习进度、笔记，连同百炼 Key 和设置，存进“文件”App。', null, box),
      row('第二步（在新图标里）', '打开新图标 → 我的 → 导入文件，选刚才的 wordcoach-move 文件。Key 和设置会一起放进来，不用重填。', null),
      row('第三步', '在新图标里确认词都在，再删掉旧图标。', null));
  }

  // ---------------------------------------------------------------- export
  let preparing = false;
  async function prepare(carry = false) {
    if (preparing) return;
    preparing = true;
    try {
      app.busy(+1);
      toast('正在打包…', 4000);
      const at = new Date();
      const data = await app.words.exportData();
      // the move file also takes the key and settings, so the new icon works without typing anything
      if (carry === true) data.carry = carryFrom(app.settings());
      const gz = await gzipJSON(data);
      const name = carry === true ? `wordcoach-move-${localYmd(at)}.json.gz` : `wordcoach-backup-${localYmd(at)}.json.gz`;
      prepared = { file: new File([gz], name, { type: 'application/gzip' }), data, size: gz.byteLength, at: at.toISOString(),
        count: data.entries.filter(e => e.favorited).length, total: data.entries.length, carry: carry === true };
      render();
      toast('备份文件准备好了');
    } catch (e) {
      toast('打包失败：' + (e.message || e), 4000);
    } finally { preparing = false; app.busy(-1); }
  }
  async function exported(how) {
    if (!prepared) return;
    // the snapshot time, not the share time: “上次备份” and the shrink check follow the data in the file
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
      r.carried = await applyCarry(s.data.carry);
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
  let audioCount = 0;
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
    try { audioCount = await app.store.countAudio(); } catch (e) { /* ignore */ }
  }

  function render() {
    root.replaceChildren(
      h('header', { className: 'tab-head' }, h('h1', { text: '我的' })),
      keySection(), modelSection(), studySection(), moveSection(), dataSection(), aboutSection());
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
    // something on this tab would be lost by an automatic reload
    holding: () => !!prepared || preparing || !!(importState && (importState.data || importState.busy)) || !!(speed && speed.running),
  };
}
