// Word page (SPEC 2.1) and Chinese -> English result (SPEC 2.1b).
// The page is split into slots; on every data change only the slots whose content changed are rebuilt,
// so a quiz answer, an open <details> or a note being typed survive the lexicon/practice parts arriving.
import { h, icon, marked, skeleton, toast, ymd, md, localYmd } from './ui-dom.js';
import { hasLexicon, hasPractice, lookupEvents, relookups } from './words.js';
import { endOfDay } from './fsrs.js';
import { TAG_CN } from './dict.js';

const ORDER = ['notice', 'head', 'cn', 'ctx', 'guess', 'ns', 'senses', 'mnemo', 'roots', 'quiz', 'coll', 'syn',
  'reading', 'family', 'ant', 'conf', 'usage', 'err', 'note', 'foot', 'log'];

const sec = (label, ...body) => h('section', { className: 'sec' }, h('h3', { className: 'label', text: label }), ...body);
const list = (items, fmt) => (items && items.length ? h('ul', { className: 'plain' }, items.map(fmt)) : null);
const sig = (...parts) => JSON.stringify(parts);

export function sayBtn(app, text, label = '朗读') {
  return h('button', { type: 'button', className: 'say', 'aria-label': label, on: { click: ev => { ev.stopPropagation(); app.say(text, ev.currentTarget); } } }, icon('speak'));
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
  return marks.length ? h('div', { className: 'dchips', 'aria-label': '词典标记', text: marks.join('\u2009·\u2009') }) : null;
}

