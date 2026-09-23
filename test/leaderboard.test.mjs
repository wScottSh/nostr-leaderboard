import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { computeEventId, verifyEvent } from '../src/verify.js';
import { parseRun, buildIndex, starBoards, compareRuns } from '../src/model.js';
import { formatFrames, starName } from '../src/stars.js';
import { buildFilter, queryRelay } from '../src/relay.js';

const cabinetEvent = JSON.parse(readFileSync(new URL('./fixtures/cabinet_event.json', import.meta.url))).event;

// A throwaway cabinet key, standing in for a per-event ROM build.
const sk = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
const pk = bytesToHex(schnorr.getPublicKey(sk));

function signRun(content, { name = 'SUMMER JAM 2026', secret = sk, tags } = {}) {
  const ev = {
    pubkey: bytesToHex(schnorr.getPublicKey(secret)),
    created_at: 1789000000,
    kind: 8064,
    tags: tags ?? [['t', 'ag-lb'], ['t', 'sm64'], ['n', name]],
    content: JSON.stringify({ course: 1, act: 1, coins: 0, frames: 900, nonce: 1, keyId: 0, ...content }),
  };
  ev.id = computeEventId(ev);
  ev.sig = bytesToHex(schnorr.sign(hexToBytes(ev.id), secret));
  return ev;
}

test('verifies a real cabinet-signed event (ROM pipeline fixture)', () => {
  assert.equal(computeEventId(cabinetEvent), cabinetEvent.id);
  assert.equal(verifyEvent(cabinetEvent), true);
  const run = parseRun(cabinetEvent);
  assert.ok(run);
  assert.equal(run.eventName, 'TEST');
  assert.equal(run.course, 15);
  assert.equal(run.coins, 100);
});

test('rejects any tampered field of the real cabinet event', () => {
  const bump = JSON.parse(cabinetEvent.content);
  bump.frames -= 1;
  for (const mutate of [
    (e) => { e.content = JSON.stringify(bump); },
    (e) => { e.tags[2][1] = 'OTHER'; },
    (e) => { e.created_at += 1; },
    (e) => { e.sig = e.sig.slice(0, -2) + (e.sig.endsWith('00') ? '01' : '00'); },
  ]) {
    const e = structuredClone(cabinetEvent);
    mutate(e);
    assert.equal(parseRun(e), null);
  }
  // Re-hashing after tampering fixes the id but not the signature.
  const e = structuredClone(cabinetEvent);
  e.content = JSON.stringify(bump);
  e.id = computeEventId(e);
  assert.equal(parseRun(e), null);
});

test('rejects validly signed events that are not sm64 captures', () => {
  assert.ok(parseRun(signRun({})));
  assert.equal(parseRun(signRun({}, { tags: [['t', 'sm64'], ['n', 'X']] })), null, 'missing ag-lb');
  assert.equal(parseRun(signRun({}, { tags: [['t', 'ag-lb'], ['t', 'pacman'], ['n', 'X']] })), null, 'other game');
  assert.equal(parseRun(signRun({}, { tags: [['t', 'ag-lb'], ['t', 'sm64']] })), null, 'no event name');
  assert.equal(parseRun(signRun({ coins: -1 })), null);
  assert.equal(parseRun(signRun({ frames: 1.5 })), null);
  assert.equal(parseRun(signRun({ nonce: 70000 })), null);
  assert.equal(parseRun({ garbage: true }), null);
});

test('ranks fastest first, untimed last, coins break ties', () => {
  const runs = [
    { id: 'a', frames: 0, coins: 50 },
    { id: 'b', frames: 600, coins: 10 },
    { id: 'c', frames: 300, coins: 5 },
    { id: 'd', frames: 300, coins: 9 },
  ];
  assert.deepEqual(runs.sort(compareRuns).map((r) => r.id), ['d', 'c', 'b', 'a']);
});

test('groups by cabinet (pubkey + event name), dedupes by id, honors allowlist', () => {
  const r1 = parseRun(signRun({ nonce: 1 }));
  const r2 = parseRun(signRun({ nonce: 2 }));
  const other = parseRun(signRun({ nonce: 3 }, { secret: hexToBytes('07'.padStart(64, '0')) }));
  const idx = buildIndex([r1, r2, r1, other], [{ pubkey: pk, label: 'Summer Jam' }]);
  assert.equal(idx.length, 2);
  assert.equal(idx[0].pubkey, pk);
  assert.equal(idx[0].listed, true);
  assert.equal(idx[0].label, 'Summer Jam');
  assert.equal(idx[0].runs.length, 2);
  assert.equal(idx[1].listed, false);

  const nameScoped = buildIndex([r1], [{ pubkey: pk, name: 'SOME OTHER EVENT' }]);
  assert.equal(nameScoped[0].listed, false);
});

test('star boards in game order, each ranked', () => {
  const runs = [
    signRun({ course: 0, keyId: 3, frames: 400, nonce: 1 }),
    signRun({ course: 1, keyId: 0, frames: 900, nonce: 2 }),
    signRun({ course: 1, keyId: 0, frames: 700, nonce: 3 }),
    signRun({ course: 19, keyId: 1, frames: 500, nonce: 4 }),
  ].map(parseRun);
  const boards = starBoards(runs);
  assert.deepEqual(boards.map((b) => b.key), ['1-0', '19-1', '0-3']);
  assert.deepEqual(boards[0].runs.map((r) => r.frames), [700, 900]);
});

test('formats frames like the in-game timer and names stars', () => {
  assert.equal(formatFrames(0), '—');
  assert.equal(formatFrames(30), `0'01"00`);
  assert.equal(formatFrames(1234), `0'41"13`);
  assert.equal(formatFrames(1800), `1'00"00`);
  assert.equal(starName(1, 0), 'Big Bob-omb on the Summit');
  assert.equal(starName(1, 6), '100 Coins');
  assert.equal(starName(0, 4), 'MIPS Star 2');
  assert.equal(starName(19, 1), 'Under 21 Seconds');
});

test('queryRelay sends REQ, streams EVENTs, resolves on EOSE', async () => {
  const sent = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      setTimeout(() => this.onopen(), 0);
    }
    send(s) {
      const msg = JSON.parse(s);
      sent.push(msg);
      if (msg[0] === 'REQ') {
        const sub = msg[1];
        setTimeout(() => {
          this.onmessage({ data: JSON.stringify(['EVENT', sub, cabinetEvent]) });
          this.onmessage({ data: JSON.stringify(['EVENT', 'someone-else', {}]) });
          this.onmessage({ data: JSON.stringify(['EOSE', sub]) });
        }, 0);
      }
    }
    close() { this.readyState = 3; }
  }
  const got = [];
  const res = await queryRelay('wss://fake', buildFilter(), (ev) => got.push(ev), { WebSocketImpl: FakeWS });
  assert.deepEqual(res, { relay: 'wss://fake', ok: true, count: 1, error: undefined });
  assert.equal(got.length, 1);
  assert.deepEqual(sent[0][2], { kinds: [8064], '#t': ['ag-lb'], limit: 5000 });
  assert.equal(sent.at(-1)[0], 'CLOSE');
});
