// 复习 tab (SPEC 2.3): FSRS flashcards. Tap to flip, four ratings, swipe left/right/up.
import { h, icon, marked, toast, prefersReducedMotion } from './ui-dom.js';
import { headwordNode } from './ui-entry.js';
import { previewIntervals, endOfDay, State } from './fsrs.js';

const NAMES = { 1: '忘了', 2: '模糊', 3: '记得', 4: '很熟' };
const SWIPE = 90;

export function createReviewTab(app) {
  const root = document.getElementById('tab-review');
  root.replaceChildren();
  const home = h('div', { className: 'rv-home' });
  const stage = h('div', { className: 'rv-stage', hidden: true });
  root.append(home, stage);

  let session = null;   // {queue: [slug], done, tally, flipped}

  // ---------------------------------------------------------------- home
  function renderHome() {
    const per = app.settings().newPerDay;
    const q = app.words.reviewQueue(per);
    const total = q.due.length + q.fresh.length;
    const tomorrow = app.words.tomorrowCount(per);
    const today = app.words.reviewedToday();
    const lib = app.words.favorites().length;
    const st = app.words.stats(per);
    home.replaceChildren(
      h('header', { className: 'tab-head' }, h('h1', { text: '复习' })),
      h('div', { className: 'rv-hero' },
        h('div', { className: 'rv-big' }, h('b', { text: String(total) }), h('span', { text: '今天要复习' })),
        h('div', { className: 'rv-split small muted', text: `到期 ${q.due.length} · 新词 ${q.fresh.length}` + (q.freshTotal > q.fresh.length ? `（还有 ${q.freshTotal - q.fresh.length} 个新词排在以后）` : '') }),
        total
          ? h('button', { type: 'button', className: 'btn primary big', text: `开始复习`, on: { click: start } })
          : h('p', { className: 'rv-none', text: lib ? (today ? '今天的复习做完了。' : '今天没有要复习的词。') : '词库还是空的：查词时点“收藏”，词才会进入复习。' })),
      h('div', { className: 'tally' },
        tile(today, '今天已复习'), tile(tomorrow, '明天到期'), tile(lib, '词库'), tile(st.mastered, '已掌握')),
      h('p', { className: 'small muted rv-foot', text: `每天最多学 ${per} 个新词，今天已学 ${q.newDone} 个（可在“我的”里改）。“忘了”的词会在这一轮稍后再出现。` }));
  }
  const tile = (n, label) => h('div', { className: 'tile' }, h('b', { text: String(n) }), h('span', { text: label }));

  // ---------------------------------------------------------------- session
  function start() {
    const q = app.words.reviewQueue(app.settings().newPerDay);
    const queue = [...q.due, ...q.fresh].map(e => e.slug);
    if (!queue.length) { renderHome(); return; }
    session = { queue, done: 0, tally: { 1: 0, 2: 0, 3: 0, 4: 0 }, flipped: false, busy: false };
    home.hidden = true;
    stage.hidden = false;
    document.body.classList.add('in-session');
    draw();
  }

  function quit() {
    session = null;
    stage.hidden = true;
    stage.replaceChildren();
    home.hidden = false;
    document.body.classList.remove('in-session');
    renderHome();
    window.scrollTo(0, 0);
  }

  function contextFor(e) {
    const c = (e.history || []).filter(x => x && x.context).pop();
    if (c) return { text: c.context, label: '原句' };
    const ex = (e.senses || []).find(s => s && s.example);
    return ex ? { text: ex.example, label: '例句' } : null;
  }

  function draw() {
    const s = session;
    if (!s) return;
    const slug = s.queue[0];
    const e = slug && app.words.get(slug);
    // a word unfavorited during the session (sheet or 词库) is skipped
    if (!e || !e.favorited) { if (slug) { s.queue.shift(); return draw(); } return finish(); }
    const total = s.done + s.queue.length;
    const ctx = contextFor(e);
    const card = h('div', { className: 'flash' + (s.flipped ? ' flipped' : ''), tabIndex: 0, role: 'button', 'aria-label': s.flipped ? '卡片背面' : '点一下翻面' },
      h('div', { className: 'swipe-tag left', text: '忘了' }),
      h('div', { className: 'swipe-tag right', text: '记得' }),
      h('div', { className: 'swipe-tag up', text: '很熟' }),
      h('div', { className: 'hw-line center' }, headwordNode(e),
        h('button', { type: 'button', className: 'speak', 'aria-label': '发音', on: { click: ev => { ev.stopPropagation(); app.speech.speak(e.headword); } } }, icon('speak'))),
      e.phonetic ? h('div', { className: 'ipa', text: e.phonetic }) : null,
      ctx ? h('div', { className: 'quote card-quote', lang: 'en' }, h('span', { className: 'label', text: ctx.label }), h('span', {}, marked(ctx.text, e.headword))) : null,
      s.flipped ? backSide(e) : h('p', { className: 'flip-hint small muted', text: '先回想意思，点一下翻面' }));
    let actions, hint = null;
    if (s.flipped) {
      const iv = previewIntervals(e.fsrs || {}, new Date());
      actions = h('div', { className: 'grades' }, [1, 2, 3, 4].map(g => h('button', { type: 'button', className: 'g' + g, on: { click: () => rate(g) } },
        h('span', { className: 'gn', text: NAMES[g] }), h('span', { className: 'gi', text: iv[g] }))));
    } else {
      hint = h('p', { className: 'small muted swipe-hint', text: '也可以直接滑：← 忘了 · 记得 → · ↑ 很熟' });
      actions = h('div', { className: 'flip-row' },
        h('button', { type: 'button', className: 'btn primary big', text: '翻面', on: { click: flip } }), hint);
    }
    stage.replaceChildren(
      h('div', { className: 'stage-top' },
        h('span', { className: 'small muted', text: `${s.done + 1} / ${total}` + (e.fsrs && e.fsrs.state === State.New ? ' · 新词' : '') }),
        h('button', { type: 'button', className: 'textbtn', text: '结束', on: { click: quit } })),
      h('div', { className: 'bar' }, h('i', { style: `width:${(s.done / Math.max(1, total)) * 100}%` })),
      card, actions);
    window.scrollTo(0, 0);
    // The stage fills the screen, so the page only scrolls when this card is taller than the screen.
    // Then dragging up must scroll (pan-y), not rate the card 很熟; 很熟 is still on the grade buttons.
    const tall = document.documentElement.scrollHeight > window.innerHeight + 1;
    if (tall) {
      card.style.touchAction = 'pan-y';
      card.querySelector('.swipe-tag.up').hidden = true;
      if (hint) hint.textContent = '也可以直接滑：← 忘了 · 记得 →';
    }
    attachSwipe(card, { noUp: tall });
    card.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && !s.flipped) { ev.preventDefault(); flip(); } });
  }

  function backSide(e) {
    return h('div', { className: 'card-back' },
      h('div', { className: 'brief', text: e.brief_cn || '' }),
      e.senses && e.senses.length ? h('ul', { className: 'plain back-senses' }, e.senses.slice(0, 3).map(x =>
        h('li', {}, x.pos ? h('b', { className: 'pos', text: x.pos }) : null, h('span', { text: x.cn || '' })))) : null,
      e.mnemonic ? h('div', { className: 'mnemo', text: e.mnemonic }) : null,
      e.note ? h('div', { className: 'note-text small', text: '笔记：' + e.note }) : null,
      h('button', { type: 'button', className: 'textbtn more-link', text: '看完整讲解', on: { click: ev => { ev.stopPropagation(); app.openSheet(e.slug); } } }));
  }

  function flip() {
    if (!session || session.flipped) return;
    session.flipped = true;
    draw();
  }

  async function rate(g, fromSwipe = false) {
    const s = session;
    if (!s || s.busy) return;
    const slug = s.queue[0];
    s.busy = true;
    let rec;
    try { rec = await app.words.review(slug, g, 'card'); } catch (err) {
      s.busy = false;
      toast(err.message || String(err));
      if (session === s) draw();   // bring back a card that a swipe already flew off screen
      return;
    }
    s.busy = false;
    if (session !== s) return;
    s.tally[g]++;
    s.done++;
    s.queue.shift();
    // same-day learning steps (FSRS short-term): bring the card back later in this round
    if (new Date(rec.fsrs.due) <= endOfDay(new Date())) {
      const at = g === 1 ? Math.min(3, s.queue.length) : s.queue.length;
      s.queue.splice(at, 0, slug);
      if (g === 1 && !fromSwipe) toast('稍后再出现', 1200);
    }
    s.flipped = false;
    app.updateBadge();
    if (!s.queue.length) finish(); else draw();
  }

  function finish() {
    const s = session;
    document.body.classList.remove('in-session');
    const per = app.settings().newPerDay;
    const line = [1, 2, 3, 4].map(g => `${NAMES[g]} ${s ? s.tally[g] : 0}`).join(' · ');
    stage.replaceChildren(h('div', { className: 'flash done' },
      h('div', { className: 'done-title', text: '这一轮过完了' }),
      h('p', { className: 'muted', text: line }),
      h('div', { className: 'tally' }, tile(app.words.reviewedToday(), '今天复习了'), tile(app.words.tomorrowCount(per), '明天到期')),
      h('button', { type: 'button', className: 'btn primary big', text: '回到复习', on: { click: quit } })));
    session = null;
    app.updateBadge();
  }

  // ---------------------------------------------------------------- swipe
  function attachSwipe(card, { noUp = false } = {}) {
    let x0 = 0, y0 = 0, dx = 0, dy = 0, id = null, moved = false;
    const tags = { left: card.querySelector('.swipe-tag.left'), right: card.querySelector('.swipe-tag.right'), up: card.querySelector('.swipe-tag.up') };
    const dir = () => (!noUp && -dy > SWIPE && -dy > Math.abs(dx) ? 'up' : dx < -SWIPE ? 'left' : dx > SWIPE ? 'right' : '');
    const paint = () => {
      card.style.transform = `translate(${dx}px, ${Math.min(dy, 40)}px) rotate(${dx / 18}deg)`;
      const d = dir();
      const p = Math.min(1, Math.max(Math.abs(dx), -dy) / SWIPE);
      for (const [k, t] of Object.entries(tags)) t.style.opacity = k === d ? '1' : (k === (dx < 0 ? 'left' : 'right') && Math.abs(dx) > -dy ? String(p * 0.5) : k === 'up' && -dy > Math.abs(dx) ? String(p * 0.5) : '0');
    };
    card.addEventListener('pointerdown', ev => {
      if (ev.target.closest('button') || session?.busy) return;
      id = ev.pointerId; x0 = ev.clientX; y0 = ev.clientY; dx = dy = 0; moved = false;
      try { card.setPointerCapture(id); } catch (e) { /* synthetic or already released pointer */ }
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
      if (prefersReducedMotion()) { rate(g, true); return; }
      card.classList.add('fly');
      card.style.transform = d === 'up' ? `translate(${dx}px, -120vh)` : `translate(${d === 'left' ? '-' : ''}130vw, ${dy}px) rotate(${dx / 10}deg)`;
      setTimeout(() => rate(g, true), 180);
      toast(NAMES[g], 900);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  // keyboard for desktop testing: space flips, 1-4 rate
  document.addEventListener('keydown', ev => {
    if (!session || app.currentTab() !== 'review' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
    if (ev.key === ' ' && !session.flipped) { ev.preventDefault(); flip(); }
    else if (session.flipped && '1234'.includes(ev.key) && ev.key.length === 1) rate(+ev.key);
  });

  renderHome();
  return {
    show() { if (!session) renderHome(); },
    onChange() { if (!session && app.currentTab() === 'review') renderHome(); },
    inSession: () => !!session,
  };
}
