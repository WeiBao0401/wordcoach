// 复习 tab (SPEC 2.3, design v2 4.4): one serif sentence saying what today holds, one 开始 button.
// A round is run by session.js; how a card looks and how it is answered is a "mode". Today there is one mode,
// the flashcard (tap anywhere to flip, four rating buttons with interval previews, swipe left/right/up).
// Later modes (quiz, dictation, story, cloze) plug in as more entries of MODES with the same shape:
//   mode.render(entry, ctx) -> { el, footer, onKey(ev) }
//   ctx: { rate(rating, {fromSwipe}), openFull(), say(text, button), app, position: {n, total, isNew}, isTall() }
import { h, icon, marked, toast, prefersReducedMotion, dateCn } from './ui-dom.js';
import { headwordNode, metaLine, dictFor } from './ui-entry.js';
import { previewIntervals, endOfDay, State } from './fsrs.js';
import { createSession, minutesFor } from './session.js';

const NAMES = { 1: '忘了', 2: '模糊', 3: '记得', 4: '很熟' };
const SWIPE = 90;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ---------------------------------------------------------------- mode: flashcard
function contextFor(e) {
  const c = (e.history || []).filter(x => x && x.context).pop();
  if (c) return { text: c.context, when: dateCn(c.at) };
  const ex = (e.senses || []).find(s => s && s.example);
  return ex ? { text: ex.example, when: '例句' } : null;
}
const quoteBlock = (ctx, hw) => h('div', { className: 'hang' },
  h('span', { className: 'qmark', lang: 'en', 'aria-hidden': 'true', text: '“' }),
  h('div', {}, h('blockquote', { className: 'quote card-quote', lang: 'en' }, marked(ctx.text, hw)), ctx.when ? h('p', { className: 'quote-when', text: ctx.when }) : null));

