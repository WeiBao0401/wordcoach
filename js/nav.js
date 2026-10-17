// Where things live (design v2): three tabs, and 我 (settings) is a page pushed from 词库, not a tab.
// Pure data and functions, no DOM, so Node tests can check the routing.

// [route, label, icon]
export const TABS = [['look', '查词', 'search'], ['lib', '词库', 'book'], ['review', '复习', 'cards']];

// route -> the section shown, the tab lit in the tab bar, and the back link of a pushed page
export const ROUTES = {
  look: { section: 'look', tab: 'look' },
  lib: { section: 'lib', tab: 'lib' },
  review: { section: 'review', tab: 'review' },
  me: { section: 'me', tab: 'lib', parent: 'lib', back: '词库' },
};

// Unknown names fall back to 查词. The old 我的 tab name ('me') now opens the settings page under 词库.
export function resolveRoute(name) {
  const r = ROUTES[name] || ROUTES.look;
  return { name: ROUTES[name] ? name : 'look', ...r };
}

// Tapping the lit tab again: on a pushed page it goes back to the tab's root, otherwise it scrolls up.
export const reselectAction = route => (ROUTES[route] && ROUTES[route].parent ? { go: ROUTES[route].parent } : { scrollTop: true });
