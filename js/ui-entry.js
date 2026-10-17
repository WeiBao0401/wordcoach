// Word page (SPEC 2.1, design v2 4.2) and Chinese -> English result (SPEC 2.1b).
// A pushed page: back link on top, the word set like a dictionary entry, the rarer sections folded into index rows,
// and a fixed action bar (发音 / 划进词库 / 笔记) in place of the tab bar.
// The page is split into slots; on every data change only the slots whose content changed are rebuilt,
// so a quiz answer, an open index row or a note being typed survive the lexicon/practice parts arriving.
import { h, icon, marked, toast, ymd, md, localYmd, dateCn, skBars } from './ui-dom.js';
import { hasLexicon, hasPractice, lookupEvents, relookups } from './words.js';
import { endOfDay } from './fsrs.js';
import { TAG_CN } from './dict.js';

const ORDER = ['notice', 'head', 'guess', 'note', 'cn', 'ns', 'senses', 'err', 'ctx', 'mnemo', 'index',
  'ix-coll', 'ix-syn', 'ix-family', 'ix-ant', 'ix-conf', 'ix-usage', 'ix-read', 'foot', 'log'];

const sig = (...parts) => JSON.stringify(parts);
const secH = (text, extra) => h('h2', { className: 'sec-h' }, text, extra || null);
const sec = (label, ...body) => h('section', { className: 'sec' }, secH(label), ...body);

export function sayBtn(app, text, label = '朗读') {
  return h('button', { type: 'button', className: 'say', 'aria-label': label, on: { click: ev => { ev.stopPropagation(); app.say(text, ev.currentTarget); } } }, icon('speak'));
}

// ---------------------------------------------------------------- page shell
// back: {label, onClick}; scrollRoot: window, or the sheet element when the page lives in the sheet.
// The navbar rules itself and shows the word in the middle once the headword has scrolled under it.
export function pageShell(app, { back = null, scrollRoot = window } = {}) {
  const title = h('span', { className: 'nav-title', lang: 'en', 'aria-hidden': 'true' });
  const sessionEl = h('span', { className: 'nav-sess small' });
  const doneBtn = h('button', { type: 'button', className: 'text-btn accent nav-done', text: '完成', hidden: true,
    on: { mousedown: ev => ev.preventDefault(), click: () => { if (document.activeElement) document.activeElement.blur(); } } });
  const nav = h('header', { className: 'navbar' }, h('div', { className: 'inner' },
    back ? h('button', { type: 'button', className: 'back', on: { click: back.onClick } }, icon('back'), h('span', { text: back.label })) : h('span'),
    title, h('div', { className: 'nav-end' }, sessionEl, doneBtn)));
  const body = h('main', { className: 'page' });
  const bar = h('div', { className: 'ebar', role: 'toolbar', 'aria-label': '词条操作' }, h('div', { className: 'inner' }));
  const el = h('div', { className: 'epage' }, nav, body, bar);
  let raf = 0;
  const onScroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const hw = body.querySelector('.headword, .page-title, .zh-q');
      const navBottom = nav.getBoundingClientRect().bottom;
      nav.classList.toggle('ruled', !!hw && hw.getBoundingClientRect().bottom < navBottom);
    });
  };
  scrollRoot.addEventListener('scroll', onScroll, { passive: true });
  return {
    el, nav, body, bar: bar.firstChild, barEl: bar,
    setTitle(word, fav, lang = 'en') { title.lang = lang; title.replaceChildren(fav ? h('span', { className: 'marked', text: word }) : word); },
    setSession(text) { sessionEl.textContent = text || ''; },
    setEditing(on) { doneBtn.hidden = !on; sessionEl.hidden = on; },
    refreshRule: onScroll,
    destroy() { scrollRoot.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); el.remove(); },
  };
}

// ---------------------------------------------------------------- offline dictionary bits
// The dictionary entry for a word page: exact headword only, so a page for "went" never shows "go"'s phonetic.
export const dictFor = (app, e) => (app.dict && e && e.headword ? app.dict.get(e.headword) : null);
const dictSig = d => (d ? [d.word, d.phonetic, d.collins, d.oxford, d.tags.join()] : null);