export const flashcard = {
  id: 'card',
  label: '闪卡',
  render(e, ctx) {
    const { app } = ctx;
    let flipped = false;
    const quote = contextFor(e);
    const speak = h('button', { type: 'button', className: 'speak', 'aria-label': '发音', on: { click: ev => { ev.stopPropagation(); ctx.say(e.headword, ev.currentTarget); } } }, icon('speak'));
    const head = h('div', { className: 'card-head' }, headwordNode(e, { tag: 'h2' }), metaLine(e, dictFor(app, e), speak));
    const front = h('div', { className: 'front-only' }, quote ? quoteBlock(quote, e.headword) : null);
    const back = h('div', { className: 'back-only reveal', hidden: true });
    const tags = { left: h('div', { className: 'swipe-tag left', text: '忘了' }), right: h('div', { className: 'swipe-tag right', text: '记得' }), up: h('div', { className: 'swipe-tag up', text: '很熟' }) };
    const card = h('article', { className: 'card', tabIndex: 0, role: 'button', 'aria-label': '点一下看释义' }, tags.left, tags.right, tags.up, head, front, back);
    const hint = h('p', { className: 'hint', 'aria-hidden': 'true', text: '点一下看释义' });
    const iv = previewIntervals(e.fsrs || {}, new Date());
    const grades = h('footer', { className: 'grades', hidden: true, 'aria-label': '记得怎么样' }, h('div', { className: 'row4' },
      [1, 2, 3, 4].map(g => h('button', { type: 'button', className: 'g' + g, on: { click: () => ctx.rate(g) } },
        h('b', { text: NAMES[g] }), h('span', { className: 'iv', text: iv[g] })))));

    function backSide() {
      const ss = (e.senses || []).slice(0, 3);
      const mixed = ss.some(x => x && x.pos && x.pos !== ss[0].pos);
      return [
        h('p', { className: 'brief', style: '--i:0', text: e.brief_cn || '' }),
        ss.map((s, i) => h('div', { className: 'hang blk' + (i ? '' : ' first'), style: `--i:${i + 1}` },
          h('span', { className: 'mk', text: String(i + 1) }),
          h('div', {},
            h('p', { className: 'cn' }, mixed && s.pos ? h('i', { className: 'pos', lang: 'en', text: s.pos }) : null, s.cn || ''),
            s.en && i === 0 ? h('p', { className: 'def', lang: 'en', text: s.en }) : null,
            s.example && i === 0 && !(quote && quote.text === s.example) ? h('p', { className: 'example', lang: 'en' }, marked(s.example, e.headword)) : null))),
        quote ? h('div', { className: 'blk', style: '--i:4' }, quoteBlock(quote, e.headword)) : null,
        e.mnemonic ? h('p', { className: 'mnemo blk', style: '--i:5', text: e.mnemonic }) : null,
        e.note ? h('p', { className: 'small blk card-note', style: '--i:6', text: '笔记：' + e.note }) : null,
        h('button', { type: 'button', className: 'text-btn accent more', style: '--i:7', on: { click: ev => { ev.stopPropagation(); ctx.openFull(); } } }, '看完整讲解', icon('chev'))];
    }

    function flip() {
      if (flipped) return;
      flipped = true;
      // the headword glides from the middle of the page to the top, the meaning rises in under it
      const before = head.getBoundingClientRect().top;
      back.replaceChildren(...backSide().flat().filter(Boolean));
      back.hidden = false;
      front.hidden = true;
      hint.hidden = true;
      grades.hidden = false;
      card.classList.add('flipped');
      card.setAttribute('aria-label', '卡片背面');
      if (!prefersReducedMotion()) {
        const dy = before - head.getBoundingClientRect().top;
        head.style.transition = 'none';
        head.style.transform = `translateY(${dy}px)`;
        head.getBoundingClientRect();
        head.style.transition = 'transform .42s var(--ease)';
        head.style.transform = '';
      }
      afterLayout();
    }

    // The page only scrolls when this card is taller than the screen. Then dragging up must scroll (pan-y),
    // not rate the card 很熟; 很熟 is still on the rating buttons.
    let noUp = false;
    function afterLayout() {
      requestAnimationFrame(() => {
        noUp = ctx.isTall();
        card.style.touchAction = noUp ? 'pan-y' : 'none';
        tags.up.hidden = noUp;
      });
    }

    // ------------------------------------------------ swipe (also before flipping)
    let x0 = 0, y0 = 0, dx = 0, dy = 0, id = null, moved = false;
    const dir = () => (!noUp && -dy > SWIPE && -dy > Math.abs(dx) ? 'up' : dx < -SWIPE ? 'left' : dx > SWIPE ? 'right' : '');
    const paint = () => {
      card.style.transform = `translate(${dx}px, ${Math.min(dy, 40)}px) rotate(${dx / 24}deg)`;
      const d = dir();
      const p = Math.min(1, Math.max(Math.abs(dx), -dy) / SWIPE);
      for (const [k, t] of Object.entries(tags)) t.style.opacity = k === d ? '1' : (k === (dx < 0 ? 'left' : 'right') && Math.abs(dx) > -dy ? String(p * 0.5) : k === 'up' && -dy > Math.abs(dx) ? String(p * 0.5) : '0');
    };
    card.addEventListener('pointerdown', ev => {
      if (ev.target.closest('button, a, summary') || ctx.busy()) return;
      id = ev.pointerId; x0 = ev.clientX; y0 = ev.clientY; dx = dy = 0; moved = false;
      try { card.setPointerCapture(id); } catch (err) { /* synthetic or already released pointer */ }
      card.classList.add('dragging');
    });
    card.addEventListener('pointermove', ev => {
      if (ev.pointerId !== id) return;
      dx = ev.clientX - x0; dy = ev.clientY - y0;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      if (moved) paint();
    });
    const end = ev => {
      if (ev.pointerId !== id) return;
      id = null;
      card.classList.remove('dragging');
      const d = dir();
      if (!moved) { card.style.transform = ''; if (ev.type === 'pointerup') flip(); return; }
      if (!d || ev.type === 'pointercancel') {
        card.style.transform = '';
        for (const t of Object.values(tags)) t.style.opacity = '0';
        return;
      }
      const g = d === 'left' ? 1 : d === 'right' ? 3 : 4;
      if (prefersReducedMotion()) { ctx.rate(g, { fromSwipe: true }); return; }
      card.classList.add('fly');
      card.style.transform = d === 'up' ? `translate(${dx}px, -120vh)` : `translate(${d === 'left' ? '-' : ''}130vw, ${dy}px) rotate(${dx / 10}deg)`;
      setTimeout(() => ctx.rate(g, { fromSwipe: true }), 180);
      toast(NAMES[g], 900);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    card.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && !flipped) { ev.preventDefault(); flip(); } });
    afterLayout();

    return {
      el: card,
      footer: [hint, grades],
      // keyboard for desktop testing: space flips, 1-4 rate
      onKey(ev) {
        if (ev.key === ' ' && !flipped) { ev.preventDefault(); flip(); }
        else if (flipped && '1234'.includes(ev.key) && ev.key.length === 1) ctx.rate(+ev.key);
      },
      flipped: () => flipped,
      flip,
    };
  },
};

