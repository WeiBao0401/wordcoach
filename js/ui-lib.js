// 词库 tab (SPEC 2.2, design v2 4.3): running head with the count and the round 我 entry, a search line, sort as
// a phrase of words, filters as a line of small words, rows grouped by month / letter / lookups (sticky group
// heads), an A–Z thumb index. Rendered in batches of 150. A row pushes the word page (‹ 词库).
import { h, icon } from './ui-dom.js';
import { createEntryView } from './ui-entry.js';
import { summary, hasExtras } from './words.js';
import { State } from './fsrs.js';
import { LIB_CHUNK } from './config.js';

// “今天到期” is called 今天要复习 now, the same words as the 复习 tab (design v2.1)
const FILTERS = [['all', '全部'], ['due', '今天要复习'], ['new', '新词'], ['learning', '学习中'], ['mastered', '已掌握'], ['relook', '收藏后又查过']];
const SORTS = [['new', '新→旧'], ['old', '旧→新'], ['az', 'A–Z'], ['most', '查得最多']];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
const DAY = 864e5;

const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

export function createLibTab(app) {
  const root = document.getElementById('tab-lib');
  root.replaceChildren();

  let filter = 'all';
  let sort = lsGet('wc.sort', 'new');
  if (!SORTS.some(s => s[0] === sort)) sort = 'new';
  let query = '';
  let rows = [];
  let shown = 0;
  let dirty = true;
  let detail = null;      // EntryView in the detail screen
  let listScroll = 0;
  let changeTimer = 0;
  let groupCounts = new Map();

  // ---------------------------------------------------------------- DOM
  const countEl = h('span', { className: 'num count' });
  const meBtn = h('button', { type: 'button', className: 'me', 'aria-label': '我：设置与数据', on: { click: () => app.openMe() } }, h('span', { text: '我' }));
  const cancelBtn = h('button', { type: 'button', className: 'text-btn accent cancel', text: '取消', hidden: true });
  const statusSlot = h('div', { className: 'status-slot' });
  const top = h('header', { className: 'lib-top' },
    h('div', { className: 'runhead' }, h('h1', { className: 'runhead-title', text: '词库' }), h('div', { className: 'runhead-meta' }, countEl, meBtn, cancelBtn)));
  const searchEl = h('input', { type: 'search', className: 'lib-q', placeholder: '搜单词或中文意思', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': '搜索词库' });
  const searchClear = h('button', { type: 'button', className: 'clear', 'aria-label': '清空搜索', hidden: true }, icon('close'));
  const searchRow = h('label', { className: 'search' }, icon('search'), searchEl, searchClear);
  const sortEl = h('div', { className: 'sort', role: 'group', 'aria-label': '排序' });
  const filterEl = h('div', { className: 'filters', role: 'tablist', 'aria-label': '筛选' });
  const summaryEl = h('p', { className: 'summary', hidden: true });
  const listEl = h('div', { className: 'lib-list' });
  const thumbs = h('nav', { className: 'thumbs', 'aria-label': '字母索引', hidden: true });
  const loupe = h('div', { className: 'loupe', 'aria-hidden': 'true', hidden: true });
  const controls = h('div', { className: 'lib-controls' }, searchRow, sortEl, filterEl, summaryEl);
  const listView = h('div', { className: 'lib-list-view' }, top, statusSlot, h('div', { className: 'lib-body' }, controls, listEl));
  const detailView = h('div', { className: 'lib-detail-view', hidden: true });
  root.append(listView, detailView, thumbs, loupe);
  app.statusSlot(statusSlot);

  SORTS.forEach(([k, label], i) => {
    if (i) sortEl.append(h('span', { className: 'sep', 'aria-hidden': 'true', text: '·' }));
    sortEl.append(h('button', { type: 'button', className: 'text-btn', 'aria-pressed': String(k === sort), dataset: { s: k }, text: label,
      on: { click: () => { sort = k; lsSet('wc.sort', k); syncChips(); render(); window.scrollTo(0, 0); } } }));
  });
  for (const [k, label] of FILTERS) {
    filterEl.append(h('button', { type: 'button', className: 'f', role: 'tab', 'aria-selected': String(k === filter), dataset: { f: k },
      on: { click: () => { filter = k; syncChips(); render(); window.scrollTo(0, 0); } } },
    k === 'due' ? h('span', { className: 'dot', 'aria-hidden': 'true' }) : null, label));
  }
  function syncChips() {
    for (const b of filterEl.children) { const on = b.dataset.f === filter; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    for (const b of sortEl.querySelectorAll('button')) { const on = b.dataset.s === sort; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }
  syncChips();

  // searching: the sort and filters step aside, 取消 takes the running head
  const searching = () => document.activeElement === searchEl || !!searchEl.value;
  function syncSearch() {
    const on = searching();
    listView.classList.toggle('searching', on);
    cancelBtn.hidden = !on;
    countEl.hidden = on || !app.words.favorites().length;
    meBtn.hidden = on;
    searchClear.hidden = !searchEl.value;
  }
  let searchTimer = 0;
  searchEl.addEventListener('input', () => {
    syncSearch();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchEl.value.trim().toLowerCase(); render(); }, 120);
  });
  searchEl.addEventListener('focus', syncSearch);
  searchEl.addEventListener('blur', () => setTimeout(syncSearch, 0));
  searchEl.addEventListener('keydown', ev => { if (ev.key === 'Enter') searchEl.blur(); });
  searchClear.addEventListener('mousedown', ev => ev.preventDefault());
  searchClear.addEventListener('click', () => { searchEl.value = ''; query = ''; render(); searchEl.focus(); syncSearch(); });
  cancelBtn.addEventListener('mousedown', ev => ev.preventDefault());
  cancelBtn.addEventListener('click', () => { searchEl.value = ''; query = ''; searchEl.blur(); render(); syncSearch(); });

  // ---------------------------------------------------------------- data
  const favTime = w => w.favorited_at || w.created || '';
  function groupKey(w) {
    if (sort === 'az') { const c = (w.headword || '')[0] || ''; return /[a-z]/i.test(c) ? c.toUpperCase() : '#'; }
    if (sort === 'most') return w.lookups >= 5 ? '查过 5 次以上' : w.lookups >= 2 ? `查过 ${w.lookups} 次` : w.lookups === 1 ? '查过 1 次' : '没在这里查过';
    const t = favTime(w);
    if (!t) return '没有时间';
    const y = +t.slice(0, 4), m = +t.slice(5, 7);
    return y === new Date().getFullYear() ? `${m} 月` : `${y} 年 ${m} 月`;
  }

  function compute() {
    // 今天要复习 = what today's review will actually show (same rule and new-card quota as the 复习 tab)
    const rq = app.words.reviewQueue(app.settings().newPerDay);
    const dueSet = new Set([...rq.due, ...rq.fresh].map(e => e.slug));
    const all = app.words.favorites().map(e => {
      const s = summary(e);
      s.isDue = dueSet.has(e.slug);
      s.isNew = !!(e.fsrs && e.fsrs.state === State.New);
      return s;
    });
    const counts = { all: all.length, new: 0, learning: 0, mastered: 0, due: 0, relook: 0, dueOld: rq.due.length, dueNew: rq.fresh.length };
    for (const w of all) { counts[w.mastery]++; if (w.isDue) counts.due++; if (w.relookups > 0) counts.relook++; }
    const q = query;
    const list = all.filter(w =>
      (q || filter === 'all' || w.mastery === filter || (filter === 'due' && w.isDue) || (filter === 'relook' && w.relookups > 0)) &&
      (!q || String(w.headword).toLowerCase().includes(q) || String(w.brief_cn || '').toLowerCase().includes(q)));
    if (q) {
      // a search ranks words that start with what was typed first
      const starts = w => (String(w.headword).toLowerCase().startsWith(q) ? 0 : 1);
      list.sort((a, b) => starts(a) - starts(b) || String(a.headword).localeCompare(String(b.headword), 'en', { sensitivity: 'base' }));
    } else if (sort === 'az') list.sort((a, b) => String(a.headword).localeCompare(String(b.headword), 'en', { sensitivity: 'base' }));
    else if (sort === 'most') list.sort((a, b) => b.lookups - a.lookups || b.relookups - a.relookups || String(b.last_lookup || '').localeCompare(String(a.last_lookup || '')));
    else list.sort((a, b) => sort === 'new' ? favTime(b).localeCompare(favTime(a)) : favTime(a).localeCompare(favTime(b)));
    return { all, list, counts };
  }

  // ---------------------------------------------------------------- render
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); renderMore(); } }), { rootMargin: '400px 0px' })
    : null;

  // the right slot: a small note (新词 / 晚 3 天 / 查 5 次 / ↻2) and a dot when it is in today's review
  function rowNote(w) {
    if (sort === 'most' && !query) return `查 ${w.lookups} 次`;
    if (filter === 'due' && !query) {
      if (w.isNew) return '新词';
      const late = Math.floor((Date.now() - new Date(w.due)) / DAY);
      if (late >= 1) return `晚 ${late} 天`;
    }
    return w.relookups ? `↻${w.relookups}` : '';
  }
  function rowNode(w) {
    const note = rowNote(w);
    const hw = String(w.headword);
    const pre = query && hw.toLowerCase().startsWith(query) ? hw.slice(0, query.length) : '';
    return h('button', { type: 'button', className: 'word-row', dataset: { slug: w.slug }, on: { click: () => openDetail(w.slug) } },
      h('span', { className: 'w', lang: 'en' }, pre ? [h('b', { text: pre }), h('span', { className: 'rest', text: hw.slice(pre.length) })] : hw),
      h('span', { className: 'g', text: w.brief_cn }),
      note || w.isDue ? h('span', { className: 'end' },
        note ? h('span', { className: 'note', title: w.relookups && note.startsWith('↻') ? `收藏后又查了 ${w.relookups} 次` : null, text: note }) : null,
        w.isDue ? h('span', { className: 'dot', role: 'img', 'aria-label': '今天要复习' }) : null) : null);
  }

  function renderMore(upto = 0) {
    const old = listEl.querySelector('.more');
    if (old) old.remove();
    const end = Math.min(rows.length, Math.max(upto, shown + LIB_CHUNK));
    const frag = document.createDocumentFragment();
    let prev = shown ? groupKey(rows[shown - 1]) : null;
    for (let i = shown; i < end; i++) {
      const w = rows[i], g = query ? '' : groupKey(w);
      if (!query && g !== prev) {
        frag.append(h('div', { className: 'group', id: 'G-' + g }, h('h2', { text: g }), h('span', { className: 'n num', text: String(groupCounts.get(g) || '') })));
        prev = g;
      }
      frag.append(rowNode(w));
    }
    shown = end;
    if (shown < rows.length) {
      const left = rows.length - shown;
      const more = h('button', { type: 'button', className: 'more text-btn accent', text: `还有 ${left} 个，再显示 ${Math.min(LIB_CHUNK, left)} 个`, on: { click: () => renderMore() } });
      frag.append(more);
      if (io) io.observe(more);
    }
    listEl.append(frag);
  }

  const arrow = () => icon('chev');
  function render({ keep = false } = {}) {
    dirty = false;
    const keepShown = keep ? shown : 0;
    const { all, list, counts } = compute();
    rows = list;
    shown = 0;
    groupCounts = new Map();
    if (!query) for (const w of rows) { const g = groupKey(w); groupCounts.set(g, (groupCounts.get(g) || 0) + 1); }
    listEl.replaceChildren();
    listEl.classList.toggle('az', sort === 'az' && !query);
    countEl.textContent = all.length.toLocaleString('en-US');
    listView.classList.toggle('empty-lib', !all.length);
    syncSearch();
    // the line under the filters: how many words this filter holds (and, for today's review, the split)
    if (filter !== 'all' && !query && all.length) {
      const label = FILTERS.find(f => f[0] === filter)[1];
      summaryEl.replaceChildren(
        h('span', {}, h('b', { className: 'num', text: String(rows.length) }), ' 个词',
          filter === 'due' ? ` · 到期 ${counts.dueOld} · 新词 ${counts.dueNew}` : ` · ${label}`),
        filter === 'due' && rows.length ? h('button', { type: 'button', className: 'text-btn accent', on: { click: () => app.showTab('review') } }, '去复习', arrow()) : null);
      summaryEl.hidden = false;
    } else summaryEl.hidden = true;
    if (!all.length) {
      listEl.append(h('section', { className: 'lib-empty' },
        h('p', { className: 'lede', text: '词库还是空的。' }),
        h('p', { className: 'small', text: '查词时点“划进词库”，词就记在这里。也可以把 Mac 上的词库导进来。' }),
        h('div', { className: 'lib-empty-actions' },
          h('button', { type: 'button', className: 'text-btn accent', on: { click: () => app.showTab('look') } }, '去查一个词', arrow()),
          h('button', { type: 'button', className: 'text-btn accent', on: { click: () => app.openMe({ open: 'import' }) } }, '去导入', arrow()))));
    } else if (!rows.length) {
      listEl.append(query
        ? h('section', { className: 'none', 'aria-live': 'polite' },
          h('p', { className: 't' }, '词库里没有 ', h('span', { className: 'serif', lang: 'en', text: searchEl.value.trim() }), '。'),
          h('p', { className: 'small', text: '可能还没收藏，也可能拼错了。' }),
          h('button', { type: 'button', className: 'text-btn accent', on: { click: () => app.lookup(searchEl.value.trim()) } }, '去查这个词', arrow()))
        : h('p', { className: 'none small', text: '没有符合条件的词。' }));
    } else {
      if (query) listEl.append(h('p', { className: 'small count-line' }, h('span', { className: 'num', text: String(rows.length) }), '\u00a0个词'));
      renderMore(keepShown);
      if (query && /^[A-Za-z][A-Za-z '’.-]*$/.test(searchEl.value.trim())) {
        listEl.append(h('p', { className: 'find' }, h('button', { type: 'button', className: 'text-btn accent', on: { click: () => app.lookup(searchEl.value.trim()) } },
          '在词典里查“', h('span', { lang: 'en', text: searchEl.value.trim() }), '”', arrow())));
      }
    }
    renderThumbs();
  }

  // ---------------------------------------------------------------- A–Z thumb index
  function renderThumbs() {
    const az = sort === 'az' && !query;
    const present = new Set(az ? rows.map(groupKey) : []);
    thumbs.replaceChildren(...(az ? LETTERS.map(L => h('span', { className: present.has(L) ? 'has' : 'off', dataset: { l: L }, text: L })) : []));
    syncThumbs();
  }
  function syncThumbs() {
    thumbs.hidden = !(sort === 'az' && !query && rows.length > 30 && app.currentRoute() === 'lib' && detailView.hidden);
    if (!thumbs.hidden) placeIndex();
  }
  // centred in the space the list really has: from the bottom of the controls (or the running head) to the tab bar
  function placeIndex() {
    const head = top.getBoundingClientRect().bottom;
    const ctrl = controls.getBoundingClientRect().bottom;
    thumbs.style.top = Math.max(head, ctrl + 8) + 'px';
    markCurrent();
  }
  function markCurrent() {
    if (thumbs.hidden) return;
    const head = top.getBoundingClientRect().bottom;
    let cur = '';
    for (const g of listEl.querySelectorAll('.group')) { if (g.getBoundingClientRect().top <= head + 2) cur = g.id.slice(2); else break; }
    if (!cur) { const first = listEl.querySelector('.group'); cur = first ? first.id.slice(2) : ''; }
    for (const s of thumbs.children) s.classList.toggle('cur', s.dataset.l === cur);
  }
  let raf = 0;
  window.addEventListener('scroll', () => {
    if (thumbs.hidden) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(placeIndex);
  }, { passive: true });

  function jump(L) {
    const idx = rows.findIndex(w => groupKey(w) === L);
    if (idx < 0) return;
    if (idx >= shown) renderMore(idx + 60);
    const g = document.getElementById('G-' + L);
    if (g) window.scrollTo({ top: g.getBoundingClientRect().top + window.scrollY - top.getBoundingClientRect().bottom + 1, behavior: 'auto' });
  }
  // drag along the index like the iOS contacts list; a big serif letter shows in the margin while the finger is down
  let lastL = '';
  const pick = ev => {
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const L = t && t.dataset && t.dataset.l;
    if (L && t.classList.contains('has')) {
      if (L !== lastL) { lastL = L; jump(L); }
      loupe.textContent = L;
      loupe.hidden = false;
      // the jump scrolls the controls away and the index moves up with them: place the loupe after that
      placeIndex();
      const cur = thumbs.querySelector(`[data-l="${L}"]`);
      if (cur) loupe.style.top = (cur.getBoundingClientRect().top + 8 - 36) + 'px';
      for (const s of thumbs.children) s.classList.toggle('cur', s.dataset.l === L);
    }
  };
  thumbs.addEventListener('pointerdown', ev => { lastL = ''; try { thumbs.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } thumbs.classList.add('active'); pick(ev); ev.preventDefault(); });
  thumbs.addEventListener('pointermove', ev => { if (thumbs.classList.contains('active')) pick(ev); });
  const endDrag = () => { thumbs.classList.remove('active'); loupe.hidden = true; };
  thumbs.addEventListener('pointerup', endDrag);
  thumbs.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------- detail
  function openDetail(slug) {
    const e = app.words.get(slug);
    if (!e) return;
    listScroll = window.scrollY;
    if (detail) { app.unregisterView(detail); detail.destroy(); }
    detail = createEntryView(app, { where: 'lib', back: { label: '词库', onClick: () => closeDetail() } });
    detailView.replaceChildren(detail.el);
    app.registerView(detail);
    detail.show(e, {});
    listView.hidden = true;
    detailView.hidden = false;
    syncThumbs();
    app.chrome();
    window.scrollTo(0, 0);
    if (!hasExtras(e) || e.needs_core) app.words.enrich(e.slug).catch(() => {});
  }
  function closeDetail() {
    app.voice.stop();
    if (detail) { app.unregisterView(detail); detail.destroy(); detail = null; }
    detailView.hidden = true;
    listView.hidden = false;
    if (dirty) render({ keep: true });
    syncThumbs();
    app.chrome();
    window.scrollTo(0, listScroll);
  }

  return {
    show() { if (dirty && detailView.hidden) render({ keep: true }); syncThumbs(); },
    hide() { thumbs.hidden = true; loupe.hidden = true; },
    onChange() {
      dirty = true;
      if (app.currentRoute() === 'lib' && detailView.hidden) {
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => render({ keep: true }), 80);
      }
    },
    inDetail: () => !detailView.hidden,
    isPushed: () => !detailView.hidden,
    back: () => closeDetail(),
  };
}