// Collins stars, Oxford 3000 and exam tags as one muted line (plain text: in this app bordered pills are buttons).
export function dictChips(d) {
  if (!d) return null;
  const marks = [];
  if (d.collins) marks.push('柯林斯 ' + '★'.repeat(d.collins));
  if (d.oxford) marks.push('牛津 3000');
  for (const t of d.tags) if (TAG_CN[t]) marks.push(TAG_CN[t]);
  // thin spaces around the dot: abandon's eight marks still fit on one line at phone width
  return marks.length ? h('p', { className: 'dchips', 'aria-label': '词典标记', text: marks.join(' · ') }) : null;
}

// ECDICT writes stress as ' and , (secondary), length as :, and schwa as the Cyrillic ә. Shown with the IPA
// marks the model uses; display only, the vowels stay ECDICT's (go /gou/). A comma before a space or a
// hyphen separates two pronunciations ("'eibrәhæm, -hәm") and stays a comma.
export const ipaLook = s => String(s ?? '').replace(/ә/g, 'ə').replace(/ε/g, 'ɛ').replace(/'/g, 'ˈ')
  .replace(/,(?=[^\s-])/g, 'ˌ').replace(/:/g, 'ː');

// The entry's own phonetic; for Youdao imports without one, the dictionary's (shown, never saved).
export function phoneticNode(e, d) {
  if (e.phonetic) return h('span', { className: 'phonetic', lang: 'en', text: e.phonetic });
  if (d && d.phonetic) return h('span', { className: 'phonetic', lang: 'en', title: '来自离线词典', text: `/${ipaLook(d.phonetic)}/` });
  return null;
}

// phonetic, level tag, part of speech: the same line on the word page and the flashcard
export function metaLine(e, d, extra = null) {
  const pos = e.senses && e.senses[0] && e.senses[0].pos;
  const kind = e.kind && e.kind !== 'word' ? String(e.kind).replace('_', ' ') : '';
  return h('p', { className: 'hw-meta' }, phoneticNode(e, d), e.level ? h('span', { className: 'tag', text: e.level }) : null,
    pos || kind ? h('i', { className: 'pos', lang: 'en', text: pos || kind }) : null, extra);
}

// The headword: 44px serif, stepping down for long words; a saved word carries the highlighter stroke.
// sweep draws the stroke once (the moment it is saved); syl shows the syllable dots (only when known beforehand).
export function headwordNode(e, { fav = false, sweep = false, syl = true, tag = 'h1' } = {}) {
  const hw = String(e.headword || '');
  const s = String(e.syllables || '');
  const dots = syl && s && s.replace(/·/g, '').toLowerCase() === hw.toLowerCase();
  // the size follows what is drawn, syllable dots included
  const len = dots ? s.length : hw.length;
  const size = len > 20 ? ' hw-xs' : len > 13 ? ' hw-s' : '';
  const outer = h(tag, { className: 'headword' + size, lang: 'en' });
  const inner = fav ? h('span', { className: 'marked' + (sweep ? ' sweep' : '') }) : outer;
  if (dots) {
    s.split('·').forEach((part, i) => { if (i) inner.append(h('span', { className: 'syl', 'aria-hidden': 'true', text: '·' })); inner.append(part); });
  } else inner.textContent = hw;
  if (fav) outer.append(inner);
  return outer;
}

// Tier 1 of a lookup, and the fallback when the model cannot be reached: the dictionary's word, phonetic,
// marks and short meaning, labeled 离线词典. wrap: the fallback shows the whole meaning, tier 1 one line.
export function dictHead(app, d, { wrap = false, levelSkeleton = false } = {}) {
  const via = d.via && d.via.toLowerCase() !== d.word.toLowerCase() ? d.via : '';
  return h('section', { className: 'ehead' },
    headwordNode({ headword: d.word }),
    h('p', { className: 'hw-meta' },
      d.phonetic ? h('span', { className: 'phonetic', lang: 'en', text: `/${ipaLook(d.phonetic)}/` }) : null,
      levelSkeleton ? h('span', { className: 'pill', 'aria-hidden': 'true' }) : null,
      via ? h('span', { className: 'small', text: `“${via}”的原形` }) : null),
    dictChips(d),
    h('p', { className: 'brief offline' + (wrap ? ' wrap' : '') }, h('span', { className: 'ln', text: d.cn }), h('span', { className: 'src', text: '离线词典' })));
}
// kept for callers that want the meaning as its own block
export function dictMeaning(d) {
  return h('section', { className: 'sec' }, secH('基础释义', h('span', { className: 'st', text: '离线词典' })), h('p', { className: 'dict-cn', text: d.cn }));
}

// skeleton shapes for a part still being written
export const skSenses = () => h('div', { className: 'sk-senses', 'aria-hidden': 'true' },
  h('div', { className: 'hang sk-sense' }, h('span'), skBars([34, 92, 58])),
  h('div', { className: 'hang sk-sense' }, h('span'), skBars([30, 84, 66])));

export function createEntryView(app, { where = 'look', back = null, session = '', scrollRoot = window } = {}) {
  const shell = pageShell(app, { back, scrollRoot });
  const el = shell.el;
  el.dataset.where = where;
  shell.setSession(session);
  const body = shell.body;
  const ixBox = h('section', { className: 'index', 'aria-label': '更多讲解' });
  const slots = {};
  let entry = null;
  const state = { guess: false, notice: '', pulled: false, zhBack: null, regenArm: 0, regenBusy: false, syl: true,
    sweep: false, confirm: false, noteOpen: false, open: new Set() };
  let armTimer = 0, noteTimer = 0, revealTimer = 0;
  let flushNote = null;   // saves a note still waiting for its debounce
  let noteEl = null;
  const onHide = () => { if (document.visibilityState === 'hidden' && flushNote) flushNote(); };
  const onPageHide = () => { if (flushNote) flushNote(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  function flags(e) {
    const st = app.words.enrichStatus(e.slug);
    const loading = st.running;
    const lex = hasLexicon(e), prac = hasPractice(e);
    return { loading, lex, prac, lexSkel: !lex && loading, pracSkel: !prac && loading, errors: st.errors, guess: state.guess };
  }

  const lookupBtn = (word, cls = 'w link') => h('button', { type: 'button', className: cls, lang: 'en', text: word, on: { click: () => app.lookup(String(word || '')) } });
  const pairs = (items, key, valKey, link) => (items && items.length ? h('ul', { className: 'pairs' }, items.map(x => h('li', {},
    link ? lookupBtn(x[key]) : h('b', { className: 'w', lang: 'en', text: x[key] }),
    h('span', { className: 'd', text: x[valKey] || '' })))) : null);

  // one folded index row: the label, a count, + / −; the panel is built with the row and kept while it is open
  function ixRow(name, label, count, makePanel, { skel = false } = {}) {
    const open = !skel && state.open.has(name);
    const btn = h('button', { type: 'button', className: 'row', 'aria-expanded': String(open), disabled: skel },
      h('span', { className: 't', text: label }),
      skel ? h('span', { className: 'c-sk', 'aria-hidden': 'true' }) : h('span', { className: 'c num', text: String(count) }),
      icon('plus', 'plus'), icon('minus', 'minus'));
    const panel = skel ? null : h('div', { className: 'panel' }, makePanel());
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(on));
      if (on) state.open.add(name); else state.open.delete(name);
    });
    return h('div', { className: 'ix', dataset: { ix: name } }, btn, panel);
  }

  const R = {
    notice(e) {
      // a guess that schedules the card past today makes “加进今天的复习” untrue, so it goes away
      const inToday = state.pulled && !!e.favorited && !!e.fsrs && new Date(e.fsrs.due) <= endOfDay(new Date());
      const text = state.notice + (inToday ? '已经把它加进今天的复习。' : '');
      return [sig(text, state.zhBack && state.zhBack.query), () => {
        if (!text && !state.zhBack) return null;
        return h('div', { className: 'e-notice' },
          state.zhBack ? h('button', { type: 'button', className: 'text-btn accent back-zh', on: { click: () => app.backToZh() } },
            icon('back'), `回到“${state.zhBack.query}”的英文说法`) : null,
          text ? h('p', { className: 'small', text }) : null);
      }];
    },
    head(e, f) {
      const rl = relookups(e).length;
      const d = dictFor(app, e);
      const fav = !!e.favorited;
      return [sig(e.headword, e.syllables, e.phonetic, e.senses && e.senses[0] && e.senses[0].pos, e.level, e.kind, fav, rl, e.brief_cn, f.guess, dictSig(d), state.syl), () => {
        const node = h('section', { className: 'ehead' },
          headwordNode(e, { fav, sweep: state.sweep, syl: state.syl }),
          metaLine(e, d),
          dictChips(d),
          rl && !f.guess ? h('p', { className: 'small relook', text: `收藏后又查了 ${rl} 次` }) : null,
          f.guess ? null : h('p', { className: 'brief', text: e.brief_cn || '' }));
        state.sweep = false;
        shell.setTitle(e.headword, fav);
        return node;
      }];
    },
    guess(e, f) {
      return [sig(f.guess, e.slug), () => {
        if (!f.guess) return null;
        let busy = false;   // one tap = one review, also on a double tap or a slow write
        const btns = h('div', { className: 'guess-btns' });
        const go = rating => async () => {
          if (busy) return;
          busy = true;
          for (const b of btns.children) b.disabled = true;
          try {
            const rec = await app.words.review(e.slug, rating, 'guess');
            state.guess = false;
            update();
            const d = new Date(rec.fsrs.due);
            toast(rating === 3 ? `记下了：下次复习 ${localYmd(d) === localYmd(new Date()) ? '今天稍后' : dateCn(localYmd(d))}` : '没关系，今天会再复习它');
          } catch (err) {
            busy = false;
            for (const b of btns.children) b.disabled = false;
            toast(err.message || String(err));
          }
        };
        btns.append(
          h('button', { type: 'button', className: 'btn', text: '我记得', on: { click: go(3) } }),
          h('button', { type: 'button', className: 'text-btn', text: '想不起来', on: { click: go(1) } }));
        return h('section', { className: 'guess' },
          h('p', { className: 'guess-tip', text: '你收藏过它。先想一想它的意思，再看答案。' }), btns);
      }];
    },
    note(e, f) {
      const show = !!e.favorited && !f.guess && (!!e.note || state.noteOpen);
      return [sig(e.slug, show), () => {
        if (flushNote) flushNote();   // the old textarea is about to be replaced
        flushNote = null;
        noteEl = null;
        if (!show) return null;
        const ta = h('textarea', { className: 'note-input', rows: 2, placeholder: '自己的联想、例句。离开输入框自动保存', 'aria-label': '我的笔记' });
        ta.value = e.note || '';
        let saved = ta.value;
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px'; };
        const save = async quiet => {
          clearTimeout(noteTimer);
          if (ta.value === saved) return;
          const v = ta.value;
          try { await app.words.setNote(e.slug, v); saved = v; if (!quiet) toast('笔记已保存'); } catch (err) { toast(err.message || String(err)); }
        };
        ta.addEventListener('input', () => { grow(); clearTimeout(noteTimer); noteTimer = setTimeout(() => save(true), 1200); });
        ta.addEventListener('focus', () => { state.noteOpen = true; shell.setEditing(true); });
        ta.addEventListener('blur', () => { shell.setEditing(false); save(false); });
        flushNote = () => save(true);
        noteEl = ta;
        requestAnimationFrame(grow);
        return h('section', { className: 'sec note-sec' }, secH('笔记'), ta);
      }];
    },
    cn(e, f) {
      const cns = [...new Set((e.history || []).filter(x => x && x.from_cn).map(x => x.from_cn))].slice(-3);
      return [sig(cns, f.guess), () => (!cns.length || f.guess ? null : sec('从中文查到',
        h('div', { className: 'words-inline' }, cns.map(c => h('button', { type: 'button', className: 'text-btn accent', text: c, on: { click: () => app.lookup(c) } })))))];
    },
    ns(e, f) {
      return [sig(!!e.not_standard, f.guess), () => (!e.not_standard || f.guess ? null : h('p', { className: 'status-line ns' }, icon('info'),
        h('span', { text: `模型认为“${e.headword}”不是标准英文词（可能是拼写变体或罕见写法），所以没有生成搭配、阅读和小测。` })))];
    },
    senses(e, f) {
      const writing = !!e.needs_core && f.loading;
      return [sig(e.senses, e.headword, f.guess, writing), () => {
        if (f.guess) return null;
        const ss = e.senses || [];
        if (!ss.length) return writing ? h('section', { className: 'sec' }, secH('释义', h('span', { className: 'st', text: '正在写讲解' })), skSenses()) : null;
        const mixed = ss.some(s => s && s.pos && s.pos !== ss[0].pos);
        return h('section', { className: 'sec' }, secH('释义'),
          h('ol', { className: 'senses' }, ss.map((s, i) => h('li', { className: 'sense hang' },
            h('span', { className: 'mk', text: String(i + 1) }),
            h('div', {},
              h('p', { className: 'cn' }, mixed && s.pos ? h('i', { className: 'pos', lang: 'en', text: s.pos }) : null, s.cn || ''),
              s.en ? h('p', { className: 'en', lang: 'en', text: s.en }) : null,
              s.example ? h('p', { className: 'example', lang: 'en' }, marked(s.example, e.headword), sayBtn(app, s.example)) : null,
              s.example_cn ? h('p', { className: 'example-cn', text: s.example_cn }) : null)))));
      }];
    },
    err(e, f) {
      const missing = !f.lex || !f.prac || !!e.needs_core;
      const show = !f.loading && f.errors && missing && !f.guess;
      const msgs = show ? Object.values(f.errors) : [];
      return [sig(show, msgs), () => (!show ? null : h('p', { className: 'status-line err', role: 'status' }, icon('clock'),
        h('span', { text: '讲解没写全：' + [...new Set(msgs)].join('；') }),
        h('button', { type: 'button', className: 'text-btn accent', text: '重试', on: { click: () => { app.words.enrich(e.slug).catch(() => {}); } } })))];
    },
    ctx(e, f) {
      const ctxs = (e.history || []).filter(x => x && x.context).slice(-3);
      const note = f.guess ? '' : e.context_note || '';
      return [sig(ctxs.map(x => [x.at, x.context]), note, e.headword), () => {
        if (!ctxs.length && !note) return null;
        return h('section', { className: 'sec' }, secH('你遇到它的地方'),
          ctxs.map(x => h('div', { className: 'hang ctx' },
            h('span', { className: 'qmark', lang: 'en', 'aria-hidden': 'true', text: '“' }),
            h('div', {}, h('p', { className: 'quote', lang: 'en' }, marked(x.context, e.headword)), h('p', { className: 'quote-when', text: dateCn(x.at) })))),
          note ? h('p', { className: 'ctx-note', text: note }) : null);
      }];
    },
    mnemo(e, f) {
      const writing = !!e.needs_core && f.loading;
      return [sig(e.mnemonic, writing, f.guess), () => {
        if (f.guess) return null;
        if (e.mnemonic) return sec('巧记', h('p', { className: 'mnemo', text: e.mnemonic }));
        return writing ? sec('巧记', h('div', { className: 'mnemo' }, skBars([94, 88, 40]))) : null;
      }];
    },
    index() { return ['static', () => ixBox]; },
    'ix-coll'(e, f) {
      const n = (e.collocations || []).length;
      return [sig(e.collocations, f.lex, f.lexSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.lex) return f.lexSkel ? ixRow('coll', '搭配', 0, null, { skel: true }) : null;
        return n ? ixRow('coll', '搭配', n, () => pairs(e.collocations, 'phrase', 'cn')) : null;
      }];
    },
    'ix-syn'(e, f) {
      const n = (e.synonyms || []).length;
      return [sig(e.synonyms, f.lex, f.lexSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.lex) return f.lexSkel ? ixRow('syn', '同义词辨析', 0, null, { skel: true }) : null;
        return n ? ixRow('syn', '同义词辨析', n, () => pairs(e.synonyms, 'word', 'diff', true)) : null;
      }];
    },
    'ix-family'(e, f) {
      const r = e.roots || {};
      const fam = e.word_family || [];
      const same = r.same_root || [];
      const n = (r.breakdown ? 1 : 0) + fam.length + same.length;
      return [sig(r, fam, f.lex, f.lexSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.lex) return f.lexSkel ? ixRow('family', '词族与词根', 0, null, { skel: true }) : null;
        if (!n) return null;
        return ixRow('family', '词族与词根', n, () => [
          r.breakdown ? h('p', { className: 'roots-break', lang: 'en', text: r.breakdown }) : null,
          r.explain ? h('p', { className: 'lead', text: r.explain }) : null,
          same.length ? h('div', { className: 'words-inline' }, same.map(x => h('button', { type: 'button', className: 'text-btn word-btn', on: { click: () => app.lookup(String(x.word || '')) } },
            h('b', { lang: 'en', text: x.word }), h('span', { text: x.cn || '' })))) : null,
          fam.length ? h('ul', { className: 'pairs' }, fam.map(x => h('li', {}, h('b', { className: 'w', lang: 'en', text: x.word }),
            h('span', { className: 'd', text: [x.pos, x.cn].filter(Boolean).join(' ') })))) : null]);
      }];
    },
    'ix-ant'(e, f) {
      const n = (e.antonyms || []).length;
      return [sig(e.antonyms, f.lex, f.guess), () => (f.guess || !f.lex || !n ? null : ixRow('ant', '反义词', n, () => pairs(e.antonyms, 'word', 'cn', true)))];
    },
    'ix-conf'(e, f) {
      const n = (e.confusables || []).length;
      return [sig(e.confusables, f.lex, f.lexSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.lex) return f.lexSkel ? ixRow('conf', '易混词', 0, null, { skel: true }) : null;
        return n ? ixRow('conf', '易混词', n, () => pairs(e.confusables, 'word', 'diff', true)) : null;
      }];
    },
    'ix-usage'(e, f) {
      return [sig(e.usage_tip, f.lex, f.guess), () => (f.guess || !f.lex || !e.usage_tip ? null : ixRow('usage', '用法提醒', 1, () => h('p', { className: 'lead', text: e.usage_tip })))];
    },
    'ix-read'(e, f) {
      const rd = e.reading || {};
      const quiz = Array.isArray(e.quiz) ? e.quiz : [];
      const n = quiz.length + (rd.text ? 1 : 0);
      return [sig(rd, quiz, f.prac, f.pracSkel, f.guess, e.headword), () => {
        if (f.guess) return null;
        if (!f.prac) return f.pracSkel ? ixRow('read', '阅读与小测', 0, null, { skel: true }) : null;
        if (!n) return null;
        return ixRow('read', '阅读与小测', n, () => [
          rd.text ? h('div', { className: 'reading-box' },
            h('p', { className: 'reading-title' }, h('span', { lang: 'en', text: rd.title || '' }), sayBtn(app, rd.text, '朗读短文')),
            h('p', { className: 'reading', lang: 'en' }, marked(rd.text, e.headword)),
            rd.cn ? h('details', { className: 'more-cn' }, h('summary', { className: 'text-btn accent', text: '看翻译' }), h('p', { className: 'lead', text: rd.cn })) : null) : null,
          quiz.length ? h('div', { className: 'quiz' }, h('p', { className: 'quiz-h', text: '小测' }), quiz.map((q, i) => quizItem(q, i))) : null]);
      }];
    },
    foot(e, f) {
      const n = lookupEvents(e).length;
      const due = e.favorited && e.fsrs ? localYmd(e.fsrs.due) : '';
      const regenRunning = state.regenBusy || (f.loading && f.lex && f.prac);
      return [sig(n, e.created, e.favorited, e.favorited_at, due, e.source, regenRunning, state.regenArm, f.guess), () => {
        if (f.guess) return null;
        const parts = e.source === 'youdao'
          ? [`从有道单词本导入 · 收藏于 ${dateCn(e.created)}`, `在这里查过 ${n} 次`]
          : [`查过 ${n} 次`, `首次 ${dateCn(e.created)}`, e.favorited && e.favorited_at ? `收藏于 ${dateCn(e.favorited_at)}` : ''];
        if (due) parts.push(due === localYmd(new Date()) ? '今天要复习' : `下次复习 ${dateCn(due)}`);
        const btn = h('button', { type: 'button', className: 'text-btn regen' + (state.regenArm ? ' armed' : ''), disabled: regenRunning,
          text: regenRunning ? '正在重新生成…' : state.regenArm ? '再点一次，确认重新生成' : '重新生成讲解',
          on: { click: () => onRegen(e) } });
        return h('footer', { className: 'efoot' }, h('p', { className: 'small', text: parts.filter(Boolean).join(' · ') }), btn);
      }];
    },
    log(e, f) {
      const ev = lookupEvents(e);
      return [sig(ev.map(x => x.at), e.favorited_at, !!e.favorited, f.guess), () => {
        if (!ev.length || f.guess) return null;
        const favAt = e.favorited ? e.favorited_at || '' : '';
        return h('details', { className: 'lookuplog' }, h('summary', { className: 'text-btn', text: `查询记录（${ev.length} 次）` }),
          h('ul', {}, ev.slice().reverse().map(x => h('li', {},
            h('span', { className: 'when num', text: String(x.at || '').slice(0, 16).replace('T', ' ') }),
            h('span', { text: `查“${x.query || ''}”` + (x.from_cn ? `（从中文“${x.from_cn}”）` : '') }),
            favAt && String(x.at) > favAt ? h('span', { className: 'tag', text: '收藏后' }) : null,
            x.context ? h('span', { className: 'small ctx-snip', text: x.context.length > 60 ? x.context.slice(0, 60) + '…' : x.context }) : null))));
      }];
    },
  };

  function quizItem(q, i) {
    const opts = Array.isArray(q.options) ? q.options : [];
    const ans = Number(q.answer);
    const explain = h('p', { className: 'explain', hidden: true, text: q.explain || '' });
    const box = h('div', { className: 'opts' });
    let done = false;
    opts.forEach((o, j) => box.append(h('button', { type: 'button', className: 'opt', text: String(o), on: { click: ev => {
      if (done) return;
      done = true;
      [...box.children].forEach((b, k) => { if (k === ans) b.classList.add('right'); b.disabled = true; });
      if (j !== ans) ev.currentTarget.classList.add('wrong');
      explain.hidden = false;
    } } })));
    // the first question opens by default, so opening the row shows something to answer
    return h('details', { className: 'q', open: i === 0 },
      h('summary', {}, h('span', { className: 'qn num', text: String(i + 1) }), h('span', { className: 'qq', text: q.question || '' })),
      box, explain);
  }

  function onRegen(e) {
    if (!state.regenArm) {
      state.regenArm = Date.now();
      update();
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { state.regenArm = 0; update(); }, 3000);
      return;
    }
    clearTimeout(armTimer);
    state.regenArm = 0;
    state.regenBusy = true;
    update();
    app.regen(e).finally(() => { state.regenBusy = false; update(); });
  }

  // ---------------------------------------------------------------- action bar
  let barSig = null;
  function renderBar(e) {
    const s = sig(e.slug, !!e.favorited, state.confirm);
    if (s === barSig) return;
    barSig = s;
    const fav = !!e.favorited;
    const sayB = h('button', { type: 'button', className: 'text-btn', on: { click: ev => app.say(e.headword, ev.currentTarget) } }, icon('speak'), '发音');
    const noteB = h('button', { type: 'button', className: 'text-btn', on: { click: openNote } }, icon('note'), '笔记');
    let row;
    if (state.confirm) {
      // one tap on 已在词库 never removes the word: the bar asks first
      row = h('div', { className: 'bar-confirm', role: 'group', 'aria-label': '移出词库' },
        h('p', { className: 'small', text: '记录都留着，回到“最近查过”' }),
        h('button', { type: 'button', className: 'text-btn', text: '取消', on: { click: () => { state.confirm = false; renderBar(entry); } } }),
        h('button', { type: 'button', className: 'text-btn on', text: '移出词库', on: { click: async () => {
          state.confirm = false;
          await app.toggleFav(e.slug, false);
          renderBar(entry);
        } } }));
    } else {
      const save = h('button', { type: 'button', className: 'btn save' + (fav ? ' saved' : ''), 'aria-pressed': String(fav),
        on: { click: async () => {
          if (entry.favorited) { state.confirm = true; renderBar(entry); return; }
          state.sweep = true;
          await app.toggleFav(e.slug, true);
          state.sweep = false;
        } } },
      fav ? [icon('check'), '已在词库'] : [icon('pen'), '划进词库']);
      row = h('div', { className: 'bar-main' }, sayB, save, noteB);
    }
    shell.bar.replaceChildren(row);
  }

  function openNote() {
    if (!entry) return;
    if (!entry.favorited) { toast('先划进词库，才能写笔记'); return; }
    state.noteOpen = true;
    update();
    if (noteEl) {
      noteEl.focus();
      noteEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function update(next) {
    if (next) entry = next;
    const e = entry;
    if (!e) return;
    const f = flags(e);
    for (const name of ORDER) {
      const [s, make] = R[name](e, f);
      const slot = slots[name];
      if (slot && slot.sig === s) continue;
      const node = make() || document.createComment(name);
      const parent = name.startsWith('ix-') ? ixBox : body;
      if (slot) slot.node.replaceWith(node); else parent.append(node);
      slots[name] = { node, sig: s };
    }
    ixBox.hidden = !ixBox.querySelector('.ix');
    renderBar(e);
  }

  return {
    el,
    get slug() { return entry ? entry.slug : null; },
    get entry() { return entry; },
    show(e, opts = {}) {
      entry = e;
      state.guess = !!opts.guess;
      state.notice = opts.notice || '';
      state.pulled = !!opts.pulled;
      state.zhBack = opts.zhBack || null;
      state.syl = opts.syl !== false;
      // the first paint cascades in; later updates (lexicon, practice) must not replay it
      body.classList.add('reveal');
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => body.classList.remove('reveal'), 900);
      update();
    },
    update,
    setNotice(text) { state.notice = text || ''; update(); },
    setSession: t => shell.setSession(t),
    destroy() {
      if (flushNote) flushNote();
      flushNote = null;
      clearTimeout(armTimer); clearTimeout(noteTimer); clearTimeout(revealTimer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      shell.destroy();
    },
  };
}

// ---------------------------------------------------------------- Chinese -> English

export function renderZh(app, d, { onPick }) {
  const options = Array.isArray(d.options) ? d.options : [];
  const best = Number.isInteger(d.best) && options[d.best] ? d.best : 0;
  return h('div', { className: 'zh' },
    h('section', { className: 'ehead zh-head' },
      h('p', { className: 'label', text: '中文 → 英文' + (d.scene ? ' · 场景：' + d.scene : '') }),
      h('h1', { className: 'zh-q', text: d.query || '' }),
      d.translation ? h('p', { className: 'zh-trans', lang: 'en' }, h('span', { text: d.translation }), sayBtn(app, d.translation)) : null,
      d.explain ? h('p', { className: 'lead', text: d.explain }) : null),
    h('ol', { className: 'zh-opts' }, options.map((o, i) => h('li', { className: 'zh-opt' + (i === best ? ' best' : '') },
      h('div', { className: 'zh-top' },
        h('button', { type: 'button', className: 'zh-en', lang: 'en', text: o.en, on: { click: () => onPick(o.en, d.query) } }),
        sayBtn(app, o.en),
        i === best ? h('span', { className: 'tag best-tag', text: '推荐' }) : null,
        h('span', { className: 'zh-pos', text: [o.pos, o.level].filter(Boolean).join(' · ') })),
      h('p', { className: 'zh-cn' }, h('b', { text: o.cn || '' }), o.nuance ? h('span', { className: 'muted', text: ' · ' + o.nuance }) : null),
      o.example ? h('p', { className: 'example', lang: 'en' }, marked(o.example, o.en), sayBtn(app, o.example)) : null,
      o.example_cn ? h('p', { className: 'example-cn', text: o.example_cn }) : null,
      h('button', { type: 'button', className: 'text-btn accent zh-more', on: { click: () => onPick(o.en, d.query) } }, '看完整讲解，决定要不要收藏', icon('chev'))))));
}
