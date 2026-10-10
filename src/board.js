/*
 * board.js -- the 120-star bingo board. Pure.
 *
 * The registry is the fixed set of (course, keyId) stars a build can collect:
 * 15 main courses x 7 (keyId 0-5 = act stars, 6 = 100 coins), the castle
 * secrets, and the secret levels. Bowser keys never emit events, so they are
 * not stars here.
 */
import { COURSES, starName } from './stars.js';
import { compareRuns } from './model.js';

export const TOTAL_STARS = 120;

const ACCENT = { 1: '#43a047', 2: '#8d8a99', 3: '#1597a8', 4: '#5fb4e8', 5: '#7e4fb8', 6: '#3f7d5c', 7: '#e8501a', 8: '#d49a2a', 9: '#2c56c4', 10: '#86a9c9', 11: '#22aaa5', 12: '#8a6436', 13: '#58a83a', 14: '#b48a1c', 15: '#d6457a' };

const keyOf = (course, keyId) => `${course}-${keyId}`;

/** label is the short text for a board tile; name is the full in-game star name. */
const star = (course, keyId, label) => {
  const name = starName(course, keyId);
  return { course, keyId, key: keyOf(course, keyId), name, label: label ?? name };
};

export const GROUPS = [
  ...Array.from({ length: 15 }, (_, i) => i + 1).map((c) => ({
    id: `c${c}`,
    no: String(c),
    name: COURSES[c].name,
    accent: ACCENT[c],
    stars: Array.from({ length: 7 }, (_, k) => star(c, k)),
  })),
  {
    id: 'castle',
    no: '★',
    name: 'Castle Secrets',
    accent: '#d62839',
    stars: [star(0, 0), star(0, 1), star(0, 2), star(0, 3), star(0, 4), star(19, 0, 'Secret Slide'), star(19, 1, 'Slide under 21s')],
  },
  {
    id: 'levels',
    no: '★',
    name: 'Secret Levels',
    accent: '#c79a00',
    stars: [
      star(21, 0, 'Wing Cap Tower'),
      star(20, 0, 'Metal Cap Cavern'),
      star(22, 0, 'Vanish Cap Moat'),
      star(24, 0, 'Secret Aquarium'),
      star(23, 0, 'Over the Rainbow'),
      star(16, 0, 'Bowser: Dark World'),
      star(17, 0, 'Bowser: Fire Sea'),
      star(18, 0, 'Bowser: Sky'),
    ],
  },
];

const REGISTRY = new Map(GROUPS.flatMap((g) => g.stars.map((s) => [s.key, { ...s, group: g }])));

/** The registry entry for a star, or undefined if it is not one of the 120. */
export function starKey(course, keyId) {
  return REGISTRY.get(keyOf(course, keyId));
}

/**
 * buildBoard: one build's runs -> { claims, collected }. claims maps
 * `${course}-${keyId}` to that star's runs, deduped by id and fastest first;
 * it includes stars outside the registry, which never count toward collected.
 */
export function buildBoard(runs) {
  const seen = new Set();
  const claims = new Map();
  for (const r of runs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const key = keyOf(r.course, r.keyId);
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(r);
  }
  for (const list of claims.values()) list.sort(compareRuns);
  const collected = [...claims.keys()].filter((k) => REGISTRY.has(k)).length;
  return { claims, collected };
}
