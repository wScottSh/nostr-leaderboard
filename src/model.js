/*
 * model.js -- turns verified kind-8064 events into leaderboards. Pure.
 *
 * Domain facts this module leans on (sm64-nostr CONTEXT.md / issue #11 /
 * format-v3 spec):
 *  - pubkey is the CABINET (one ROM build for one event), never a player.
 *  - created_at is the frozen build epoch, never the time of the run.
 *  - a run's identity is its event id; the nonce is opaque salt.
 *  - the signature proves origin-provenance only ("this came from the ROM
 *    built with this key"), so which cabinets count is an operator decision:
 *    the published allowlist (cabinets.json).
 */
import { verifyEvent } from './verify.js';
import { starOrder } from './stars.js';

export const KIND = 8064;
export const CLASS_TAG = 'ag-lb'; // event_id.h PIPELINE_EVENT_TAG0_VALUE
export const GAME_TAG = 'sm64';

const CONTENT_KEYS = ['course', 'act', 'coins', 'frames', 'nonce', 'keyId'];
const CONTENT_MAX = { course: 0xff, act: 0xff, coins: 0xff, frames: 0xffffffff, nonce: 0xffff, keyId: 0xff };

/**
 * parseRun: a relay event -> a run record, or null if it is not a valid
 * sm64-nostr star capture. Verifies id + signature first; everything after is
 * shape checking against format v3.
 */
export function parseRun(ev) {
  if (!verifyEvent(ev)) return null;
  if (ev.kind !== KIND) return null;
  const t = ev.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]);
  if (!t.includes(CLASS_TAG) || !t.includes(GAME_TAG)) return null;
  const names = ev.tags.filter((tag) => tag[0] === 'n');
  if (names.length !== 1) return null;

  let content;
  try {
    content = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (!content || typeof content !== 'object') return null;
  for (const k of CONTENT_KEYS) {
    const v = content[k];
    if (!Number.isInteger(v) || v < 0 || v > CONTENT_MAX[k]) return null;
  }

  return {
    id: ev.id,
    pubkey: ev.pubkey,
    eventName: names[0][1],
    builtAt: ev.created_at,
    course: content.course,
    act: content.act,
    coins: content.coins,
    frames: content.frames,
    nonce: content.nonce,
    keyId: content.keyId,
    raw: ev,
  };
}

/** A cabinet is one signing key under one event name. */
export function cabinetKey(pubkey, eventName) {
  return `${pubkey}:${eventName}`;
}

/** Fastest first; untimed (frames 0) last; then more coins; then id for a stable order. */
export function compareRuns(a, b) {
  const fa = a.frames || Infinity;
  const fb = b.frames || Infinity;
  if (fa !== fb) return fa - fb;
  if (a.coins !== b.coins) return b.coins - a.coins;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * buildIndex: dedupes runs by id and groups them into cabinets. Each cabinet
 * is marked `listed` when the operator allowlist names its pubkey (and, if the
 * entry gives one, its event name).
 */
export function buildIndex(runs, allowlist = []) {
  const byId = new Map();
  for (const r of runs) if (r && !byId.has(r.id)) byId.set(r.id, r);

  const cabinets = new Map();
  for (const r of byId.values()) {
    const key = cabinetKey(r.pubkey, r.eventName);
    let cab = cabinets.get(key);
    if (!cab) {
      const entry = allowlist.find((a) => a.pubkey === r.pubkey && (!a.name || a.name === r.eventName));
      cab = {
        key,
        pubkey: r.pubkey,
        eventName: r.eventName,
        label: entry?.label ?? null,
        listed: Boolean(entry),
        builtAt: r.builtAt,
        runs: [],
      };
      cabinets.set(key, cab);
    }
    cab.runs.push(r);
  }
  return [...cabinets.values()].sort(
    (a, b) => Number(b.listed) - Number(a.listed) || b.runs.length - a.runs.length || a.key.localeCompare(b.key),
  );
}

/**
 * starBoards: runs -> one board per (course, keyId), each ranked by
 * compareRuns, boards in game order.
 */
export function starBoards(runs) {
  const boards = new Map();
  for (const r of runs) {
    const key = `${r.course}-${r.keyId}`;
    if (!boards.has(key)) boards.set(key, { key, course: r.course, keyId: r.keyId, runs: [] });
    boards.get(key).runs.push(r);
  }
  for (const b of boards.values()) b.runs.sort(compareRuns);
  return [...boards.values()].sort((a, b) => starOrder(a.course, a.keyId) - starOrder(b.course, b.keyId));
}
