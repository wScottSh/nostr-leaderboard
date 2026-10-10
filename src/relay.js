/*
 * relay.js -- live NIP-01 subscription. Each relay keeps its REQ open after
 * EOSE so new EVENTs stream in, and a dropped relay reconnects with
 * exponential backoff. Duplicates across relays (and replays after a
 * reconnect) are the caller's to dedupe.
 */

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export function buildFilter({ authors } = {}) {
  const filter = { kinds: [8064], '#t': ['ag-lb'], limit: 5000 };
  if (authors && authors.length) filter.authors = authors;
  return filter;
}

/**
 * subscribe: opens every relay and keeps it open until close().
 *
 * onStatus(url, { state, synced, error }) fires on every change. state is
 * 'connecting' | 'live' | 'error'. synced turns true once the relay has
 * finished its first answer (EOSE, a failure, or eoseTimeoutMs without EOSE)
 * and stays true, so "every relay synced" marks the end of the initial load.
 */
export function subscribe(
  urls,
  filter,
  {
    onEvent,
    onStatus = () => {},
    WebSocketImpl = globalThis.WebSocket,
    minDelayMs = 1000,
    maxDelayMs = 30000,
    eoseTimeoutMs = 8000,
  },
) {
  let closed = false;
  const relays = urls.map((url) => {
    const relay = { url, ws: null, subId: null, timer: null, eoseTimer: null, attempt: 0, status: { state: 'connecting', synced: false } };
    const setStatus = (patch) => {
      relay.status = { ...relay.status, ...patch };
      onStatus(url, relay.status);
    };
    const markSynced = () => {
      clearTimeout(relay.eoseTimer);
      if (!relay.status.synced) setStatus({ synced: true });
    };

    const connect = () => {
      if (closed) return;
      const subId = (relay.subId = 'lb' + Math.random().toString(36).slice(2, 10));
      let ws = null;
      let dropped = false;
      const drop = (error) => {
        if (dropped || closed) return;
        dropped = true;
        try {
          ws?.close();
        } catch { /* already closed */ }
        const delay = Math.min(maxDelayMs, minDelayMs * 2 ** relay.attempt++);
        setStatus({ state: 'error', synced: true, error });
        clearTimeout(relay.eoseTimer);
        relay.timer = setTimeout(connect, delay);
      };

      setStatus({ state: 'connecting', error: undefined });
      try {
        ws = relay.ws = new WebSocketImpl(url);
      } catch (e) {
        drop(String(e.message || e));
        return;
      }
      if (!relay.status.synced) relay.eoseTimer = setTimeout(markSynced, eoseTimeoutMs);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
      ws.onmessage = (msg) => {
        if (closed) return;
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (!Array.isArray(data) || data[1] !== subId) return;
        if (data[0] === 'EVENT') onEvent(data[2], url);
        else if (data[0] === 'EOSE') {
          relay.attempt = 0;
          markSynced();
          setStatus({ state: 'live' });
        } else if (data[0] === 'CLOSED') drop(data[2] || 'closed by relay');
      };
      ws.onerror = () => drop('connection error');
      ws.onclose = () => drop('connection closed');
    };

    connect();
    return relay;
  });

  return {
    close() {
      closed = true;
      for (const relay of relays) {
        clearTimeout(relay.timer);
        clearTimeout(relay.eoseTimer);
        const ws = relay.ws;
        if (!ws) continue;
        try {
          if (ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', relay.subId]));
          ws.close();
        } catch { /* already closed */ }
      }
    },
  };
}
