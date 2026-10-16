// FSRS-5 scheduler. Formulas, default weights and the short-term (same-day) learning steps are
// ported from ts-fsrs v4.7.1 (MIT License, Copyright (c) open-spaced-repetition,
// https://github.com/open-spaced-repetition/ts-fsrs): algorithm.ts + impl/basic_scheduler.ts.
// Differences: no fuzz; elapsed days are counted in the phone's local calendar days (ts-fsrs uses UTC dates).

export const W = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655,
  0.6621,
]);
export const State = Object.freeze({ New: 0, Learning: 1, Review: 2, Relearning: 3 });
export const Rating = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 });

export const REQUEST_RETENTION = 0.9;
export const MAXIMUM_INTERVAL = 36500;
const DECAY = -0.5;
const FACTOR = 19 / 81;
const S_MIN = 0.01;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const r8 = x => +x.toFixed(8);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const IVL_MOD = r8((Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1) / FACTOR);

export function forgettingCurve(elapsedDays, stability) {
  return r8(Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY));
}
const initStability = g => Math.max(W[g - 1], 0.1);
const constrainD = d => Math.min(Math.max(r8(d), 1), 10);
const initDifficulty = g => constrainD(W[4] - Math.exp((g - 1) * W[5]) + 1);
const linearDamping = (delta, d) => r8((delta * (10 - d)) / 9);
const meanReversion = (init, cur) => r8(W[7] * init + (1 - W[7]) * cur);
function nextDifficulty(d, g) {
  const next = d + linearDamping(-W[6] * (g - 3), d);
  return constrainD(meanReversion(initDifficulty(Rating.Easy), next));
}
function nextRecallStability(d, s, r, g) {
  const hard = g === Rating.Hard ? W[15] : 1;
  const easy = g === Rating.Easy ? W[16] : 1;
  return r8(clamp(s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy), S_MIN, 36500));
}
function nextForgetStability(d, s, r) {
  return r8(clamp(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]), S_MIN, 36500));
}
const nextShortTermStability = (s, g) => r8(clamp(s * Math.exp(W[17] * (g - 3 + W[18])), S_MIN, 36500));
const nextInterval = s => Math.min(Math.max(1, Math.round(s * IVL_MOD)), MAXIMUM_INTERVAL);

