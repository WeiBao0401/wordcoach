// 词库 tab (SPEC 2.2): sort, group, filter, search, rendered in batches of 150; tap a row for the word page.
import { h, icon, md } from './ui-dom.js';
import { createEntryView } from './ui-entry.js';
import { summary, hasExtras } from './words.js';
import { LIB_CHUNK } from './config.js';

const FILTERS = [['all', '全部'], ['new', '新词'], ['learning', '学习中'], ['mastered', '已掌握'], ['due', '今天到期'], ['relook', '收藏后又查过']];
const SORTS = [['new', '新→旧'], ['old', '旧→新'], ['az', 'A–Z'], ['most', '查得最多']];
const MASTERY = { new: '新词', learning: '学习中', mastered: '已掌握' };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');

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

  // ---------------------------------------------------------------- DOM
  const countEl = h('span', { className: 'tab-count' });
  const searchEl = h('input', { type: 'text', className: 'lib-search', placeholder: '搜索单词或中文意思', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': '搜索词库' });
  const searchClear = h('button', { type: 'button', className: 'q-clear', 'aria-label': '清空搜索', hidden: true }, icon('close'));
  const filterEl = h('div', { className: 'filters', role: 'tablist', 'aria-label': '筛选' });
  const sortEl = h('div', { className: 'seg', role: 'group', 'aria-label': '排序' });
  const listEl = h('div', { className: 'lib-list' });
  const thumbs = h('nav', { className: 'thumbs', 'aria-label': '字母索引', hidden: true });
  const listView = h('div', { className: 'lib-list-view' },
    h('header', { className: 'tab-head' }, h('h1', { text: '词库' }), countEl),
    h('div', { className: 'lib-search-row' }, icon('search', 'ic q-ic'), searchEl, searchClear),
    filterEl, sortEl, listEl);
  const detailBody = h('div', { className: 'detail-body' });
  const detailView = h('div', { className: 'lib-detail-view', hidden: true },
    h('div', { className: 'topbar' }, h('button', { type: 'button', className: 'back', on: { click: () => closeDetail() } }, icon('back', 'ic'), '词库')),
    detailBody);
  root.append(listView, detailView, thumbs);

  for (const [k, label] of FILTERS) {
    filterEl.append(h('button', { type: 'button', className: 'fchip' + (k === filter ? ' on' : ''), role: 'tab', 'aria-selected': String(k === filter), dataset: { f: k },
      on: { click: () => { filter = k; syncChips(); render(); window.scrollTo(0, 0); } } }, h('span', { text: label }), h('span', { className: 'n' })));
  }
  for (const [k, label] of SORTS) {
    sortEl.append(h('button', { type: 'button', className: k === sort ? 'on' : '', 'aria-pressed': String(k === sort), dataset: { s: k }, text: label,
      on: { click: () => { sort = k; lsSet('wc.sort', k); syncChips(); render(); window.scrollTo(0, 0); } } }));
  }
  function syncChips() {
    for (const b of filterEl.children) { const on = b.dataset.f === filter; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    for (const b of sortEl.children) { const on = b.dataset.s === sort; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }

  let searchTimer = 0;
  searchEl.addEventListener('input', () => {
    searchClear.hidden = !searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchEl.value.trim().toLowerCase(); render(); }, 120);
  });
  searchEl.addEventListener('keydown', ev => { if (ev.key === 'Enter') searchEl.blur(); });
  searchClear.addEventListener('click', () => { searchEl.value = ''; searchClear.hidden = true; query = ''; render(); searchEl.focus(); });

  // ---------------------------------------------------------------- data
  const favTime = w => w.favorited_at || w.created || '';
  function groupKey(w) {
    if (sort === 'az') { const c = (w.headword || '')[0] || ''; return /[a-z]/i.test(c) ? c.toUpperCase() : '#'; }
    if (sort === 'most') return w.lookups >= 5 ? '查过 5 次以上' : w.lookups >= 2 ? `查过 ${w.lookups} 次` : w.lookups === 1 ? '查过 1 次' : '没在这里查过';
    const t = favTime(w);
    return t ? `${t.slice(0, 4)} 年 ${+t.slice(5, 7)} 月` : '没有时间';
  }

  function compute() {
    // “今天到期” = what today's review will actually show (same rule and new-card quota as the 复习 tab)
    const rq = app.words.reviewQueue(app.settings().newPerDay);
    const dueSet = new Set([...rq.due, ...rq.fresh].map(e => e.slug));
    const all = app.words.favorites().map(e => {
      const s = summary(e);
      s.isDue = dueSet.has(e.slug);
      return s;
    });
    const counts = { all: all.length, new: 0, learning: 0, mastered: 0, due: 0, relook: 0 };
    for (const w of all) { counts[w.mastery]++; if (w.isDue) counts.due++; if (w.relookups > 0) counts.relook++; }
    const q = query;
    let list = all.filter(w =>
      (filter === 'all' || w.mastery === filter || (filter === 'due' && w.isDue) || (filter === 'relook' && w.relookups > 0)) &&
      (!q || String(w.headword).toLowerCase().includes(q) || String(w.brief_cn || '').toLowerCase().includes(q)));
    if (sort === 'az') list.sort((a, b) => String(a.headword).localeCompare(String(b.headword), 'en', { sensitivity: 'base' }));
    else if (sort === 'most') list.sort((a, b) => b.lookups - a.lookups || b.relookups - a.relookups || String(b.last_lookup || '').localeCompare(String(a.last_lookup || '')));
    else list.sort((a, b) => sort === 'new' ? favTime(b).localeCompare(favTime(a)) : favTime(a).localeCompare(favTime(b)));
    return { all, list, counts };
  }

  // ---------------------------------------------------------------- render
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); renderMore(); } }), { rootMargin: '400px 0px' })
    : null;

  function rowNode(w) {
    const right = sort === 'most' ? h('span', { className: 'd', text: `查 ${w.lookups} 次` })
      : sort !== 'az' ? h('span', { className: 'd', text: md(favTime(w)) }) : null;
    return h('button', { type: 'button', className: 'li', dataset: { slug: w.slug }, on: { click: () => openDetail(w.slug) } },
      h('span', { className: 'dot ' + w.mastery, title: MASTERY[w.mastery], 'aria-label': MASTERY[w.mastery] }),
      h('span', { className: 'w', lang: 'en', text: w.headword }),
      h('span', { className: 'b', text: w.brief_cn }),
      w.relookups ? h('span', { className: 'cnt', title: `收藏后又查了 ${w.relookups} 次`, text: '↻' + w.relookups }) : null,
      w.isDue ? h('span', { className: 'due-tag', text: '到期' }) : null,
      right);
  }

  function renderMore(upto = 0) {
    const old = listEl.querySelector('.more');
    if (old) old.remove();
    const end = Math.min(rows.length, Math.max(upto, shown + LIB_CHUNK));
    const frag = document.createDocumentFragment();
    let prev = shown ? groupKey(rows[shown - 1]) : null;
    for (let i = shown; i < end; i++) {
      const w = rows[i], g = groupKey(w);
      if (g !== prev) { frag.append(h('div', { className: 'group' + (sort === 'az' ? ' letter' : ''), id: 'G-' + g, text: g })); prev = g; }
      frag.append(rowNode(w));
    }
    shown = end;
    if (shown < rows.length) {
      const left = rows.length - shown;
      const more = h('button', { type: 'button', className: 'more textbtn', text: `还有 ${left} 个，再显示 ${Math.min(LIB_CHUNK, left)} 个`, on: { click: () => renderMore() } });
      frag.append(more);
      if (io) io.observe(more);
    }
    listEl.append(frag);
  }

  function render({ keep = false } = {}) {
    dirty = false;
    const keepShown = keep ? shown : 0;
    const { all, list, counts } = compute();
    rows = list;
    shown = 0;
    listEl.replaceChildren();
    listEl.classList.toggle('az', sort === 'az');
    countEl.textContent = rows.length === all.length ? `${all.length} 个词` : `${rows.length} / ${all.length}`;
    for (const b of filterEl.children) { const n = counts[b.dataset.f]; b.lastChild.textContent = n ? String(n) : ''; }
    if (!rows.length) {
      listEl.append(all.length ? h('p', { className: 'empty', text: '没有符合条件的词。' })
        : h('div', { className: 'empty' },
          h('p', { text: '词库是空的。查词时点“收藏”，词就会进到这里。' }),
          h('p', { text: '也可以把 Mac 上的词库导进来。' }),
          h('button', { type: 'button', className: 'btn', text: '去导入', on: { click: () => app.showTab('me') } })));
    } else renderMore(keepShown);
    renderThumbs();
  }

  function renderThumbs() {
    const present = new Set(sort === 'az' ? rows.map(groupKey) : []);
    thumbs.replaceChildren(...(sort === 'az' ? LETTERS.map(L => h('span', { className: present.has(L) ? 'has' : '', dataset: { l: L }, text: L })) : []));
    syncThumbs();
  }
  function syncThumbs() { thumbs.hidden = !(sort === 'az' && rows.length > 30 && app.currentTab() === 'lib' && detailView.hidden); }

  function jump(L) {
    const idx = rows.findIndex(w => groupKey(w) === L);
    if (idx < 0) return;
    if (idx >= shown) renderMore(idx + 60);
    const g = document.getElementById('G-' + L);
    if (g) window.scrollTo({ top: g.getBoundingClientRect().top + window.scrollY - app.topInset(), behavior: 'auto' });
  }
  // drag along the index like the iOS contacts list
  let lastL = '';
  const pick = ev => {
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const L = t && t.dataset && t.dataset.l;
    if (L && L !== lastL && t.classList.contains('has')) { lastL = L; jump(L); }
  };
  thumbs.addEventListener('pointerdown', ev => { lastL = ''; try { thumbs.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } thumbs.classList.add('active'); pick(ev); ev.preventDefault(); });
  thumbs.addEventListener('pointermove', ev => { if (thumbs.classList.contains('active')) pick(ev); });
  const endDrag = () => thumbs.classList.remove('active');
  thumbs.addEventListener('pointerup', endDrag);
  thumbs.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------- detail
  function openDetail(slug) {
    const e = app.words.get(slug);
    if (!e) return;
    listScroll = window.scrollY;
    if (detail) { app.unregisterView(detail); detail.destroy(); }
    detail = createEntryView(app, { where: 'lib' });
    detailBody.replaceChildren(detail.el);
    app.registerView(detail);
    detail.show(e, {});
    listView.hidden = true;
    detailView.hidden = false;
    syncThumbs();
    window.scrollTo(0, 0);
    if (!hasExtras(e) || e.needs_core) app.words.enrich(e.slug).catch(() => {});
  }
  function closeDetail() {
    if (detail) { app.unregisterView(detail); detail.destroy(); detail = null; }
    detailView.hidden = true;
    listView.hidden = false;
    if (dirty) render({ keep: true });
    syncThumbs();
    window.scrollTo(0, listScroll);
  }

  return {
    show() { if (dirty && detailView.hidden) render({ keep: true }); syncThumbs(); },
    hide() { thumbs.hidden = true; },
    onChange() {
      dirty = true;
      if (app.currentTab() === 'lib' && detailView.hidden) {
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => render({ keep: true }), 80);
      }
    },
    inDetail: () => !detailView.hidden,
    back: () => closeDetail(),
  };
}