// ECDICT writes stress as ' and , (secondary), length as :, and schwa as the Cyrillic ә. Shown with the IPA
// marks the model uses; display only, the vowels stay ECDICT's (go /gou/). A comma before a space or a
// hyphen separates two pronunciations ("'eibrәhæm, -hәm") and stays a comma.
export const ipaLook = s => String(s ?? '').replace(/ә/g, 'ə').replace(/ε/g, 'ɛ').replace(/'/g, 'ˈ')
  .replace(/,(?=[^\s-])/g, 'ˌ').replace(/:/g, 'ː');

// The entry's own phonetic; for Youdao imports without one, the dictionary's (shown, never saved).
export function phoneticNode(e, d, tag = 'span') {
  if (e.phonetic) return h(tag, { className: 'ipa', text: e.phonetic });
  if (d && d.phonetic) return h(tag, { className: 'ipa', title: '来自离线词典', text: `/${ipaLook(d.phonetic)}/` });
  return null;
}

// Tier 1 of a lookup, and the fallback when the model cannot be reached: the dictionary's word, phonetic,
// marks and short meaning, labeled as the basic meaning.
export function dictHead(app, d, query) {
  const via = d.via && d.via.toLowerCase() !== d.word.toLowerCase() ? d.via : '';
  return h('header', { className: 'entry-head' },
    h('div', { className: 'hw-line' }, headwordNode({ headword: d.word }),
      h('button', { type: 'button', className: 'speak', 'aria-label': '发音', on: { click: ev => app.say(d.word, ev.currentTarget) } }, icon('speak'))),
    h('div', { className: 'meta' },
      d.phonetic ? h('span', { className: 'ipa', text: `/${ipaLook(d.phonetic)}/` }) : null,
      via ? h('span', { className: 'small muted', text: `“${via}”的原形` }) : null),
    dictChips(d));
}
export function dictMeaning(d) {
  return h('section', { className: 'sec dict-sec' },
    h('h3', { className: 'label', text: '基础释义 · 离线词典' }),
    h('p', { className: 'dict-cn', text: d.cn }));
}

export function headwordNode(e, { kept = false, className = 'hw' } = {}) {
  const hw = String(e.headword || '');
  const syl = String(e.syllables || '');
  const len = hw.length;
  const size = len > 22 ? ' hw-xs' : len > 14 ? ' hw-s' : '';
  const node = h('span', { className: className + size + (kept ? ' kept' : ''), lang: 'en' });
  if (syl && syl.replace(/·/g, '').toLowerCase() === hw.toLowerCase()) {
    syl.split('·').forEach((part, i) => { if (i) node.append(h('span', { className: 'syl', text: '·' })); node.append(part); });
  } else node.textContent = hw;
  return node;
}

export function createEntryView(app, { where = 'look' } = {}) {
  const el = h('article', { className: 'entry', dataset: { where } });
  const slots = {};
  let entry = null;
  const state = { guess: false, notice: '', pulled: false, zhBack: null, regenArm: 0, regenBusy: false };
  let armTimer = 0, noteTimer = 0;
  let flushNote = null;   // saves a note still waiting for its debounce
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

  const pairs = (items, key, valKey, link) => list(items, x => h('li', { className: 'pair' },
    link ? h('button', { type: 'button', className: 'w link', lang: 'en', text: x[key], on: { click: () => app.lookup(String(x[key] || '')) } })
      : h('span', { className: 'w', lang: 'en', text: x[key] }),
    h('span', { className: 'd', text: x[valKey] })));

  const R = {
    notice(e) {
      // a guess that schedules the card past today makes “加进今天的复习” untrue, so it goes away
      const inToday = state.pulled && !!e.favorited && !!e.fsrs && new Date(e.fsrs.due) <= endOfDay(new Date());
      const text = state.notice + (inToday ? '已经把它加进今天的复习。' : '');
      return [sig(text, state.zhBack && state.zhBack.query), () => {
        if (!text && !state.zhBack) return null;
        return h('div', { className: 'notice' },
          state.zhBack ? h('button', { type: 'button', className: 'textbtn back-zh', on: { click: () => app.backToZh() } },
            icon('back', 'ic ic-s'), `回到“${state.zhBack.query}”的英文说法`) : null,
          text ? h('div', { className: 'notice-text', text }) : null);
      }];
    },
    head(e, f) {
      const rl = relookups(e).length;
      const d = dictFor(app, e);
      return [sig(e.headword, e.syllables, e.phonetic, e.senses && e.senses[0] && e.senses[0].pos, e.level, e.kind, !!e.favorited, rl, e.brief_cn, f.guess, dictSig(d)), () => {
        const fav = !!e.favorited;
        const labels = [e.senses && e.senses[0] && e.senses[0].pos, e.level, e.kind && e.kind !== 'word' ? String(e.kind).replace('_', ' ') : ''].filter(Boolean).join(' · ');
        return h('header', { className: 'entry-head' },
          h('div', { className: 'hw-line' }, headwordNode(e, { kept: fav }),
            h('button', { type: 'button', className: 'speak', 'aria-label': '发音', on: { click: ev => app.say(e.headword, ev.currentTarget) } }, icon('speak'))),
          h('div', { className: 'meta' },
            phoneticNode(e, d),
            labels ? h('span', { className: 'label', text: labels }) : null,
            rl && !f.guess ? h('span', { className: 'relook', text: `收藏后又查了 ${rl} 次` }) : null),
          dictChips(d),
          f.guess ? null : h('div', { className: 'brief', text: e.brief_cn || '' }),
          f.guess ? null : h('div', { className: 'head-actions' },
            h('button', { type: 'button', className: 'fav' + (fav ? ' on' : ''), 'aria-pressed': String(fav),
              on: { click: () => app.toggleFav(e.slug, !e.favorited) } },
            icon(fav ? 'starOn' : 'star'), fav ? '已收藏' : '收藏')));
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
            toast(rating === 3 ? `记下了：下次复习 ${localYmd(d) === localYmd(new Date()) ? '今天稍后' : md(localYmd(d))}` : '没关系，今天会再复习它');
          } catch (err) {
            busy = false;
            for (const b of btns.children) b.disabled = false;
            toast(err.message || String(err));
          }
        };
        btns.append(
          h('button', { type: 'button', className: 'btn primary', text: '我记得', on: { click: go(3) } }),
          h('button', { type: 'button', className: 'btn', text: '想不起来', on: { click: go(1) } }));
        return h('div', { className: 'guess' },
          h('p', { className: 'guess-tip', text: '你收藏过它。先想一想它的意思，再看答案。' }), btns);
      }];
    },
    cn(e, f) {
      const cns = [...new Set((e.history || []).filter(x => x && x.from_cn).map(x => x.from_cn))].slice(-3);
      return [sig(cns, f.guess), () => (!cns.length || f.guess ? null : sec('从中文查到',
        h('div', { className: 'chips' }, cns.map(c => h('button', { type: 'button', className: 'chip', text: c, on: { click: () => app.lookup(c) } })))))];
    },
    ctx(e, f) {
      const ctxs = (e.history || []).filter(x => x && x.context).slice(-3);
      const note = f.guess ? '' : e.context_note || '';
      return [sig(ctxs.map(x => [x.at, x.context]), note, e.headword), () => {
        if (!ctxs.length && !note) return null;
        return sec('原句',
          ctxs.map(x => h('div', { className: 'quote', lang: 'en' }, marked(x.context, e.headword), h('span', { className: 'when', text: ymd(x.at) }))),
          note ? h('p', { className: 'note-text', text: note }) : null);
      }];
    },
    ns(e, f) {
      return [sig(!!e.not_standard, f.guess), () => (!e.not_standard || f.guess ? null : sec('提示',
        h('p', { className: 'small', text: `模型认为“${e.headword}”不是标准英文词（可能是拼写变体或罕见写法），所以没有生成搭配、阅读和小测。可以在上面查正确拼写。` })))];
    },
    senses(e, f) {
      return [sig(e.senses, e.headword, f.guess, !!e.needs_core && f.loading), () => {
        if (f.guess) return null;
        if (!(e.senses && e.senses.length)) return e.needs_core && f.loading ? skeleton('释义') : null;
        return sec('释义', list(e.senses, s => h('li', { className: 'sense' },
          h('div', {}, s.pos ? h('b', { className: 'pos', text: s.pos }) : null, h('span', { text: s.cn || '' }),
            s.en ? h('span', { className: 'en', lang: 'en', text: ' · ' + s.en }) : null),
          s.example ? h('div', { className: 'ex' },
            h('span', { lang: 'en' }, marked(s.example, e.headword)), sayBtn(app, s.example),
            s.example_cn ? h('span', { className: 'cn', text: s.example_cn }) : null) : null)));
      }];
    },
    mnemo(e, f) {
      return [sig(e.mnemonic, !!e.needs_core && f.loading, f.guess), () => {
        if (f.guess) return null;
        if (e.mnemonic) return sec('巧记', h('div', { className: 'mnemo', text: e.mnemonic }));
        return e.needs_core && f.loading ? skeleton('巧记', [80, 60]) : null;
      }];
    },
    roots(e, f) {
      const r = e.roots || {};
      return [sig(r, f.lex, f.lexSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.lex) return f.lexSkel ? skeleton('词根词缀', [70, 88]) : null;
        if (!r.breakdown) return null;
        return sec('词根词缀', h('div', { className: 'roots-break', text: r.breakdown }),
          r.explain ? h('p', { className: 'muted small', text: r.explain }) : null,
          r.same_root && r.same_root.length ? h('div', { className: 'chips' }, r.same_root.map(x =>
            h('button', { type: 'button', className: 'chip', on: { click: () => app.lookup(String(x.word || '')) } },
              h('span', { lang: 'en', text: x.word }), ' ', h('span', { className: 'muted', text: x.cn || '' })))) : null);
      }];
    },
    quiz(e, f) {
      return [sig(e.quiz, f.prac, f.pracSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.prac) return f.pracSkel ? skeleton('小测', [88, 50, 50]) : null;
        if (!(e.quiz && e.quiz.length)) return null;
        return sec('小测', e.quiz.map((q, i) => quizItem(q, i)));
      }];
    },
    coll(e, f) {
      return [sig(e.collocations, f.lex, f.lexSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.lex) return f.lexSkel ? skeleton('常用搭配') : null;
        const l = pairs(e.collocations, 'phrase', 'cn');
        return l ? sec('常用搭配', l) : null;
      }];
    },
    syn(e, f) {
      return [sig(e.synonyms, f.lex, f.lexSkel, f.guess), () => {
        if (f.guess) return null;
        if (!f.lex) return f.lexSkel ? skeleton('同义词辨析') : null;
        const l = pairs(e.synonyms, 'word', 'diff', true);
        return l ? sec('同义词辨析', l) : null;
      }];
    },
    reading(e, f) {
      const rd = e.reading || {};
      return [sig(rd, f.prac, f.pracSkel, f.guess, e.headword), () => {
        if (f.guess) return null;
        if (!f.prac) return f.pracSkel ? skeleton('扩展阅读', [94, 90, 96, 60]) : null;
        if (!rd.text) return null;
        return sec('扩展阅读',
          h('div', { className: 'reading-title' }, h('span', { lang: 'en', text: rd.title || '' }), sayBtn(app, rd.text, '朗读短文')),
          h('p', { className: 'reading', lang: 'en' }, marked(rd.text, e.headword)),
          rd.cn ? h('details', { className: 'more-cn' }, h('summary', { text: '看翻译' }), h('p', { className: 'muted', text: rd.cn })) : null);
      }];
    },
    family(e, f) {
      return [sig(e.word_family, f.lex, f.guess), () => {
        if (f.guess || !f.lex) return null;
        const l = list(e.word_family, x => h('li', { className: 'pair' }, h('span', { className: 'w', lang: 'en', text: x.word }),
          h('span', { className: 'd', text: [x.pos, x.cn].filter(Boolean).join(' ') })));
        return l ? sec('词族', l) : null;
      }];
    },
    ant(e, f) {
      return [sig(e.antonyms, f.lex, f.guess), () => {
        if (f.guess || !f.lex) return null;
        const l = pairs(e.antonyms, 'word', 'cn', true);
        return l ? sec('反义词', l) : null;
      }];
    },
    conf(e, f) {
      return [sig(e.confusables, f.lex, f.guess), () => {
        if (f.guess || !f.lex) return null;
        const l = pairs(e.confusables, 'word', 'diff', true);
        return l ? sec('易混词', l) : null;
      }];
    },
    usage(e, f) {
      return [sig(e.usage_tip, f.lex, f.guess), () => (f.guess || !f.lex || !e.usage_tip ? null : sec('用法提醒', h('p', { className: 'small', text: e.usage_tip })))];
    },
    err(e, f) {
      const missing = !f.lex || !f.prac || !!e.needs_core;
      const show = !f.loading && f.errors && missing && !f.guess;
      const msgs = show ? Object.values(f.errors) : [];
      return [sig(show, msgs), () => (!show ? null : h('div', { className: 'err-box' },
        h('p', { text: '补充讲解没生成出来：' + [...new Set(msgs)].join('；') }),
        h('button', { type: 'button', className: 'btn small-btn', on: { click: () => { app.words.enrich(e.slug).catch(() => {}); } } }, icon('refresh', 'ic ic-s'), '再试一次')))];
    },
    note(e, f) {
      return [sig(e.slug, !!e.favorited, f.guess), () => {
        if (flushNote) flushNote();   // the old textarea is about to be replaced
        flushNote = null;
        if (!e.favorited || f.guess) return null;
        const ta = h('textarea', { className: 'note', rows: 3, placeholder: '自己的联想、例句。离开输入框自动保存', 'aria-label': '我的笔记' });
        ta.value = e.note || '';
        let saved = ta.value;
        const save = async quiet => {
          clearTimeout(noteTimer);
          if (ta.value === saved) return;
          const v = ta.value;
          try { await app.words.setNote(e.slug, v); saved = v; if (!quiet) toast('笔记已保存'); } catch (err) { toast(err.message || String(err)); }
        };
        ta.addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(() => save(true), 1200); });
        ta.addEventListener('blur', () => save(false));
        flushNote = () => save(true);
        return sec('我的笔记', ta);
      }];
    },
    foot(e, f) {
      const n = lookupEvents(e).length;
      const due = e.favorited && e.fsrs ? localYmd(e.fsrs.due) : '';
      const regenRunning = state.regenBusy || (f.loading && f.lex && f.prac);
      return [sig(n, e.created, e.favorited, e.favorited_at, due, e.source, regenRunning, state.regenArm, f.guess), () => {
        if (f.guess) return null;
        const parts = e.source === 'youdao'
          ? [`从有道单词本导入 · 收藏于 ${ymd(e.created)}`, `在这里查过 ${n} 次`]
          : [`查过 ${n} 次`, `首次 ${ymd(e.created)}`, e.favorited && e.favorited_at ? `收藏于 ${ymd(e.favorited_at)}` : ''];
        if (due) parts.push(`下次复习 ${due === localYmd(new Date()) ? '今天' : md(due)}`);
        const btn = h('button', { type: 'button', className: 'textbtn regen' + (state.regenArm ? ' armed' : ''), disabled: regenRunning,
          text: regenRunning ? '正在重新生成…' : state.regenArm ? '再点一次，确认重新生成' : '重新生成讲解',
          on: { click: () => onRegen(e) } });
        return h('footer', { className: 'foot' }, h('span', { className: 'small muted', text: parts.filter(Boolean).join(' · ') }), btn);
      }];
    },
    log(e, f) {
      const ev = lookupEvents(e);
      return [sig(ev.map(x => x.at), e.favorited_at, !!e.favorited, f.guess), () => {
        if (!ev.length || f.guess) return null;
        const favAt = e.favorited ? e.favorited_at || '' : '';
        return h('details', { className: 'lookuplog' }, h('summary', { text: `查询记录（${ev.length} 次）` }),
          h('ul', { className: 'plain' }, ev.slice().reverse().map(x => h('li', {},
            h('span', { className: 'when', text: String(x.at || '').slice(0, 16).replace('T', ' ') }),
            h('span', { text: `查“${x.query || ''}”` + (x.from_cn ? `（从中文“${x.from_cn}”）` : '') }),
            favAt && String(x.at) > favAt ? h('span', { className: 'tag', text: '收藏后' }) : null,
            x.context ? h('span', { className: 'muted small ctx-snip', text: '· ' + (x.context.length > 60 ? x.context.slice(0, 60) + '…' : x.context) }) : null))));
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
    return h('details', { className: 'q', open: i === 0 },
      h('summary', {}, h('span', { className: 'qn', text: String(i + 1) }), h('span', { className: 'qq', text: q.question || '' })),
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
      if (slot) slot.node.replaceWith(node); else el.append(node);
      slots[name] = { node, sig: s };
    }
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
      update();
    },
    update,
    setNotice(text) { state.notice = text || ''; update(); },
    destroy() {
      if (flushNote) flushNote();
      flushNote = null;
      clearTimeout(armTimer); clearTimeout(noteTimer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      el.remove();
    },
  };
}

// ---------------------------------------------------------------- Chinese -> English

export function renderZh(app, d, { onPick }) {
  const options = Array.isArray(d.options) ? d.options : [];
  const best = Number.isInteger(d.best) && options[d.best] ? d.best : 0;
  return h('article', { className: 'entry zh' },
    h('header', { className: 'entry-head zh-head' },
      h('span', { className: 'label', text: '中文 → 英文' + (d.scene ? ' · 场景：' + d.scene : '') }),
      h('div', { className: 'zh-q', text: d.query || '' }),
      d.translation ? h('div', { className: 'zh-trans', lang: 'en' }, h('span', { text: d.translation }), sayBtn(app, d.translation)) : null,
      d.explain ? h('p', { className: 'note-text muted', text: d.explain }) : null),
    h('div', { className: 'zh-opts' }, options.map((o, i) => h('div', { className: 'zh-opt' + (i === best ? ' best' : '') },
      h('div', { className: 'zh-top' },
        h('button', { type: 'button', className: 'zh-en', lang: 'en', text: o.en, on: { click: () => onPick(o.en, d.query) } }),
        sayBtn(app, o.en),
        i === best ? h('span', { className: 'zh-badge', text: '推荐' }) : null,
        h('span', { className: 'label', text: [o.pos, o.level].filter(Boolean).join(' · ') })),
      h('div', { className: 'zh-cn' }, h('b', { text: o.cn || '' }), o.nuance ? h('span', { className: 'muted', text: ' · ' + o.nuance }) : null),
      o.example ? h('div', { className: 'ex' }, h('span', { lang: 'en' }, marked(o.example, o.en)), sayBtn(app, o.example),
        o.example_cn ? h('span', { className: 'cn', text: o.example_cn }) : null) : null,
      h('button', { type: 'button', className: 'textbtn zh-more', text: '看完整讲解，决定要不要收藏 →', on: { click: () => onPick(o.en, d.query) } })))));
}
