/*
 * verify.js -- the leaderboard's trust root. A relay hands us arbitrary JSON;
 * an event only counts once its NIP-01 id is recomputed from its own fields
 * and its BIP-340 signature verifies against its own pubkey. Pure: no DOM, no
 * network, so it runs identically in the browser and under `node --test`.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** NIP-01 canonical serialization: [0, pubkey, created_at, kind, tags, content]. */
export function serializeForId(ev) {
  return JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
}

export function computeEventId(ev) {
  return bytesToHex(sha256(utf8ToBytes(serializeForId(ev))));
}

/**
 * verifyEvent: true iff ev is structurally a NIP-01 event, its id is the hash
 * of its own fields, and its sig is a valid Schnorr signature over that id by
 * its pubkey. Never throws -- malformed relay data is just "not valid".
 */
export function verifyEvent(ev) {
  try {
    if (!ev || typeof ev !== 'object') return false;
    if (typeof ev.id !== 'string' || !HEX64.test(ev.id)) return false;
    if (typeof ev.pubkey !== 'string' || !HEX64.test(ev.pubkey)) return false;
    if (typeof ev.sig !== 'string' || !HEX128.test(ev.sig)) return false;
    if (!Number.isInteger(ev.created_at) || !Number.isInteger(ev.kind)) return false;
    if (typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return false;
    if (!ev.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))) return false;
    if (computeEventId(ev) !== ev.id) return false;
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}
