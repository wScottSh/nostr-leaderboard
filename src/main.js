/*
 * main.js -- the page. Loads the operator allowlist, keeps a live relay
 * subscription open, verifies every event (model.parseRun), and renders
 * builds -> bingo board -> claims. Hash routes keep the site static files:
 *   #/                                  all builds
 *   #/c/<pubkey>/<event name>           that build's bingo board
 *   #/c/<pubkey>/<event name>/<c>-<k>   one star's claims on that build
 *   #/about, #/relays
 */
import { parseRun, buildIndex, cabinetKey, allowlistEntry } from './model.js';
import { buildFilter, subscribe, DEFAULT_RELAYS } from './relay.js';
import { COURSES, courseName, starName, formatFrames } from './stars.js';
import { GROUPS, TOTAL_STARS, starKey, buildBoard } from './board.js';

const RELAYS_KEY = 'sm64lb.relays';
const app = document.getElementById('app');
const statusEl = document.getElementById('status');

const state = {
  allowlist: [],
  runs: new Map(), // id -> run
  rejectedSeen: new Set(), // fingerprints of invalid events, so relay echoes count once
  rejected: 0,
  relayStatus: new Map(), // url -> { state, synced, error }
  subscription: null,
  liveIds: new Set(), // ids of claims that arrived after the initial load
  latest: new Map(), // build key -> newest such claim
  showUnlisted: false,
};

let boardView = null; // { key, el, collected: Set } while a board is mounted

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shortHex = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`;

function getRelays() {
  try {
    const saved = JSON.parse(localStorage.getItem(RELAYS_KEY));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* fall through */ }
  return DEFAULT_RELAYS;
}

async function loadAllowlist() {
  try {
    const res = await fetch('cabinets.json', { cache: 'no-cache' });
    const json = await res.json();
    return (json.cabinets || []).filter((c) => /^[0-9a-f]{64}$/.test(c.pubkey));
  } catch {
    return [];
  }
}

const loading = () => [...state.relayStatus.values()].some((s) => !s.synced);

let renderPending = 0;
function scheduleRender() {
  if (!renderPending) renderPending = setTimeout(() => {
    renderPending = 0;
    render();
  }, 150);
}

function ingest(ev) {
  // Dedupe only on VERIFIED ids: an event's id is just a claim until
  // parseRun checks it, so a forgery reusing a real run's id must not be
  // able to shadow the genuine event by arriving first.
  if (!ev || typeof ev.id !== 'string' || state.runs.has(ev.id)) return;
  const run = parseRun(ev);
  if (run) {
    state.runs.set(run.id, run);
    if (!loading()) {
      state.liveIds.add(run.id);
      state.latest.set(cabinetKey(run.pubkey, run.eventName), run);
    }
  } else {
    const fingerprint = `${ev.id}:${ev.sig}:${ev.content}`;
    if (!state.rejectedSeen.has(fingerprint)) {
      state.rejectedSeen.add(fingerprint);
      state.rejected++;
    }
  }
  scheduleRender();
}

function startSubscription() {
  state.subscription?.close();
  const relays = getRelays();
  state.relayStatus = new Map(relays.map((url) => [url, { state: 'connecting', synced: false }]));
  state.subscription = subscribe(relays, buildFilter(), {
    onEvent: ingest,
    onStatus: (url, status) => {
      state.relayStatus.set(url, status);
      scheduleRender();
    },
  });
}

function builds() {
  return buildIndex([...state.runs.values()], state.allowlist);
}

/** The build a route names, even before (or without) any claims on the relays. */
function findBuild(pubkey, eventName) {
  const key = cabinetKey(pubkey, eventName);
  const found = builds().find((c) => c.key === key);
  if (found) return found;
  const entry = allowlistEntry(state.allowlist, pubkey, eventName);
  return { key, pubkey, eventName, label: entry?.label ?? null, listed: Boolean(entry), builtAt: null, runs: [] };
}

const buildHref = (c) => `#/c/${c.pubkey}/${encodeURIComponent(c.eventName)}`;
const buildTitle = (c) => c.label || c.eventName;
const listedBadge = (c) =>
  c.listed
    ? '<span class="badge">listed</span>'
    : `<span class="badge warn" title="Valid signature, but this site's operator has not vouched for this build">unlisted</span>`;

