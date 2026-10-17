// A review round (SPEC 2.3), independent of how a card looks. The 复习 tab asks a "mode" (flashcard today; quiz,
// dictation, story and cloze later) to show the current word and report a rating; this runner owns the queue,
// the same-day requeue, skipping words unfavorited mid-round and the rollback when a rating fails to save.
// No DOM here, so Node tests drive it directly.

// review(slug, rating, mode) -> {fsrs: {due}} (words.review); isToday(due) -> bool; isActive(slug) -> bool
export function createSession({ queue, review, isToday, isActive = () => true, mode = 'card' }) {
  const q = [...queue];
  const s = { done: 0, tally: { 1: 0, 2: 0, 3: 0, 4: 0 }, seen: new Set(), forgot: new Set(), busy: false, ended: false };

  // the word on screen now; a word unfavorited during the round (in the sheet or 词库) is skipped
  function current() {
    while (q.length && !isActive(q[0])) q.shift();
    return q[0] || null;
  }

  // Saves one rating. A failed save throws and leaves the round as it was (the same card can be rated again).
  async function rate(rating, { modeId = mode } = {}) {
    const slug = current();
    if (!slug || s.busy || s.ended) return null;
    s.busy = true;
    let rec;
    try { rec = await review(slug, rating, modeId); } finally { s.busy = false; }
    s.tally[rating]++;
    s.done++;
    s.seen.add(slug);
    if (rating === 1) s.forgot.add(slug);
    q.shift();
    // same-day learning steps (FSRS short-term): bring the card back later in this round
    let requeued = false;
    if (rec && rec.fsrs && isToday(rec.fsrs.due)) {
      const at = rating === 1 ? Math.min(4, q.length) : q.length;
      q.splice(at, 0, slug);
      requeued = true;
    }
    return { slug, requeued, finished: !current() };
  }

  return {
    current,
    rate,
    end() { s.ended = true; },
    get busy() { return s.busy; },
    get ended() { return s.ended; },
    get done() { return s.done; },
    get left() { current(); return q.length; },
    get total() { current(); return s.done + q.length; },
    get tally() { return { ...s.tally }; },
    get words() { return s.seen.size; },
    get forgot() { return s.forgot.size; },
    queue: () => [...q],
  };
}

// About 10 seconds a card, rounded to whole minutes (at least 1): 23 cards read as "大约 4 分钟".
export const minutesFor = n => Math.max(1, Math.round((n * 10) / 60));
