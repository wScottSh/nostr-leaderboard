/*
 * relay.js -- one-shot NIP-01 query: open each relay, send REQ, collect EVENTs
 * until EOSE (or timeout), close. Results stream through onEvent so the page
 * can render as relays answer; duplicates across relays are the caller's to
 * dedupe (by id).
 */

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export function buildFilter({ authors } = {}) {
  const filter = { kinds: [8064], '#t': ['ag-lb'], limit: 5000 };
  if (authors && authors.length) filter.authors = authors;
  return filter;
}

/**
 * queryRelay: resolves { relay, ok, count, error } once the relay sends EOSE,
 * errors, closes, or timeoutMs elapses. Never rejects.
 */
export function queryRelay(url, filter, onEvent, { timeoutMs = 8000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve) => {
    const subId = 'lb' + Math.random().toString(36).slice(2, 10);
    let count = 0;
    let settled = false;
    let ws;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', subId]));
        ws.close();
      } catch { /* already closed */ }
      resolve({ relay: url, ok, count, error });
    };
    const timer = setTimeout(() => done(count > 0, 'timed out'), timeoutMs);
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      clearTimeout(timer);
      resolve({ relay: url, ok: false, count, error: String(e.message || e) });
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!Array.isArray(data) || data[1] !== subId) return;
      if (data[0] === 'EVENT') {
        count++;
        onEvent(data[2], url);
      } else if (data[0] === 'EOSE') {
        done(true);
      } else if (data[0] === 'CLOSED') {
        done(false, data[2] || 'closed by relay');
      }
    };
    ws.onerror = () => done(false, 'connection error');
    ws.onclose = () => done(count > 0, count > 0 ? undefined : 'connection closed');
  });
}

export function queryRelays(urls, filter, onEvent, opts) {
  return Promise.all(urls.map((u) => queryRelay(u, filter, onEvent, opts)));
}