function relaySummary() {
  const all = [...state.relayStatus.values()];
  const level = all.some((s) => s.state === 'live') ? 'live' : all.some((s) => s.state === 'connecting') ? 'connecting' : 'error';
  const title = [...state.relayStatus].map(([url, s]) => `${url.replace(/^wss?:\/\//, '')}: ${s.state}${s.error ? ` (${s.error})` : ''}`).join('\n');
  return { level, title };
}

function renderStatus() {
  const chips = getRelays()
    .map((url) => {
      const r = state.relayStatus.get(url);
      const cls = !r || r.state === 'connecting' ? 'pending' : r.state === 'live' ? 'ok' : 'bad';
      const title = !r || r.state === 'connecting' ? 'connecting…' : r.state === 'live' ? 'live' : r.error;
      return `<span class="chip ${cls}" title="${esc(title)}">${esc(url.replace(/^wss?:\/\//, ''))}</span>`;
    })
    .join('');
  statusEl.innerHTML = `
    <div class="chips">${chips}</div>
    <div class="counts">
      ${loading() ? '<span class="spin">★</span> loading · ' : ''}
      <b>${state.runs.size}</b> verified claims${state.rejected ? ` · <span title="bad signature, wrong shape, or not sm64">${state.rejected} rejected</span>` : ''}
      · <a href="#/relays">relays</a>
    </div>`;
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'c' && parts[1]) {
    const r = { pubkey: parts[1], name: parts[2] ?? '' };
    return parts[3] === undefined ? { page: 'board', ...r } : { page: 'claim', ...r, star: parts[3] };
  }
  if (parts[0] === 'about') return { page: 'about' };
  if (parts[0] === 'relays') return { page: 'relays' };
  return { page: 'home' };
}

function renderHome() {
  const all = builds();
  const listed = all.filter((c) => c.listed);
  const unlisted = all.filter((c) => !c.listed);
  const noAllowlist = state.allowlist.length === 0;
  const shown = noAllowlist || state.showUnlisted ? all : listed;

  let html = '';
  if (noAllowlist && all.length) {
    html += `<p class="notice">No builds are on this site's allowlist yet, so every validly signed
      sm64 build found on the relays is shown. A signature only proves which ROM build produced a claim —
      anyone can build a ROM. <a href="#/about">Why this matters</a>.</p>`;
  }
  if (!shown.length) {
    html += loading()
      ? '<p class="empty">Looking for star claims…</p>'
      : `<p class="empty">No ${noAllowlist ? '' : 'listed '}build claims found on these relays yet.</p>`;
  } else {
    html += '<div class="builds">';
    for (const c of shown) {
      const { collected } = buildBoard(c.runs);
      html += `
        <a class="build ${c.listed ? 'listed' : 'unlisted'}${collected === TOTAL_STARS ? ' blackout' : ''}" href="${buildHref(c)}">
          <div class="build-name">${esc(buildTitle(c))}</div>
          ${c.label ? `<div class="build-event">${esc(c.eventName)}</div>` : ''}
          <div class="build-count"><b>${collected}</b><small> / ${TOTAL_STARS}</small></div>
          <div class="meter"><i style="width:${(collected / TOTAL_STARS) * 100}%"></i></div>
          <div class="build-meta">${c.runs.length} claim${c.runs.length === 1 ? '' : 's'} · <span class="mono">${shortHex(c.pubkey)}</span> ${listedBadge(c)}</div>
        </a>`;
    }
    html += '</div>';
  }
  if (!noAllowlist && unlisted.length) {
    html += `<label class="toggle"><input type="checkbox" data-action="unlisted" ${state.showUnlisted ? 'checked' : ''}>
      Show ${unlisted.length} unlisted build${unlisted.length === 1 ? '' : 's'} (valid signature, unknown operator)</label>`;
  }
  return html;
}

const STAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="body" stroke-linejoin="round" d="M12 1.8l3 6.4 7 .9-5.1 4.9 1.3 7L12 17.5 5.8 21l1.3-7L2 9.1l7-.9z"/><g class="ey" fill="#2a1a00"><ellipse cx="10.1" cy="11.2" rx=".8" ry="1.9"/><ellipse cx="13.9" cy="11.2" rx=".8" ry="1.9"/></g></svg>`;
const LOGO_COLORS = ['#e63946', '#3a86ff', '#ffd23f', '#2ec27e'];

function boardHtml(c) {
  const tile = (s) =>
    `<a class="tile" data-key="${s.key}" title="${esc(`${courseName(s.course)}: ${s.name}`)}">${STAR_SVG}<span class="nm">${esc(s.label)}</span></a>`;
  return `
    <section class="card hero">
      <nav class="hero-bar"><a href="#/">‹ all builds</a><span class="relay-dot" title=""><i></i><span></span></span></nav>
      <div class="logo">${[...'MARIO 64'].map((ch, i) => `<span style="color:${LOGO_COLORS[i % 4]}">${ch}</span>`).join('')}<span class="l2">BINGO</span></div>
      <div class="build-title">${esc(buildTitle(c))}${c.listed || state.allowlist.length === 0 ? '' : ` ${listedBadge(c)}`}</div>
      <div class="count"><span class="n">0</span><small> / ${TOTAL_STARS}</small></div>
      <div class="meter"><i></i></div>
      <div class="ticker"></div>
    </section>
    ${GROUPS.map(
      (g) => `
    <section class="card" data-group="${g.id}" style="--ac:${g.accent}">
      <h2><span class="no">${g.no}</span><span class="nm">${esc(g.name)}</span><span class="pr"></span></h2>
      <div class="tiles${g.stars.length === 7 ? ' seven' : ''}">${g.stars.map(tile).join('')}</div>
    </section>`,
    ).join('')}`;
}

const SHAPES = [[4, 2], [2, 4], [8, 1], [3, 3]];
/** Picks card columns and tile shape that give the biggest tiles for the window. */
function fit() {
  if (!boardView) return;
  const W = innerWidth, H = innerHeight, N = GROUPS.length + 1;
  const g = Math.round(Math.max(4, Math.min(W, H) * 0.008)), tg = Math.max(2, Math.round(g * 0.5));
  let best;
  for (let k = 2; k <= 10; k++) {
    const r = Math.ceil(N / k);
    const cw = (W - g * (k + 1)) / k, ch = (H - g * (r + 1)) / r;
    // Strip-shaped cards (two columns of nine on a 16:9 screen) can win on
    // raw tile size but squash the hero into a sliver too short for its logo,
    // so they only win when nothing else fits.
    const strip = cw / ch > 3;
    const p = Math.round(g * 0.9), hdr = Math.round(Math.min(30, Math.max(15, ch * 0.14)));
    for (const [a, b] of SHAPES) {
      const tw = (cw - 2 * p - tg * (a - 1)) / a, th = (ch - hdr - 2 * p - tg * (b - 1)) / b;
      // 1.35 favors tiles a bit wider than tall (the label sits under the star);
      // the penalty keeps 3x3's empty cell from winning on near-ties.
      const score = Math.min(tw / 1.35, th) - (a * b - 8) * 4;
      if (!best || (best.strip && !strip) || (best.strip === strip && score > best.score)) {
        best = { score, strip, k, r, a, b, g, tg, p, hdr, spare: k * r - N };
      }
    }
  }
  const el = boardView.el;
  const vars = { cols: best.k, rows: best.r, ta: best.a, tb: best.b, g: `${best.g}px`, tg: `${best.tg}px`, p: `${best.p}px`, hdr: `${best.hdr}px` };
  for (const [n, v] of Object.entries(vars)) el.style.setProperty(`--${n}`, v);
  el.querySelector('.hero').style.gridColumn = `span ${Math.min(best.k, 1 + best.spare)}`;
}

function tickerText(c, collected) {
  if (collected === TOTAL_STARS) return '★ BLACKOUT · all 120 stars ★';
  const latest = state.latest.get(c.key);
  if (latest) {
    const name = starKey(latest.course, latest.keyId)?.label ?? starName(latest.course, latest.keyId);
    const time = latest.frames ? ` · ${formatFrames(latest.frames)}` : '';
    return `★ ${name} · ${COURSES[latest.course]?.abbr ?? `course ${latest.course}`}${time}`;
  }
  if (loading()) return 'connecting to relays…';
  return collected ? 'blackout the board together' : 'no stars yet · blackout the board together';
}

function syncBoard(c) {
  const { el } = boardView;
  const { claims, collected } = buildBoard(c.runs);
  const now = new Set();
  for (const tile of el.querySelectorAll('.tile')) {
    const key = tile.dataset.key;
    const got = claims.has(key);
    tile.classList.toggle('got', got);
    if (got) {
      now.add(key);
      tile.setAttribute('href', `${buildHref(c)}/${key}`);
      // Renders are coalesced, so whether a star is news is decided by when
      // its claims arrived (ingest), not by when this sync runs.
      if (!boardView.collected.has(key) && claims.get(key).some((run) => state.liveIds.has(run.id))) {
        tile.classList.remove('fresh');
        void tile.offsetWidth;
        tile.classList.add('fresh');
      }
    } else tile.removeAttribute('href');
  }
  boardView.collected = now;
  for (const g of GROUPS) {
    const card = el.querySelector(`[data-group="${g.id}"]`);
    const got = g.stars.filter((s) => now.has(s.key)).length;
    card.querySelector('.pr').textContent = `${got}/${g.stars.length}`;
    card.classList.toggle('done', got === g.stars.length);
  }
  const hero = el.querySelector('.hero');
  hero.classList.toggle('blackout', collected === TOTAL_STARS);
  hero.querySelector('.n').textContent = collected;
  hero.querySelector('.meter i').style.width = `${(collected / TOTAL_STARS) * 100}%`;
  hero.querySelector('.ticker').textContent = tickerText(c, collected);
  const relay = relaySummary();
  const dot = hero.querySelector('.relay-dot');
  dot.className = `relay-dot ${relay.level}`;
  dot.title = relay.title;
  dot.querySelector('span').textContent = relay.level;
}

function renderBoard(r) {
  const c = findBuild(r.pubkey, r.name);
  if (boardView?.key !== c.key) {
    app.innerHTML = '<div class="bingo"></div>';
    const present = [...buildBoard(c.runs).claims.keys()];
    boardView = { key: c.key, el: app.firstElementChild, collected: new Set(present) };
    boardView.el.innerHTML = boardHtml(c);
    document.title = `${buildTitle(c)} · Mario 64 Bingo`;
    fit();
  }
  syncBoard(c);
}

function buildCrumbs(c, tail) {
  return `<nav class="crumbs"><a href="#/">All builds</a> › <a href="${buildHref(c)}">${esc(buildTitle(c))}</a>${tail ? ` › ${tail}` : ''}</nav>`;
}

function renderClaim(r) {
  const c = findBuild(r.pubkey, r.name);
  const m = /^(\d+)-(\d+)$/.exec(r.star);
  if (!m) return `${buildCrumbs(c)}<p class="empty">Unknown star “${esc(r.star)}”.</p>`;
  const course = Number(m[1]);
  const keyId = Number(m[2]);
  const key = `${course}-${keyId}`;
  const reg = starKey(course, keyId);
  const claims = buildBoard(c.runs).claims.get(key) ?? [];

  let html = buildCrumbs(c, esc(starName(course, keyId)));
  html += `<div class="claim-head" style="--ac:${reg?.group.accent ?? '#ffd23f'}">
    <div class="claim-star ${claims.length ? 'got' : ''}">${STAR_SVG}</div>
    <div><h2>${esc(starName(course, keyId))}</h2>
    <p class="sub">${esc(courseName(course))} · star ${key}${reg ? '' : ' · not one of the 120 bingo stars'}
      · ${c.listed ? '' : 'unlisted '}build <b>${esc(c.eventName)}</b> <span class="mono" title="${esc(c.pubkey)}">${shortHex(c.pubkey)}</span></p></div>
  </div>`;

  if (!claims.length) {
    html += loading()
      ? '<p class="empty"><span class="spin">★</span> Loading claims…</p>'
      : `<p class="empty">Not claimed yet on this build. <a href="${buildHref(c)}">Back to the board</a></p>`;
    return html;
  }
  html += `<table class="claims"><thead><tr><th class="num">#</th><th class="num">Time</th><th class="num">Frames</th>
    <th class="num">Coins</th><th class="num">Act</th><th>Claim (event id)</th></tr></thead><tbody>`;
  claims.forEach((run, i) => {
    html += `<tr class="${i < 3 && run.frames ? `podium p${i + 1}` : ''}">
      <td class="num">${run.frames ? i + 1 : '–'}</td>
      <td class="num time">${formatFrames(run.frames)}</td>
      <td class="num mono">${run.frames || '—'}</td>
      <td class="num">${run.coins}</td>
      <td class="num">${run.act}</td>
      <td><details><summary class="mono">${shortHex(run.id)}</summary>
        <pre>${esc(JSON.stringify(run.raw, null, 2))}</pre></details></td></tr>`;
  });
  html += '</tbody></table>';
  html += `<p class="verified">✓ Verified in your browser: each event id was recomputed from its fields and its
    Schnorr signature checked against this build's key.</p>
    <p class="fine">Times are in-course frames at 30 fps, measured by the cabinet from when Mario gained control
    to the star grab. Players are anonymous — a build signs the claim, not the player.</p>`;
  return html;
}

function renderAbout() {
  return `
    <nav class="crumbs"><a href="#/">All builds</a> › About</nav>
    <h2>How this works</h2>
    <p>Each cabinet runs a modified Super Mario 64 ROM (<a href="https://github.com/wScottSh/sm64-nostr">sm64-nostr</a>)
      with no network connection. Grabbing a star signs the claim on the N64 as a Nostr event (kind 8064, BIP-340 Schnorr)
      and shows it as a QR code. A phone camera opens the QR's link and the reader page broadcasts the event to a relay.</p>
    <p>This site keeps a live subscription open to those relays, recomputes every event id, verifies every signature in
      your browser, and fills in each build's 120-star bingo board the moment a claim lands. There is no server — close
      this tab and the board can be rebuilt by anyone from the relays.</p>
    <h3>What a signature proves</h3>
    <p>Only <b>origin</b>: "this claim was produced by the ROM built with this key." It does not prove honest play, and
      because anyone can build a ROM with their own key, it does not prove the cabinet was a real one. Each event's
      organizer builds a private ROM with a fresh key and never distributes it. This site's operator lists the keys
      they vouch for in <span class="mono">cabinets.json</span>; everything else is shown as <b>unlisted</b>.</p>
    <h3>What the fields mean</h3>
    <ul>
      <li><b>Build</b> — one signing key under one event name: one ROM build for one event, not a person.</li>
      <li><b>Collected</b> — a star with at least one verified claim on that build.</li>
      <li><b>Time</b> — in-course frames at 30 fps. Castle Toad stars have no course timer and show —.</li>
      <li><b>Act</b> — the act selected on entry. The star is identified by course + star index, since every star is open in any act.</li>
      <li>An event's <span class="mono">created_at</span> is when the ROM was built, not when the star was grabbed (the N64 has no clock), so claims have no "first" order.</li>
    </ul>`;
}

function renderSettings() {
  return `
    <nav class="crumbs"><a href="#/">All builds</a> › Relays</nav>
    <h2>Relays</h2>
    <p>One relay URL per line. Saved in this browser only.</p>
    <textarea id="relays" rows="6" spellcheck="false">${esc(getRelays().join('\n'))}</textarea>
    <p><button data-action="save-relays">Save &amp; reconnect</button>
       <button class="secondary" data-action="reset-relays">Reset to defaults</button></p>`;
}

const PAGES = { home: renderHome, claim: renderClaim, about: renderAbout, relays: renderSettings };
let lastHtml = '';

function render() {
  const r = route();
  document.body.classList.toggle('board-route', r.page === 'board');
  if (r.page === 'board') {
    renderBoard(r);
    return;
  }
  if (boardView) {
    boardView = null;
    lastHtml = '';
    document.title = 'Mario 64 Bingo · SM64 Nostr';
  }
  renderStatus();
  // Skipping identical HTML keeps open <details> and half-typed relay edits
  // intact while unrelated claims stream in.
  const html = PAGES[r.page](r);
  if (html !== lastHtml) {
    app.innerHTML = html;
    lastHtml = html;
  }
}

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'save-relays' || action === 'reset-relays') {
    if (action === 'reset-relays') localStorage.removeItem(RELAYS_KEY);
    else {
      const urls = document.getElementById('relays').value.split(/\s+/).filter((u) => /^wss?:\/\//.test(u));
      localStorage.setItem(RELAYS_KEY, JSON.stringify(urls));
    }
    startSubscription();
    location.hash = '#/';
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'unlisted') {
    state.showUnlisted = e.target.checked;
    render();
  }
});
document.addEventListener('animationend', (e) => e.target.classList?.remove('fresh'));
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});
window.addEventListener('resize', fit);

(async () => {
  state.allowlist = await loadAllowlist();
  startSubscription();
  render();
})();
