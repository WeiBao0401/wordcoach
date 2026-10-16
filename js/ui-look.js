// 查词 tab: search box with typeahead, paste, context field, three-tier result (tier 1 from the offline
// dictionary), dictionary fallback when the model cannot be reached, typo / zh flows, recent lookups.
import { h, icon, toast, ago, skeleton } from './ui-dom.js';
import { createEntryView, renderZh, dictHead, dictMeaning } from './ui-entry.js';
import { classifyPaste, isChinese, normalizeQuery, hasExtras } from './words.js';

const CTX_HINT_EN = '粘贴你看到它的原句（可选），解释会贴着这句话讲';
const CTX_HINT_ZH = '使用场景（可选），比如“工作邮件里”“跟老板汇报”，会按场景推荐说法';
const SUG_RE = /^[A-Za-z][A-Za-z '’.-]*$/;   // typeahead only for English letters
const SETTINGS_CODES = ['nokey', 'badkey', 'model', 'forbidden'];

export function createLookTab(app) {
  const root = document.getElementById('tab-look');
  root.replaceChildren();

  // ---------------------------------------------------------------- DOM
  const qEl = h('input', { id: 'q', type: 'text', className: 'q-input', placeholder: '查英文，或输入中文找说法', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': '要查的词',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': 'q-sugs', 'aria-expanded': 'false' });
  const clearBtn = h('button', { type: 'button', className: 'q-clear', 'aria-label': '清空', hidden: true }, icon('close'));
  const ctxEl = h('textarea', { id: 'ctx', className: 'ctx-input', rows: 2, placeholder: CTX_HINT_EN, enterkeyhint: 'search', 'aria-label': '原句' });
  const ctxWrap = h('div', { className: 'ctx-wrap', hidden: true }, ctxEl);
  const ctxLabel = h('span', { text: '原句' });
  const ctxToggle = h('button', { type: 'button', className: 'tool ctx-toggle', 'aria-expanded': 'false' }, ctxLabel, icon('chevron', 'ic ic-s chev'));
  const pasteBtn = h('button', { type: 'button', className: 'tool paste' }, icon('paste', 'ic ic-s'), '粘贴查词');
  const goBtn = h('button', { type: 'submit', className: 'go', text: '查询' });
  const form = h('form', { className: 'search', role: 'search', autocomplete: 'off' },
    h('div', { className: 'q-row' }, icon('search', 'ic q-ic'), qEl, clearBtn),
    ctxWrap,
    h('div', { className: 'tools-row' }, pasteBtn, ctxToggle, h('span', { className: 'spacer' }), goBtn));
  // typeahead: floats over the page under the search card, so nothing below it moves
  const sugEl = h('div', { className: 'sugs', id: 'q-sugs', role: 'listbox', 'aria-label': '联想词', hidden: true });
  const searchWrap = h('div', { className: 'search-wrap' }, form, sugEl);
  const msgEl = h('div', { className: 'status', role: 'status', 'aria-live': 'polite' });
  const candEl = h('div', { className: 'cands', hidden: true });
  const resultEl = h('div', { className: 'look-result' });
  const recentList = h('div', { className: 'rows' });
  const recentBox = h('section', { className: 'recent' },
    h('h2', { className: 'sec-title', text: '最近查过' }),
    h('p', { className: 'small muted', text: '没收藏的词留在这里。想留就点“收藏”，收藏后才进词库和复习。' }),
    recentList);

  root.append(
    h('div', { className: 'brand' }, h('span', { className: 'mark' }, 'Word ', h('i', { text: 'Coach' }))),
    searchWrap, msgEl, candEl, resultEl, recentBox);

  // ---------------------------------------------------------------- state
  let view = null;          // EntryView on screen
  let zhLast = null;        // last Chinese -> English result, for "回到中文"
  let seq = 0;
  let ctrl = null;
  let busy = false;

  function setMsg(text, kind = '', extra = null) {
    msgEl.className = 'status' + (kind ? ' ' + kind : '');
    msgEl.replaceChildren();
    if (text) msgEl.append(h('span', { text }));
    if (extra) msgEl.append(extra);
  }
  function syncCtxUI() {
    const zh = isChinese(qEl.value);
    ctxLabel.textContent = zh ? '使用场景' : '原句';
    ctxEl.placeholder = zh ? CTX_HINT_ZH : CTX_HINT_EN;
    ctxEl.setAttribute('aria-label', zh ? '使用场景' : '原句');
    ctxToggle.classList.toggle('has', !!ctxEl.value.trim());
    clearBtn.hidden = !qEl.value && !resultEl.firstChild;
  }
  function openCtx(on) {
    ctxWrap.hidden = !on;
    ctxToggle.setAttribute('aria-expanded', String(on));
    ctxToggle.classList.toggle('open', on);
  }
  function clearCtx() { ctxEl.value = ''; ctxEl.style.height = ''; openCtx(false); syncCtxUI(); }
  function clearCands() { candEl.hidden = true; candEl.replaceChildren(); }

  function clearResult() {
    if (view) { app.unregisterView(view); view.destroy(); view = null; }
    resultEl.replaceChildren();
    recentBox.hidden = false;
    syncCtxUI();
  }
  function setResult(node) {
    if (view) { app.unregisterView(view); view.destroy(); view = null; }
    resultEl.replaceChildren(node);
    recentBox.hidden = true;
    syncCtxUI();
  }

  function showEntry(e, opts = {}) {
    const v = createEntryView(app, { where: 'look' });
    setResult(v.el);
    view = v;
    app.registerView(v);
    v.show(e, opts);
    if (!hasExtras(e) || e.needs_core) app.words.enrich(e.slug).catch(() => {});
    app.scrollTop();
  }

  function showZh(d) {
    setResult(renderZh(app, d, { onPick: (en, fromCn) => run(en, { fromCn, context: '' }) }));
    app.scrollTop();
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

  function loadingCard(q, d = null) {
    if (d) {
      return h('article', { className: 'entry loading tier1', 'aria-busy': 'true' },
        dictHead(app, d, q), dictMeaning(d),
        h('p', { className: 'small muted dots gen-note', text: '正在生成完整讲解' }),
        skeleton('释义', [90, 76, 84]), skeleton('巧记', [80, 60]));
    }
    if (isChinese(q)) {
      return h('article', { className: 'entry zh loading', 'aria-busy': 'true' },
        h('header', { className: 'entry-head zh-head' }, h('span', { className: 'label', text: '中文 → 英文' }), h('div', { className: 'zh-q', text: q }),
          h('p', { className: 'small muted dots', text: '正在找英文说法' })),
        skeleton('选项', [70, 92, 60]), skeleton('', [84, 66]));
    }
    return h('article', { className: 'entry loading', 'aria-busy': 'true' },
      h('header', { className: 'entry-head' }, h('div', { className: 'hw-line' }, h('span', { className: 'hw pending', lang: 'en', text: q })),
        h('p', { className: 'small muted dots', text: '正在查' })),
      skeleton('释义', [90, 76, 84, 58]), skeleton('巧记', [80, 60]));
  }

  // The model failed (offline, no key, error) but the dictionary knows the word. Nothing is stored.
  function fallbackCard(d, q, err, retry) {
    const code = err && err.code;
    const offline = code === 'network' || code === 'timeout';
    return h('div', { className: 'fallback' },
      h('div', { className: 'fb-note', role: 'status' },
        h('p', { className: 'fb-main', text: offline ? '现在连不上百炼，先显示基础释义。' : (err && err.message) || String(err) }),
        offline ? null : h('p', { className: 'small', text: '下面先显示基础释义。' }),
        h('div', { className: 'btn-row' },
          SETTINGS_CODES.includes(code) ? h('button', { type: 'button', className: 'btn primary', text: '去“我的”设置', on: { click: () => app.showTab('me') } }) : null,
          h('button', { type: 'button', className: 'btn', on: { click: retry } }, icon('refresh', 'ic ic-s'), '再试一次'))),
      h('article', { className: 'entry tier1' }, dictHead(app, d, q), dictMeaning(d),
        h('p', { className: 'small muted fb-foot', text: '这次没有留下记录，查到完整讲解后才能收藏。' })));
  }

  function errorBox(err, retry) {
    const code = err && err.code;
    const settings = SETTINGS_CODES.includes(code);
    return h('div', { className: 'err-box big' },
      h('p', { text: (err && err.message) || String(err) }),
      h('div', { className: 'btn-row' },
        settings ? h('button', { type: 'button', className: 'btn primary', text: '去“我的”设置', on: { click: () => app.showTab('me') } }) : null,
        h('button', { type: 'button', className: 'btn', on: { click: retry } }, icon('refresh', 'ic ic-s'), '再试一次')));
  }

  // ---------------------------------------------------------------- lookup
  async function run(rawQ, opts = {}) {
    const q = normalizeQuery(rawQ);
    if (!q) { qEl.focus(); return; }
    hideSugs();
    qEl.value = q;
    const context = opts.context !== undefined ? String(opts.context) : ctxEl.value.trim();
    if (!opts.keepCands) clearCands();
    const my = ++seq;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    setMsg('');
    const d1 = tier1(q, opts);
    setResult(loadingCard(q, d1));
    busy = true;
    // right after launch the dictionary may still be loading: fill tier 1 in when it lands
    if (!d1 && !isChinese(q) && !app.dict.loaded()) {
      app.dict.ready.then(() => { const d = my === seq && busy ? tier1(q, opts) : null; if (d) setResult(loadingCard(q, d)); });
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
      const d = isChinese(q) ? null : app.dict.find(q);
      setResult(d ? fallbackCard(d, q, err, retry) : errorBox(err, retry));
      return;
    }
    if (my !== seq) return;
    busy = false;
    if (!r.ok) { clearResult(); setMsg(r.message, 'bad'); return; }
    if (r.mode === 'zh') {
      if (r.found === false) { clearResult(); setMsg(r.message, 'warn'); return; }
      zhLast = r.result;
      clearCtx();
      showZh(r.result);
      return;
    }
    if (!r.found) {
      clearResult();
      if (r.status === 'typo' && r.suggestions.length) {
        setMsg(`“${q}”可能拼错了，不会留下记录。你想查的是：`, 'warn',
          h('span', { className: 'chips inline' }, r.suggestions.map(s => h('button', { type: 'button', className: 'chip', lang: 'en', text: s, on: { click: () => run(s, { context }) } }))));
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
    showEntry(r.entry, { notice, pulled, guess, zhBack });
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
    clearResult();
    qEl.value = '';
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
      h('div', { className: 'small muted', text: '这段话里的词，点一个就贴着这句话讲：' }),
      h('div', { className: 'chips' }, c.candidates.map(w => h('button', { type: 'button', className: 'chip', lang: 'en', text: w,
        on: { click: () => run(w, { context: c.value, keepCands: true }) } }))));
    candEl.hidden = false;
  }

  pasteBtn.addEventListener('click', () => {
    hideSugs();
    // readText must be called directly inside the tap, or iOS refuses
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      setMsg('这里不能直接读剪贴板：长按输入框，选“粘贴”。', 'warn');
      return;
    }
    navigator.clipboard.readText().then(handlePaste, () => {
      setMsg('没读到剪贴板。点“粘贴查词”后，还要再点一下弹出的“粘贴”。也可以长按输入框粘贴。', 'warn');
    });
  });

  // ---------------------------------------------------------------- inputs
  function autoGrow() { ctxEl.style.height = 'auto'; ctxEl.style.height = Math.min(ctxEl.scrollHeight + 2, 220) + 'px'; }
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    qEl.blur(); ctxEl.blur();
    run(qEl.value);
  });
  qEl.addEventListener('input', ev => {
    syncCtxUI();
    if (ev.isComposing) hideSugs(); else renderSugs();   // suggest() takes well under 1 ms
  });
  ctxEl.addEventListener('input', () => { autoGrow(); syncCtxUI(); });
  ctxEl.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
  });
  ctxToggle.addEventListener('click', () => {
    const on = ctxWrap.hidden;
    openCtx(on);
    if (on) ctxEl.focus();
  });
  clearBtn.addEventListener('click', () => {
    hideSugs();
    seq++;
    if (ctrl) ctrl.abort();
    busy = false;
    qEl.value = '';
    clearCtx(); clearCands(); setMsg(''); clearResult();
    qEl.focus();
  });

  // ---------------------------------------------------------------- typeahead
  // Up to 8 dictionary words for what is being typed. It floats (no layout shift), keeps the keyboard up
  // while a row is tapped, and goes away on blur, Escape, a lookup or the paste button.
  let blurTimer = 0;
  function hideSugs() {
    if (sugEl.hidden) return;
    sugEl.hidden = true;
    sugEl.replaceChildren();
    qEl.setAttribute('aria-expanded', 'false');
  }
  function renderSugs() {
    const v = qEl.value.replace(/^\s+/, '');
    const list = document.activeElement === qEl && v.length >= 2 && v.length <= 40 && SUG_RE.test(v) ? app.dict.suggest(v, 8) : [];
    if (!list.length) { hideSugs(); return; }
    // with “先猜再看” on, a favorited word's meaning would give the answer away before the guess
    const guess = app.settings().guessFirst;
    sugEl.replaceChildren(...list.map(s => {
      const fav = guess && !!(app.words.resolve(s.word) || {}).favorited;
      return h('button', { type: 'button', className: 'sug', role: 'option', on: { click: () => pickSug(s.word) } },
        h('span', { className: 'w', lang: 'en', text: s.word }),
        s.via ? h('span', { className: 'tag', text: `“${s.via}”的原形` }) : null,
        h('span', { className: 'b', text: fav ? '已收藏' : s.cn }));
    }));
    sugEl.hidden = false;
    sugEl.scrollTop = 0;
    qEl.setAttribute('aria-expanded', 'true');
    fitSugs();
  }
  // as tall as the space between the search card and the keyboard (or the tab bar); the rest scrolls inside
  function fitSugs() {
    if (sugEl.hidden) return;
    const vv = window.visualViewport;
    let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const bar = document.getElementById('tabbar');
    const barTop = bar ? bar.getBoundingClientRect().top : 0;
    if (barTop > 0 && barTop < bottom) bottom = barTop;
    sugEl.style.maxHeight = Math.max(132, Math.floor(bottom - form.getBoundingClientRect().bottom - 16)) + 'px';
  }
  function pickSug(word) {
    hideSugs();
    qEl.blur();
    run(word);
  }
  sugEl.addEventListener('mousedown', ev => ev.preventDefault());   // the input keeps focus until the tap lands
  qEl.addEventListener('compositionstart', hideSugs);
  qEl.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !sugEl.hidden) { ev.preventDefault(); hideSugs(); } });
  qEl.addEventListener('blur', () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => { if (document.activeElement !== qEl) hideSugs(); }, 200);
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitSugs);
  window.addEventListener('scroll', fitSugs, { passive: true });

  // ---------------------------------------------------------------- recent
  let recentTimer = 0;
  function renderRecent() {
    const items = app.words.recent(20);
    recentList.replaceChildren();
    if (!items.length) {
      recentList.append(h('p', { className: 'empty', text: '查过、还没收藏的词会出现在这里。' }));
      return;
    }
    for (const e of items) {
      const hist = e.history || [];
      const last = hist.length ? hist[hist.length - 1].at : e.created;
      recentList.append(h('div', { className: 'rowi' },
        h('button', { type: 'button', className: 'row-main', on: { click: () => openEntry(e.slug) } },
          h('span', { className: 'w', lang: 'en', text: e.headword }),
          h('span', { className: 'b', text: e.brief_cn || '' })),
        h('span', { className: 't', text: ago(last) }),
        h('button', { type: 'button', className: 'mini-fav', text: '收藏', 'aria-label': '收藏 ' + e.headword,
          on: { click: () => app.toggleFav(e.slug, true) } })));
    }
  }
  function scheduleRecent() { clearTimeout(recentTimer); recentTimer = setTimeout(renderRecent, 60); }

  renderRecent();
  syncCtxUI();

  return {
    lookup: (q, opts) => run(q, opts),
    openEntry,
    backToZh,
    focus: () => { if (!resultEl.firstChild) qEl.focus(); },
    onChange: () => scheduleRecent(),
    isBusy: () => busy || document.activeElement === ctxEl,
    hasResult: () => !!resultEl.firstChild,
  };
}
