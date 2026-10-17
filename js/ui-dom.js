// DOM helpers. Data always goes in as text nodes (textContent); innerHTML is only used for the constant icons below.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// h('button', {className: 'x', on: {click}, dataset: {...}, 'aria-label': '...'}, 'text', child, [more])
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'className') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') el.style.cssText = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === '') continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Icons (design v2): drawn on a 24px grid, one 1.75 stroke with round ends; the stroke and size come from the .icon CSS.
const svg = paths => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
const ICONS = {
  search: svg('<circle cx="10.5" cy="10.5" r="6.25"/><path d="M15.2 15.2 20 20"/>'),
  book: svg('<path d="M6 5.5A1.5 1.5 0 0 1 7.5 4H18v13H7.5A1.5 1.5 0 0 0 6 18.5z"/><path d="M6 18.5A1.5 1.5 0 0 0 7.5 20H18"/><path d="M10 4v6l1.75-1.3L13.5 10V4"/>'),
  cards: svg('<rect x="9" y="4.5" width="11" height="15.5" rx="2"/><path d="M9 7.2 5.6 8a2 2 0 0 0-1.5 2.4l2.2 9a2 2 0 0 0 2.4 1.5L9.6 20.6"/>'),
  paste: svg('<path d="M9 5H7.4C6.6 5 6 5.6 6 6.4v12.2c0 .8.6 1.4 1.4 1.4h9.2c.8 0 1.4-.6 1.4-1.4V6.4c0-.8-.6-1.4-1.4-1.4H15"/><rect x="9" y="3.4" width="6" height="3.2" rx="1"/><path d="M9.4 11.4h5.2"/><path d="M9.4 14.9h3.4"/>'),
  quotePlus: svg('<path d="M4 12.8c0-2.6 1.2-4.4 3.3-5.3"/><circle cx="5.9" cy="13" r="1.9" fill="currentColor" stroke="none"/><path d="M9.4 12.8c0-2.6 1.2-4.4 3.3-5.3"/><circle cx="11.3" cy="13" r="1.9" fill="currentColor" stroke="none"/><path d="M19 9.5v7"/><path d="M15.5 13h7"/>'),
  close: svg('<path d="M7 7 17 17"/><path d="M17 7 7 17"/>'),
  back: svg('<path d="M14.5 5 7.5 12l7 7"/>'),
  chev: svg('<path d="m9.5 6 6 6-6 6"/>'),
  plus: svg('<path d="M12 5.5v13"/><path d="M5.5 12h13"/>'),
  minus: svg('<path d="M5.5 12h13"/>'),
  speak: svg('<path d="M4.5 9.5H8l4.5-4v13L8 14.5H4.5z"/><path d="M16 9.2a4 4 0 0 1 0 5.6"/><path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
  pen: svg('<path d="M13.6 5.4l5 5L11 18H7v-4z"/><path d="M11 8l5 5"/><path d="M4 21h9"/>'),
  check: svg('<path d="M5.5 12.5 10 17l8.5-9.5"/>'),
  note: svg('<path d="M7.25 3.75h9.5a1.75 1.75 0 0 1 1.75 1.75v13a1.75 1.75 0 0 1-1.75 1.75h-9.5A1.75 1.75 0 0 1 5.5 18.5v-13a1.75 1.75 0 0 1 1.75-1.75z"/><path d="M9 8.75h6M9 12.25h6M9 15.75h3.5"/>'),
  offline: svg('<path d="M3.5 9.4a12 12 0 0 1 17 0"/><path d="M6.7 12.6a7.6 7.6 0 0 1 10.6 0"/><path d="M9.8 15.8a3.1 3.1 0 0 1 4.4 0"/><path d="M12 19.2h.01"/><path d="M4.2 4.2 19.8 19.8"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.25"/><path d="M12 7.5V12l3 2"/>'),
  alert: svg('<path d="M12 4.2 20.5 19H3.5z"/><path d="M12 10v4"/><path d="M12 16.6h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="8.25"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
  phone: svg('<rect x="7" y="3.5" width="10" height="17" rx="2"/><path d="M11 17.5h2"/>'),
  arrow: svg('<path d="M4.5 12h14.5"/><path d="M13.5 6.5 19 12l-5.5 5.5"/>'),
  refresh: svg('<path d="M19.5 11a7.5 7.5 0 1 0-2.2 5.4"/><path d="M19.5 4.5V11H13"/>'),
};

// -> <svg class="icon extra">; className adds classes after "icon"
export function icon(name, className = '') {
  const tmp = document.createElement('span');
  tmp.innerHTML = ICONS[name] || svg('');   // constant markup only
  const el = tmp.firstElementChild;
  if (className) el.setAttribute('class', 'icon ' + className);
  return el;
}

// ---------------------------------------------------------------- highlighter

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Same stem rule as the Mac app: "meticulously" and "meticulous" both get marked.
export function stemRe(hw) {
  const first = String(hw || '').trim().split(/\s+/)[0] || '';
  if (!first) return null;
  const stem = first.length > 4 ? first.replace(/(e|y|ing|ed|es|s)$/i, '') : first;
  return new RegExp('\\b(' + escRe(stem) + "[a-z]*)", 'gi');
}

// Text with the target word wrapped in <mark class="marked"> (the one highlighter stroke), built from text nodes.
export function marked(text, hw, className = 'marked') {
  const frag = document.createDocumentFragment();
  const s = String(text ?? '');
  const re = stemRe(hw);
  if (!re) { frag.append(s); return frag; }
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) frag.append(s.slice(last, m.index));
    frag.append(h('mark', { className, text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.append(s.slice(last));
  return frag;
}

// ---------------------------------------------------------------- formatting

export function ago(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  const m = (Date.now() - t) / 6e4;
  if (!(m >= 0)) return dateCn(iso);
  if (m < 1) return '刚刚';
  if (m < 60) return Math.floor(m) + ' 分钟前';
  if (m < 1440) return Math.floor(m / 60) + ' 小时前';
  if (m < 2880) return '昨天';
  if (m < 7 * 1440) return Math.floor(m / 1440) + ' 天前';
  return dateCn(iso);
}
export const ymd = iso => String(iso || '').slice(0, 10);
export const md = iso => String(iso || '').slice(5, 10);
// "10 月 14 日"; another year gets its year in front (design v2.1: dates are always written this way)
export function dateCn(iso, now = new Date()) {
  const s = String(iso || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const day = `${+m[2]} 月 ${+m[3]} 日`;
  return +m[1] === now.getFullYear() ? day : `${m[1]} 年 ${day}`;
}
export function localYmd(d) {
  const x = new Date(d);
  if (isNaN(x)) return '';
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function fmtBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

// ---------------------------------------------------------------- toast

let toastTimer = 0;
export function toast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// quiet skeleton bars, widths in %
export const skBars = (widths = [92, 74, 84]) => h('div', { className: 'sk-bars', 'aria-hidden': 'true' }, widths.map(w => h('i', { style: `width:${w}%` })));

export const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
