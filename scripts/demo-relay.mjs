// Dev-only NIP-01 relay on ws://localhost:7777 serving freshly signed demo runs
// for two throwaway cabinet keys (plus one forged event the site must reject).
// Point the site at it via the "relays" settings page.
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { computeEventId } from '../src/verify.js';

function cabinet(skHex, name) {
  const sk = hexToBytes(skHex.padStart(64, '0'));
  return (course, keyId, frames, coins, act = 1) => {
    const ev = {
      pubkey: bytesToHex(schnorr.getPublicKey(sk)),
      created_at: 1789000000,
      kind: 8064,
      tags: [['t', 'ag-lb'], ['t', 'sm64'], ['n', name]],
      content: JSON.stringify({ course, act, coins, frames, nonce: Math.floor(Math.random() * 65536), keyId }),
    };
    ev.id = computeEventId(ev);
    ev.sig = bytesToHex(schnorr.sign(hexToBytes(ev.id), sk));
    return ev;
  };
}

const jam = cabinet('a1', 'SUMMER JAM 2026');
const expo = cabinet('b2', 'RETRO EXPO');
const events = [
  jam(1, 0, 1234, 18), jam(1, 0, 987, 22), jam(1, 0, 1502, 9), jam(1, 1, 2410, 31, 2),
  jam(1, 6, 5321, 100, 3), jam(2, 0, 1455, 12), jam(2, 1, 812, 5, 2), jam(4, 0, 2011, 40),
  jam(19, 0, 640, 0), jam(19, 1, 598, 0), jam(19, 1, 612, 0), jam(0, 0, 0, 0), jam(0, 3, 431, 0),
  jam(16, 0, 3322, 44), jam(15, 5, 8123, 61, 6),
  expo(1, 0, 1100, 20), expo(3, 3, 3050, 27, 4), expo(14, 5, 4200, 33, 6),
];
const forged = { ...events[1], content: events[1].content.replace(/"frames":\d+/, '"frames":1') };
events.unshift(forged); // first, so the site must not let it shadow the real run

const wss = new WebSocketServer({ port: 7777 });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg[0] === 'REQ') {
      for (const ev of events) ws.send(JSON.stringify(['EVENT', msg[1], ev]));
      ws.send(JSON.stringify(['EOSE', msg[1]]));
    }
  });
});
console.log(`demo relay: ws://localhost:7777 (${events.length} events, 1 forged)`);
console.log('SUMMER JAM pubkey:', events[0].pubkey);