// Whole local calendar days from a to b.
export function daysBetween(a, b) {
  const n = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
  return n(b) - n(a);
}
export function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
export function localMidnight(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function newCard(now = new Date()) {
  return { due: now.toISOString(), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: State.New, last_review: null };
}

function normalize(card) {
  const c = { ...newCard(), ...(card || {}) };
  if (c.state !== State.New) {
    c.stability = Math.max(Number(c.stability) || 0, S_MIN);
    c.difficulty = clamp(Number(c.difficulty) || 5, 1, 10);
  }
  return c;
}

// Returns the next card for one rating (1-4) at time `now`.
export function schedule(card, grade, now = new Date()) {
  if (![1, 2, 3, 4].includes(grade)) throw new Error('Invalid grade ' + grade);
  return scheduleAll(card, now)[grade];
}

// All four outcomes at once (review-state intervals depend on each other, as in ts-fsrs).
export function scheduleAll(card, now = new Date()) {
  const last = normalize(card);
  const base = { ...last };
  let elapsed = 0;
  if (last.state !== State.New && last.last_review) elapsed = Math.max(0, daysBetween(new Date(last.last_review), now));
  base.last_review = now.toISOString();
  base.elapsed_days = elapsed;
  base.reps = (last.reps || 0) + 1;
  const at = ms => new Date(now.getTime() + ms).toISOString();
  const out = {};

  if (last.state === State.New) {
    for (const g of [1, 2, 3, 4]) {
      const n = { ...base, difficulty: initDifficulty(g), stability: initStability(g) };
      if (g === Rating.Easy) {
        const ivl = nextInterval(n.stability);
        Object.assign(n, { scheduled_days: ivl, due: at(ivl * DAY), state: State.Review });
      } else {
        Object.assign(n, { scheduled_days: 0, due: at({ 1: 1, 2: 5, 3: 10 }[g] * MIN), state: State.Learning });
      }
      out[g] = n;
    }
    return out;
  }

  if (last.state === State.Learning || last.state === State.Relearning) {
    for (const g of [1, 2, 3, 4]) {
      const n = { ...base, difficulty: nextDifficulty(last.difficulty, g), stability: nextShortTermStability(last.stability, g) };
      if (g === Rating.Again) Object.assign(n, { scheduled_days: 0, due: at(5 * MIN), state: last.state });
      else if (g === Rating.Hard) Object.assign(n, { scheduled_days: 0, due: at(10 * MIN), state: last.state });
      else if (g === Rating.Good) {
        const ivl = nextInterval(n.stability);
        Object.assign(n, { scheduled_days: ivl, due: at(ivl * DAY), state: State.Review });
      } else {
        const goodIvl = nextInterval(nextShortTermStability(last.stability, Rating.Good));
        const ivl = Math.max(nextInterval(n.stability), goodIvl + 1);
        Object.assign(n, { scheduled_days: ivl, due: at(ivl * DAY), state: State.Review });
      }
      out[g] = n;
    }
    return out;
  }

  // Review
  const { difficulty: d, stability: s } = last;
  const r = forgettingCurve(elapsed, s);
  const again = { ...base, difficulty: nextDifficulty(d, 1), stability: clamp(r8(s / Math.exp(W[17] * W[18])), S_MIN, nextForgetStability(d, s, r)) };
  const hard = { ...base, difficulty: nextDifficulty(d, 2), stability: nextRecallStability(d, s, r, 2) };
  const good = { ...base, difficulty: nextDifficulty(d, 3), stability: nextRecallStability(d, s, r, 3) };
  const easy = { ...base, difficulty: nextDifficulty(d, 4), stability: nextRecallStability(d, s, r, 4) };
  let hardIvl = nextInterval(hard.stability), goodIvl = nextInterval(good.stability);
  hardIvl = Math.min(hardIvl, goodIvl);
  goodIvl = Math.max(goodIvl, hardIvl + 1);
  const easyIvl = Math.max(nextInterval(easy.stability), goodIvl + 1);
  Object.assign(again, { scheduled_days: 0, due: at(5 * MIN), state: State.Relearning, lapses: (last.lapses || 0) + 1 });
  Object.assign(hard, { scheduled_days: hardIvl, due: at(hardIvl * DAY), state: State.Review });
  Object.assign(good, { scheduled_days: goodIvl, due: at(goodIvl * DAY), state: State.Review });
  Object.assign(easy, { scheduled_days: easyIvl, due: at(easyIvl * DAY), state: State.Review });
  return { 1: again, 2: hard, 3: good, 4: easy };
}

export function retrievability(card, now = new Date()) {
  if (!card || card.state === State.New || !card.last_review || !(card.stability > 0)) return 0;
  return forgettingCurve(Math.max(0, daysBetween(new Date(card.last_review), now)), card.stability);
}

// "1 分钟" / "10 分钟" / "3 天" / "2 个月" for the rating buttons.
export function formatInterval(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} 分钟`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} 小时`;
  const days = Math.round(ms / DAY);
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return `${+(days / 365).toFixed(1)} 年`;
}
export function previewIntervals(card, now = new Date()) {
  const all = scheduleAll(card, now);
  const out = {};
  for (const g of [1, 2, 3, 4]) out[g] = formatInterval(new Date(all[g].due) - now);
  return out;
}

// Mastery shown in the library: new = state 0; mastered = Review with stability >= 21 days.
export function mastery(card) {
  if (!card || card.state === State.New) return 'new';
  if (card.state === State.Review && card.stability >= 21) return 'mastered';
  return 'learning';
}

// One-time conversion of the Mac app's SM-2 progress (srs) into an FSRS card.
// ease 2.5 -> difficulty 5; every +0.25 ease is one point easier (clamped to 1..10).
export function fromSM2(srs) {
  if (!srs || !srs.due) return null;
  const due = localMidnight(srs.due);
  if (isNaN(due.getTime())) return null;   // malformed Mac date: treat as no progress
  const reps = srs.reps || 0, lapses = srs.lapses || 0;
  if (!reps && !lapses) return { ...newCard(due), due: due.toISOString() };
  const ivl = Math.max(1, Math.round(srs.interval || 0));
  const ease = typeof srs.ease === 'number' ? srs.ease : 2.5;
  const lastReview = srs.last ? new Date(srs.last) : new Date(due.getTime() - ivl * DAY);
  return {
    due: due.toISOString(), stability: ivl, difficulty: r8(clamp(5 + (2.5 - ease) * 4, 1, 10)),
    elapsed_days: 0, scheduled_days: ivl, reps, lapses, state: State.Review,
    last_review: isNaN(lastReview) ? null : lastReview.toISOString(),
  };
}
