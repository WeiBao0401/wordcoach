// 查词 tab (design v2 4.1): one empty headword line near the optical centre; on focus it rises so the typeahead rows
// sit above the keyboard. 粘贴 and 加原句 are text buttons; 最近查过 is folded at the bottom.
// A lookup pushes a word page (‹ 查词): three tiers (tier 1 from the offline dictionary), the dictionary fallback
// when the model cannot be reached, typo / invalid messages back on the line, Chinese -> English options.
import { h, icon, toast, skBars } from './ui-dom.js';
import { createEntryView, renderZh, dictHead, pageShell, headwordNode, skSenses } from './ui-entry.js';
import { classifyPaste, isChinese, normalizeQuery, hasExtras } from './words.js';
import { marked } from './ui-dom.js';

const CTX_HINT_EN = '粘贴你看到它的原句，解释会贴着这句话讲';
const CTX_HINT_ZH = '使用场景，比如“工作邮件里”“跟老板汇报”';
const SUG_RE = /^[A-Za-z][A-Za-z '’.-]*$/;   // typeahead only for English letters
const SETTINGS_CODES = ['nokey', 'badkey', 'model', 'forbidden', 'truncated'];

export function createLookTab(app) {
  const root = document.getElementById('tab-look');
  root.replaceChildren();

  // ---------------------------------------------------------------- home DOM
  const cancelBtn = h('button', { type: 'button', className: 'text-btn accent cancel', text: '取消' });
  const statusSlot = h('div', { className: 'status-slot' });
  const runhead = h('header', { className: 'runhead' },
    h('span', { className: 'runhead-title' }, 'Wei', h('span', { className: 'sub', text: ' 的词典' })),
    h('span', { className: 'runhead-meta' }, cancelBtn));
  const qEl = h('input', { id: 'q', type: 'text', className: 'qin', placeholder: '查一个词', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': '查一个词，英文或中文',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': 'q-sugs', 'aria-expanded': 'false' });
  const clearBtn = h('button', { type: 'button', className: 'clear', 'aria-label': '清空' }, icon('close'));
  // .inked under the field brings back the highlighter under typed text (off: design v2 decision)
  const form = h('form', { className: 'qfield', role: 'search', autocomplete: 'off' }, qEl, clearBtn);
  const pasteBtn = h('button', { type: 'button', className: 'text-btn paste' }, icon('paste'), '粘贴');
  const ctxLabel = h('span', { text: '加原句' });
  const ctxToggle = h('button', { type: 'button', className: 'text-btn ctx-toggle', 'aria-expanded': 'false' }, icon('quotePlus'), ctxLabel);
  const actions = h('div', { className: 'look-actions' }, pasteBtn, ctxToggle);
  const ctxEl = h('textarea', { id: 'ctx', className: 'ctx-in', rows: 2, placeholder: CTX_HINT_EN, enterkeyhint: 'search', 'aria-label': '原句' });
  const ctxCap = h('span', { className: 'label', text: '原句（可选）' });
  const ctxWrap = h('label', { className: 'ctx-wrap', hidden: true }, ctxCap, ctxEl);
  const msgEl = h('div', { className: 'look-msg', role: 'status', 'aria-live': 'polite' });
  const candEl = h('div', { className: 'cands', hidden: true });
  const sugEl = h('div', { className: 'sugs', id: 'q-sugs', role: 'listbox', 'aria-label': '联想词', hidden: true });
  const entryBlock = h('section', { className: 'look-entry', 'aria-label': '查词' }, form, actions, ctxWrap, msgEl, candEl, sugEl);
  const foldNum = h('span', { className: 'num' });
  const foldBtn = h('button', { type: 'button', className: 'fold', 'aria-expanded': 'false', 'aria-controls': 'recent-list' },
    h('span', {}, '最近查过 ', foldNum, ' 个'), icon('plus', 'plus'), icon('minus', 'minus'));
  const recentList = h('div', { className: 'recent-list', id: 'recent-list' });
  const recentBox = h('section', { className: 'recent', 'aria-label': '最近查过' }, foldBtn, recentList);
  const stage = h('div', { className: 'look-stage' }, entryBlock, recentBox);
  const home = h('div', { className: 'look-home boot' }, runhead, statusSlot, stage);
  const page = h('div', { className: 'look-page', hidden: true });
  root.append(home, page);
  app.statusSlot(statusSlot);
  setTimeout(() => home.classList.remove('boot'), 1000);

  // ---------------------------------------------------------------- state
  let view = null;          // EntryView on screen
  let shell = null;         // the other pushed pages (loading, error, fallback, zh)
  let zhLast = null;        // last Chinese -> English result, for "回到中文"
  let seq = 0;
  let ctrl = null;
  let busy = false;
  let recentOpen = false;

  // ---------------------------------------------------------------- home state
  function sync() {
    const focus = document.activeElement === qEl;
    const has = !!qEl.value;
    const sugs = !sugEl.hidden;
    const extra = !ctxWrap.hidden || !!msgEl.firstChild || !candEl.hidden;
    if (focus && recentOpen) setRecent(false);
    home.classList.toggle('focus', focus);
    home.classList.toggle('typing', sugs);
    home.classList.toggle('has-value', has);
    home.classList.toggle('raised', focus || has || extra || recentOpen);
    home.classList.toggle('recent-open', recentOpen);
    cancelBtn.hidden = !(focus || has || extra);
    stage.style.setProperty('--rtop', (entryBlock.offsetTop + entryBlock.offsetHeight + 20) + 'px');
  }
  function setRecent(on) {
    recentOpen = on;
    foldBtn.setAttribute('aria-expanded', String(on));
    recentList.inert = !on;
    sync();
  }

  function setMsg(text, kind = '', extra = null) {
    msgEl.className = 'look-msg' + (kind ? ' ' + kind : '');
    msgEl.replaceChildren();
    if (text) msgEl.append(h('p', { text }));
    if (extra) msgEl.append(extra);
    sync();
  }
  function syncCtxUI() {
    const zh = isChinese(qEl.value);
    ctxLabel.textContent = zh ? '加场景' : '加原句';
    ctxCap.textContent = zh ? '使用场景（可选）' : '原句（可选）';
    ctxEl.placeholder = zh ? CTX_HINT_ZH : CTX_HINT_EN;
    ctxEl.setAttribute('aria-label', zh ? '使用场景' : '原句');
    ctxToggle.classList.toggle('on', !!ctxEl.value.trim());
    clearBtn.hidden = !qEl.value;
  }
  function openCtx(on) {
    ctxWrap.hidden = !on;
    ctxToggle.setAttribute('aria-expanded', String(on));
    sync();
  }
  function clearCtx() { ctxEl.value = ''; ctxEl.style.height = ''; openCtx(false); syncCtxUI(); }
  function clearCands() { candEl.hidden = true; candEl.replaceChildren(); sync(); }

  // Long words step the size down (44 -> 34 -> 28) instead of scrolling, measured with the input's own font.
  const measure = typeof document.createElement('canvas').getContext === 'function' ? document.createElement('canvas').getContext('2d') : null;
  function fit() {
    qEl.classList.remove('fs-34', 'fs-28');
    if (!measure || !qEl.value) return;
    const cs = getComputedStyle(qEl);
    const room = qEl.clientWidth - 4;
    const width = fs => { measure.font = `${cs.fontWeight} ${fs}px ${cs.fontFamily}`; return measure.measureText(qEl.value).width - qEl.value.length * 0.02 * fs; };
    if (width(44) <= room) return;
    qEl.classList.add(width(34) > room ? 'fs-28' : 'fs-34');
  }

  // ---------------------------------------------------------------- pushed pages
  function clearPage() {
    if (view) { app.unregisterView(view); view.destroy(); view = null; }
    if (shell) { shell.destroy(); shell = null; }
    page.replaceChildren();
  }
  function push(node) {
    page.replaceChildren(node);
    if (!page.hidden) { window.scrollTo(0, 0); return; }
    home.hidden = true;
    page.hidden = false;
    app.chrome();
    window.scrollTo(0, 0);
  }
  // back to the line; keep: leave the query on the line (a typo message is shown there)
  function pop({ keep = false } = {}) {
    clearPage();
    page.hidden = true;
    home.hidden = false;
    if (!keep) { qEl.value = ''; clearCands(); setMsg(''); }
    fit();
    syncCtxUI();
    sync();
    app.chrome();
    window.scrollTo(0, 0);
  }
  function back() {
    seq++;
    if (ctrl) ctrl.abort();
    busy = false;
    app.voice.stop();
    pop();
  }
  const BACK = { label: '查词', onClick: back };

  // a fixed bar for pages that are not a word yet: 发音, one primary button, 笔记 (greyed)
  function stubBar(sh, word, primary) {
    sh.bar.replaceChildren(h('div', { className: 'bar-main' },
      h('button', { type: 'button', className: 'text-btn', disabled: !word, on: { click: ev => app.say(word, ev.currentTarget) } }, icon('speak'), '发音'),
      h('button', { type: 'button', className: 'btn', disabled: !!primary.disabled, on: { click: primary.onClick || null } }, icon(primary.icon), primary.label),
      h('button', { type: 'button', className: 'text-btn', disabled: true }, icon('note'), '笔记')));
  }

  function showEntry(e, opts = {}) {
    clearPage();
    const v = createEntryView(app, { where: 'look', back: BACK });
    view = v;
    app.registerView(v);
    v.show(e, opts);
    push(v.el);
    if (!hasExtras(e) || e.needs_core) app.words.enrich(e.slug).catch(() => {});
  }

  function showZh(d) {
    clearPage();
    shell = pageShell(app, { back: BACK });
    shell.barEl.hidden = true;
    shell.el.classList.add('no-bar');
    shell.body.append(renderZh(app, d, { onPick: (en, fromCn) => run(en, { fromCn, context: '' }) }));
    push(shell.el);
  }

  // Tier 1: the dictionary meaning while the model works. Not for a word that comes straight back from the
  // library, and never the meaning of a favorited word while “先猜再看” is on.
  function tier1(q, opts) {
    if (isChinese(q) || opts.force || app.words.resolve(q)) return null;
    const d = app.dict.find(q);
    if (!d) return null;
    const known = app.words.resolve(d.word);
    return known && known.favorited && app.settings().guessFirst ? null : d;
  }

  function loadingPage(q, d, context) {
    clearPage();
    shell = pageShell(app, { back: BACK });
    const b = shell.body;
    b.setAttribute('aria-busy', 'true');
    if (isChinese(q)) {
      shell.barEl.hidden = true;
      shell.el.classList.add('no-bar');
      b.append(h('section', { className: 'ehead zh-head' }, h('p', { className: 'label', text: '中文 → 英文' }), h('h1', { className: 'zh-q', text: q })),
        h('section', { className: 'sec' }, h('h2', { className: 'sec-h' }, '英文说法', h('span', { className: 'st', text: '正在找' })), skSenses()));
      push(shell.el);
      return;
    }
    b.append(d ? dictHead(app, d, { levelSkeleton: true })
      : h('section', { className: 'ehead' }, headwordNode({ headword: q }), h('p', { className: 'hw-meta' }, h('span', { className: 'pill', 'aria-hidden': 'true' })),
        h('div', { className: 'brief' }, skBars([46]))));
    b.append(h('section', { className: 'sec' }, h('h2', { className: 'sec-h' }, '释义', h('span', { className: 'st', text: '正在写讲解' })), skSenses()));
    if (context) {
      b.append(h('section', { className: 'sec' }, h('h2', { className: 'sec-h', text: '你遇到它的地方' }),
        h('div', { className: 'hang ctx' }, h('span', { className: 'qmark', lang: 'en', 'aria-hidden': 'true', text: '“' }),
          h('div', {}, h('p', { className: 'quote', lang: 'en' }, marked(context, d ? d.word : q)))),
        h('div', { className: 'ctx-note' }, skBars([96, 52]))));
    }
    b.append(h('section', { className: 'sec' }, h('h2', { className: 'sec-h', text: '巧记' }), h('div', { className: 'mnemo' }, skBars([94, 88, 40]))));
    stubBar(shell, d ? d.word : q, { label: '划进词库', icon: 'pen', disabled: true });
    push(shell.el);
  }

  // The model failed (offline, no key, error). With the dictionary's meaning when it knows the word. Nothing is stored.
  function failPage(q, d, err, retry) {
    clearPage();
    shell = pageShell(app, { back: BACK });
    const code = err && err.code;
    const offline = code === 'network' || code === 'timeout';
    const msg = d && offline ? '现在连不上百炼，先显示基础释义。' : ((err && err.message) || String(err)) + (d ? ' 下面先显示基础释义。' : '');
    const toMe = SETTINGS_CODES.includes(code) ? h('button', { type: 'button', className: 'text-btn accent', text: '去设置', on: { click: () => app.showTab('me') } }) : null;
    shell.body.append(
      d ? dictHead(app, d, { wrap: true }) : h('section', { className: 'ehead' }, headwordNode({ headword: q })),
      h('div', { className: 'sec' + (d ? ' fallback' : '') },
        h('p', { className: 'status-line err', role: 'status' }, icon(offline ? 'offline' : 'clock'), h('span', { text: msg }), toMe),
        d ? h('p', { className: 'small fb-foot', text: '这次没有留下记录，查到完整讲解后才能收藏。' }) : null));
    stubBar(shell, d ? d.word : (isChinese(q) ? '' : q), { label: '再试一次', icon: 'refresh', onClick: retry });
    push(shell.el);
  }

  // ---------------------------------------------------------------- lookup
  async function run(rawQ, opts = {}) {
    const q = normalizeQuery(rawQ);
    if (!q) { qEl.focus(); return; }
    hideSugs();
    qEl.value = q;
    fit();
    const context = opts.context !== undefined ? String(opts.context) : ctxEl.value.trim();
    if (!opts.keepCands) clearCands();
    const my = ++seq;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    setMsg('');
    qEl.blur(); ctxEl.blur();
    const d1 = tier1(q, opts);
    loadingPage(q, d1, context);
    busy = true;
    // right after launch the dictionary may still be loading: fill tier 1 in when it lands
    if (!d1 && !isChinese(q) && !app.dict.loaded()) {
      app.dict.ready.then(() => { const d = my === seq && busy ? tier1(q, opts) : null; if (d) loadingPage(q, d, context); });
    }
    let r;
    try {
      r = await app.words.lookup(q, context, { force: !!opts.force, fromCn: opts.fromCn || '', signal: ctrl.signal });
    } catch (err) {
      if (my !== seq || (err && err.code === 'abort')) return;
      if (!isChinese(q) && !app.dict.loaded()) await app.dict.whenReady(1500);
      if (my !== seq) return;
      busy = false;
      const retry = () => run(q, { ...opts, context });
      failPage(q, isChinese(q) ? null : app.dict.find(q), err, retry);
      return;
    }
    if (my !== seq) return;
    busy = false;
    if (!r.ok) { pop({ keep: true }); setMsg(r.message, 'bad'); return; }
    if (r.mode === 'zh') {
      if (r.found === false) { pop({ keep: true }); setMsg(r.message, 'warn'); return; }
      zhLast = r.result;
      clearCtx();
      showZh(r.result);
      return;
    }
    if (!r.found) {
      pop({ keep: true });
      if (r.status === 'typo' && r.suggestions.length) {
        setMsg(`“${q}”可能拼错了，不会留下记录。你想查的是：`, 'warn',
          h('div', { className: 'words-inline' }, r.suggestions.map(s => h('button', { type: 'button', className: 'text-btn word-btn', lang: 'en', text: s, on: { click: () => run(s, { context }) } }))));
      } else setMsg(`没认出“${q}”是英文单词或短语，不会留下记录。`, 'warn');
      return;
    }
    clearCtx();
    const st = r.stats || {};
    let notice = '';
    if (r.entry.favorited && st.relookups) notice = `你收藏过这个词，这是第 ${st.lookups} 次查它（收藏后第 ${st.relookups} 次）。`;
    else if (st.lookups > 1) notice = `这是你第 ${st.lookups} 次查这个词。`;
    // the view adds “已经把它加进今天的复习。” and drops it once a guess moves the card out of today
    const pulled = !!(r.pulled_review && app.words.inToday(r.entry.slug, app.settings().newPerDay));
    // also for a new spelling that maps to a favorited word (not cached)
    const guess = !!(r.entry.favorited && !opts.force && app.settings().guessFirst);
    const zhBack = opts.fromCn && zhLast && zhLast.query === opts.fromCn ? zhLast : null;
    // syllable dots only for a word that was already here (they never pop in when the explanation arrives)
    showEntry(r.entry, { notice, pulled, guess, zhBack, syl: !!r.cached });
  }

  function openEntry(slug) {
    const e = app.words.get(slug);
    if (!e) { toast('找不到这个词'); return; }
    qEl.value = e.headword;
    clearCands();
    setMsg('');
    showEntry(e, {});
  }

  function backToZh() {
    if (!zhLast) return;
    qEl.value = zhLast.query;
    setMsg('');
    showZh(zhLast);
  }

  // ---------------------------------------------------------------- paste
  function handlePaste(text) {
    hideSugs();
    const c = classifyPaste(text);
    if (c.type === 'empty') { setMsg('剪贴板是空的。先在别处复制一个词或一句话。', 'warn'); return; }
    if (c.type === 'toolong') { setMsg('中文请控制在 60 个字以内。', 'warn'); return; }
    if (c.type === 'word') { run(c.value); return; }
    qEl.value = '';
    fit();
    ctxEl.value = c.value;
    openCtx(true);
    autoGrow();
    syncCtxUI();
    if (!c.candidates.length) {
      clearCands();
      setMsg('这段话已放进“原句”，在上面输入要查的词。');
      return;
    }
    setMsg('');
    candEl.replaceChildren(
      h('p', { className: 'small', text: '这段话里的词，点一个就贴着这句话讲：' }),
      h('div', { className: 'words-inline' }, c.candidates.map(w => h('button', { type: 'button', className: 'text-btn word-btn', lang: 'en', text: w,
        on: { click: () => run(w, { context: c.value, keepCands: true }) } }))));
    candEl.hidden = false;
    sync();
  }

  pasteBtn.addEventListener('click', () => {
    hideSugs();
    // readText must be called directly inside the tap, or iOS refuses
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      setMsg('这里不能直接读剪贴板：长按输入框，选“粘贴”。', 'warn');
      return;
    }
    navigator.clipboard.readText().then(handlePaste, () => {
      setMsg('没读到剪贴板。点“粘贴”后，还要再点一下弹出的“粘贴”。也可以长按输入框粘贴。', 'warn');
    });
  });

  // ---------------------------------------------------------------- inputs
  function autoGrow() { ctxEl.style.height = 'auto'; ctxEl.style.height = Math.min(ctxEl.scrollHeight + 2, 200) + 'px'; sync(); }
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    run(qEl.value);
  });
  qEl.addEventListener('input', ev => {
    syncCtxUI();
    fit();
    if (ev.isComposing) hideSugs(); else renderSugs();   // suggest() takes well under 1 ms
    sync();
  });
  qEl.addEventListener('focus', () => { sync(); renderSugs(); });
  ctxEl.addEventListener('input', () => { autoGrow(); syncCtxUI(); });
  ctxEl.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); run(qEl.value); }
  });
  ctxToggle.addEventListener('click', () => {
    const on = ctxWrap.hidden;
    openCtx(on);
    if (on) ctxEl.focus();
  });
  clearBtn.addEventListener('mousedown', ev => ev.preventDefault());   // keep the keyboard up
  clearBtn.addEventListener('click', () => {
    hideSugs();
    qEl.value = '';
    fit();
    syncCtxUI();
    qEl.focus();
    sync();
  });
  cancelBtn.addEventListener('mousedown', ev => ev.preventDefault());
  cancelBtn.addEventListener('click', () => {
    hideSugs();
    seq++;
    if (ctrl) ctrl.abort();
    busy = false;
    qEl.value = '';
    fit();
    clearCtx(); clearCands(); setMsg('');
    qEl.blur(); ctxEl.blur();
    sync();
  });
  foldBtn.addEventListener('click', () => setRecent(!recentOpen));

  // ---------------------------------------------------------------- typeahead
  // Up to 8 dictionary words for what is being typed, as rows right under the line. It keeps the keyboard up
  // while a row is tapped, and goes away on blur, Escape, a lookup or the paste button.
  let blurTimer = 0;
  function hideSugs() {
    if (sugEl.hidden) return;
    sugEl.hidden = true;
    sugEl.replaceChildren();
    qEl.setAttribute('aria-expanded', 'false');
    sync();
  }
  function renderSugs() {
    const v = qEl.value.replace(/^\s+/, '');
    const list = document.activeElement === qEl && v.length >= 2 && v.length <= 40 && SUG_RE.test(v) ? app.dict.suggest(v, 8) : [];
    if (!list.length) { hideSugs(); return; }
    // with “先猜再看” on, a favorited word's meaning would give the answer away before the guess
    const guess = app.settings().guessFirst;
    const typed = v.toLowerCase();
    sugEl.replaceChildren(...list.map((s, i) => {
      const known = app.words.resolve(s.word);
      const fav = !!(known && known.favorited);
      const w = String(s.word);
      const pre = w.toLowerCase().startsWith(typed) ? w.slice(0, typed.length) : '';
      const word = pre ? [h('b', { text: pre }), h('span', { className: 'rest', text: w.slice(pre.length) })] : [w];
      return h('button', { type: 'button', className: 'word-row two', role: 'option', style: `--i:${i}`, on: { click: () => pickSug(s.word) } },
        h('span', { className: 'w', lang: 'en' }, fav ? h('span', { className: 'marked' }, word) : word),
        h('span', { className: 'end', text: s.via ? `“${s.via}”的原形` : fav ? '已收藏' : known ? '查过' : '' }),
        glossNode(fav && guess ? '已收藏' : s.cn));
    }));
    sugEl.hidden = false;
    sugEl.scrollTop = 0;
    qEl.setAttribute('aria-expanded', 'true');
    sync();
    fitSugs();
  }
  // the dictionary writes the part of speech first ("adj. 一丝不苟的"): set it in italic serif like the mockup
  function glossNode(text) {
    const m = String(text || '').match(/^((?:[a-z]+\.\s*)+)(.*)$/);
    return h('span', { className: 'g' }, m ? [h('i', { lang: 'en', text: m[1].trim() }), m[2]] : text);
  }
  // as tall as the space between the line and the keyboard (or the tab bar); the rest scrolls inside
  function fitSugs() {
    if (sugEl.hidden) return;
    const vv = window.visualViewport;
    let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const bar = document.getElementById('tabbar');
    const barTop = bar && !document.body.classList.contains('pushed') ? bar.getBoundingClientRect().top : 0;
    if (barTop > 0 && barTop < bottom) bottom = barTop;
    // the entry block may still be rising (transform), so measure from where it ends up
    const top = stage.getBoundingClientRect().top + entryBlock.offsetTop + sugEl.offsetTop;
    sugEl.style.maxHeight = Math.max(132, Math.floor(bottom - top - 8)) + 'px';
  }
  function pickSug(word) {
    hideSugs();
    run(word);
  }
  sugEl.addEventListener('mousedown', ev => ev.preventDefault());   // the input keeps focus until the tap lands
  qEl.addEventListener('compositionstart', hideSugs);
  qEl.addEventListener('compositionend', () => { renderSugs(); });
  qEl.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !sugEl.hidden) { ev.preventDefault(); hideSugs(); } });
  qEl.addEventListener('blur', () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => { if (document.activeElement !== qEl) { hideSugs(); sync(); } }, 200);
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitSugs);
  window.addEventListener('resize', () => { fit(); sync(); fitSugs(); });

  // ---------------------------------------------------------------- recent
  let recentTimer = 0;
  function renderRecent() {
    const items = app.words.recent(20);
    foldNum.textContent = String(items.length);
    recentBox.hidden = !items.length;
    if (!items.length && recentOpen) setRecent(false);
    recentList.replaceChildren(...items.map((e, i) => h('div', { className: 'word-row', style: `--i:${i}` },
      h('button', { type: 'button', className: 'wr-main', on: { click: () => openEntry(e.slug) } },
        h('span', { className: 'w', lang: 'en', text: e.headword }),
        h('span', { className: 'g', text: e.brief_cn || '' })),
      h('span', { className: 'end' }, h('button', { type: 'button', className: 'text-btn accent mini-fav', text: '收藏', 'aria-label': '收藏 ' + e.headword,
        on: { click: () => app.toggleFav(e.slug, true) } })))));
  }
  function scheduleRecent() { clearTimeout(recentTimer); recentTimer = setTimeout(renderRecent, 60); }

  renderRecent();
  setRecent(false);
  syncCtxUI();

  return {
    lookup: (q, opts) => run(q, opts),
    openEntry,
    backToZh,
    focus: () => { if (page.hidden) qEl.focus(); },
    onChange: () => scheduleRecent(),
    show: () => { if (page.hidden) sync(); },
    isBusy: () => busy || document.activeElement === ctxEl,
    hasResult: () => !page.hidden,
    isPushed: () => !page.hidden,
    back: () => back(),
  };
}
