import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GROUPS, TOTAL_STARS, starKey, buildBoard } from '../src/board.js';
import { COURSES } from '../src/stars.js';

const stars = GROUPS.flatMap((g) => g.stars);
let nextId = 0;
const run = (course, keyId, extra = {}) => ({ id: `id${nextId++}`, course, keyId, frames: 900, coins: 0, ...extra });

test('registry is exactly 120 unique stars, each with a real name', () => {
  assert.equal(TOTAL_STARS, 120);
  assert.equal(stars.length, 120);
  assert.equal(new Set(stars.map((s) => s.key)).size, 120);
  assert.equal(GROUPS.length, 17);
  for (const s of stars) {
    assert.ok(COURSES[s.course], `course ${s.course} is known`);
    assert.doesNotMatch(s.name, /^(Castle )?Star \d+$/, `${s.key} resolves to a real star name`);
    assert.equal(starKey(s.course, s.keyId).key, s.key);
  }
  assert.equal(starKey(1, 6).name, '100 Coins');
  assert.equal(starKey(19, 1).label, 'Slide under 21s');
  assert.equal(starKey(19, 1).name, 'Under 21 Seconds');
  assert.equal(starKey(18, 0).group.id, 'levels');
  assert.equal(starKey(0, 5), undefined);
  assert.equal(starKey(25, 0), undefined);
});

test('buildBoard counts each collected registry star once, fastest claim first', () => {
  const slow = run(1, 0, { frames: 1200 });
  const fast = run(1, 0, { frames: 700 });
  const { claims, collected } = buildBoard([slow, fast, run(0, 3), run(18, 0)]);
  assert.equal(collected, 3);
  assert.deepEqual(claims.get('1-0').map((r) => r.frames), [700, 1200]);
  assert.equal(claims.has('2-0'), false);
});

test('buildBoard keeps non-registry stars but never counts them toward 120', () => {
  const odd = run(0, 7);
  const { claims, collected } = buildBoard([odd, run(25, 0), run(1, 6)]);
  assert.equal(collected, 1);
  assert.deepEqual(claims.get('0-7'), [odd]);
  assert.equal(claims.get('25-0').length, 1);
});

test('buildBoard dedupes the same event seen twice', () => {
  const r = run(5, 2);
  const { claims, collected } = buildBoard([r, { ...r }, r]);
  assert.equal(collected, 1);
  assert.equal(claims.get('5-2').length, 1);
});

test('a full board counts 120', () => {
  assert.equal(buildBoard(stars.map((s) => run(s.course, s.keyId))).collected, 120);
});