export const MODES = { card: flashcard };

// ---------------------------------------------------------------- tab
export function createReviewTab(app) {
  const root = document.getElementById('tab-review');
  root.replaceChildren();
  const statusSlot = h('div', { className: 'status-slot' });
  const dateEl = h('span', { className: 'runhead-meta' });
  const home = h('div', { className: 'rv-home' });
  const homeView = h('div', { className: 'rv-screen' }, h('header', { className: 'runhead' }, h('h1', { className: 'runhead-title', text: '复习' }), dateEl), statusSlot, home);
  const stage = h('div', { className: 'rv-stage', hidden: true });
  root.append(homeView, stage);
  app.statusSlot(statusSlot);

  let session = null;   // createSession(...)
  let modeView = null;  // what the mode rendered for the current card
  let finished = null;  // the last round, for the done sentence
  let modeId = 'card';

  const dateLine = () => { const d = new Date(); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEK[d.getDay()]}`; };

  // ---------------------------------------------------------------- home
  function renderHome() {
    dateEl.textContent = dateLine();
    if (finished) { renderDone(); return; }
    const per = app.settings().newPerDay;
    const q = app.words.reviewQueue(per);
    const total = q.due.length + q.fresh.length;
    const lib = app.words.favorites().length;
    const today = app.words.reviewedToday();
    const later = q.freshTotal > q.fresh.length ? `（还有 ${q.freshTotal - q.fresh.length} 个新词排在以后）` : '';
    const n = x => h('span', { className: 'n', text: String(x) });
    let lede, meta, action = null;
    if (total) {
      lede = h('p', { className: 'lede', style: '--i:0' }, '今天要复习 ', n(total), ' 个词，', h('br'), '大约 ', n(minutesFor(total)), ' 分钟。');
      meta = h('p', { className: 'small meta', style: '--i:1' }, '到期 ', h('span', { className: 'num', text: String(q.due.length) }), ' · 新词 ', h('span', { className: 'num', text: String(q.fresh.length) }), later);
      action = h('button', { type: 'button', className: 'btn start', style: '--i:2', on: { click: start } }, '开始', icon('arrow'));
    } else {
      lede = h('p', { className: 'lede', style: '--i:0', text: lib ? (today ? '今天的复习做完了。' : '今天没有要复习的词。') : '词库还是空的。' });
      meta = h('p', { className: 'small meta', style: '--i:1', text: lib ? `明天到期 ${app.words.tomorrowCount(per)} 个。` : '查词时点“划进词库”，词才会进入复习。' });
    }
    home.replaceChildren(h('div', { className: 'today reveal' }, lede, meta, action),
      h('p', { className: 'small rv-foot', text: `每天最多学 ${per} 个新词，今天已学 ${q.newDone} 个，可以在“我”里改。“忘了”的词会在这一轮稍后再出现。` }));
  }

  // done: the same sentence in the same place, so finishing reads like turning the page
  function renderDone() {
    const f = finished;
    const per = app.settings().newPerDay;
    const left = app.words.dueCount(per);
    const n = x => h('span', { className: 'n', text: String(x) });
    const lede = f.complete
      ? h('p', { className: 'lede', style: '--i:0' }, '今天的 ', n(f.words), ' 个词，', h('br'), '都看过一遍了。')
      : h('p', { className: 'lede', style: '--i:0' }, '这一轮看了 ', n(f.words), ' 个词。');
    const lines = [];
    // a finished round already brought every forgotten card back; an early stop leaves them in today's queue
    if (f.forgot) lines.push(f.complete ? `有 ${f.forgot} 个忘了，已经在这一轮里又看了一遍。` : `有 ${f.forgot} 个忘了，接着复习时还会再看到。`);
    if (left) lines.push(`还有 ${left} 个今天要复习。`);
    lines.push(`明天到期 ${app.words.tomorrowCount(per)} 个。`);
    home.replaceChildren(h('div', { className: 'today reveal' }, lede,
      h('p', { className: 'small meta', style: '--i:1' }, lines.map((t, i) => [i ? h('br') : null, t])),
      left ? h('button', { type: 'button', className: 'btn start', style: '--i:2', on: { click: start } }, '接着复习', icon('arrow'))
        : h('button', { type: 'button', className: 'text-btn accent again', style: '--i:2', on: { click: () => { finished = null; renderHome(); } } }, '回到复习', icon('chev'))));
  }

  // ---------------------------------------------------------------- session
  function start() {
    const q = app.words.reviewQueue(app.settings().newPerDay);
    const queue = [...q.due, ...q.fresh].map(e => e.slug);
    finished = null;
    if (!queue.length) { renderHome(); return; }
    session = createSession({
      queue,
      mode: modeId,
      review: (slug, g, m) => app.words.review(slug, g, m),
      isToday: due => new Date(due) <= endOfDay(new Date()),
      // a word unfavorited during the round (sheet or 词库) is skipped
      isActive: slug => { const e = app.words.get(slug); return !!(e && e.favorited); },
    });
    homeView.hidden = true;
    stage.hidden = false;
    document.body.classList.add('in-session');
    app.chrome();
    draw();
  }

  function quit() {
    if (!session) return;
    session.end();
    finish(false);
  }

  function draw() {
    const s = session;
    if (!s) return;
    const slug = s.current();
    if (!slug) { finish(true); return; }
    const e = app.words.get(slug);
    const mode = MODES[modeId];
    const total = s.total;
    const isNew = !!(e.fsrs && e.fsrs.state === State.New);
    modeView = mode.render(e, {
      app,
      say: (text, btn) => app.say(text, btn),
      rate: (g, o) => rate(g, o),
      openFull: () => app.openSheet(e.slug, { session: `${s.done + 1} / ${total}` }),
      busy: () => s.busy,
      position: { n: s.done + 1, total, isNew },
      isTall: () => document.documentElement.scrollHeight > window.innerHeight + 1,
    });
    const progress = h('span', { className: 'progress', 'aria-hidden': 'true', style: `--p:${(s.done + 1) / Math.max(1, total)}` });
    stage.replaceChildren(
      h('header', { className: 'runhead session' },
        h('button', { type: 'button', className: 'text-btn', text: '结束', on: { click: quit } }),
        h('span', { className: 'count3', 'aria-label': `第 ${s.done + 1} 个，共 ${total} 个` },
          isNew ? h('span', { className: 'tag', text: '新词' }) : null,
          h('span', { className: 'num', text: String(s.done + 1) }), ' / ', h('span', { className: 'num', text: String(total) })),
        progress),
      modeView.el, ...[].concat(modeView.footer || []));
    window.scrollTo(0, 0);
  }

  async function rate(g, { fromSwipe = false } = {}) {
    const s = session;
    if (!s || s.busy) return;
    let r;
    try { r = await s.rate(g, { modeId }); } catch (err) {
      toast(err.message || String(err));
      if (session === s) draw();   // bring back a card that a swipe already flew off screen
      return;
    }
    if (!r || session !== s) return;
    if (r.requeued && g === 1 && !fromSwipe) toast('稍后再出现', 1200);
    app.updateBadge();
    if (r.finished) finish(true); else draw();
  }

  function finish(complete) {
    const s = session;
    finished = { complete, words: s ? s.words : 0, forgot: s ? s.forgot : 0 };
    session = null;
    modeView = null;
    stage.hidden = true;
    stage.replaceChildren();
    homeView.hidden = false;
    document.body.classList.remove('in-session');
    app.chrome();
    app.updateBadge();
    renderHome();
    window.scrollTo(0, 0);
  }

  document.addEventListener('keydown', ev => {
    if (!session || !modeView || app.currentRoute() !== 'review' || document.body.classList.contains('sheet-open')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
    if (modeView.onKey) modeView.onKey(ev);
  });

  renderHome();
  return {
    // coming back to the tab starts from today's sentence again; the done page lasts while you stay
    show() { if (!session) { finished = null; renderHome(); } },
    onChange() { if (!session && app.currentRoute() === 'review') renderHome(); },
    inSession: () => !!session,
  };
}
