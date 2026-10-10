import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFilter, subscribe } from '../src/relay.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeRelay() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen();
      }, 0);
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    get subId() {
      return this.sent.find((m) => m[0] === 'REQ')?.[1];
    }
    push(...msg) {
      this.onmessage({ data: JSON.stringify(msg) });
    }
  }
  return { sockets, FakeWS };
}

test('subscription streams EVENTs before and after EOSE', async () => {
  const { sockets, FakeWS } = fakeRelay();
  const got = [];
  const statuses = [];
  const sub = subscribe(['wss://fake'], buildFilter(), {
    onEvent: (ev) => got.push(ev.id),
    onStatus: (url, s) => statuses.push(s),
    WebSocketImpl: FakeWS,
  });
  await tick();
  const ws = sockets[0];
  assert.equal(ws.sent[0][0], 'REQ');
  assert.deepEqual(ws.sent[0][2], { kinds: [8064], '#t': ['ag-lb'], limit: 5000 });

  ws.push('EVENT', ws.subId, { id: 'stored' });
  ws.push('EVENT', 'someone-else', { id: 'not-ours' });
  ws.push('EOSE', ws.subId);
  assert.deepEqual(statuses.at(-1), { state: 'live', synced: true, error: undefined });

  ws.push('EVENT', ws.subId, { id: 'live-1' });
  await tick(5);
  ws.push('EVENT', ws.subId, { id: 'live-2' });
  assert.deepEqual(got, ['stored', 'live-1', 'live-2']);
  assert.equal(ws.closed, false, 'REQ stays open after EOSE');
  sub.close();
});

test('a dropped relay reconnects with backoff and resubscribes', async () => {
  const { sockets, FakeWS } = fakeRelay();
  const got = [];
  const statuses = [];
  const sub = subscribe(['wss://fake'], buildFilter(), {
    onEvent: (ev) => got.push(ev.id),
    onStatus: (url, s) => statuses.push(s.state),
    WebSocketImpl: FakeWS,
    minDelayMs: 10,
  });
  await tick();
  sockets[0].push('EOSE', sockets[0].subId);
  sockets[0].onclose();
  assert.equal(statuses.at(-1), 'error');
  assert.equal(sockets.length, 1, 'waits out the backoff before reconnecting');

  await tick(30);
  assert.equal(sockets.length, 2);
  const ws = sockets[1];
  assert.equal(ws.sent[0][0], 'REQ');
  ws.push('EOSE', ws.subId);
  ws.push('EVENT', ws.subId, { id: 'after-reconnect' });
  assert.deepEqual(got, ['after-reconnect']);
  assert.equal(statuses.at(-1), 'live');
  sub.close();
});

test('a relay that fails before EOSE still counts as synced', async () => {
  const { sockets, FakeWS } = fakeRelay();
  let last;
  const sub = subscribe(['wss://fake'], buildFilter(), {
    onEvent: () => {},
    onStatus: (url, s) => (last = s),
    WebSocketImpl: FakeWS,
    minDelayMs: 1000,
  });
  await tick();
  assert.equal(last.synced, false);
  sockets[0].onerror();
  assert.equal(last.synced, true);
  assert.equal(last.state, 'error');
  sub.close();
});

test('close() unsubscribes, goes silent, and stops reconnecting', async () => {
  const { sockets, FakeWS } = fakeRelay();
  const got = [];
  let statusCalls = 0;
  const sub = subscribe(['wss://a', 'wss://b'], buildFilter(), {
    onEvent: (ev) => got.push(ev.id),
    onStatus: () => statusCalls++,
    WebSocketImpl: FakeWS,
    minDelayMs: 5,
  });
  await tick();
  const [a, b] = sockets;
  const subA = a.subId;
  sub.close();
  const callsAtClose = statusCalls;
  assert.deepEqual(a.sent.at(-1), ['CLOSE', subA]);
  assert.ok(a.closed && b.closed);

  a.push('EVENT', subA, { id: 'late' });
  b.onclose();
  await tick(30);
  assert.deepEqual(got, []);
  assert.equal(statusCalls, callsAtClose, 'no status updates after close');
  assert.equal(sockets.length, 2, 'no reconnect after close');
});
