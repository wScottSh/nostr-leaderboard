/*
 * main.js -- the page. Loads the operator allowlist, queries relays, verifies
 * every event (model.parseRun), and renders cabinets -> star boards -> runs.
 * Routing is hash-based so the whole site is static files:
 *   #/                                  cabinet list
 *   #/c/<pubkey>/<event name>           that cabinet's star boards
 *   #/c/<pubkey>/<event name>/<c>-<k>   one star's ranked runs
 */
import { parseRun, buildIndex, starBoards, cabinetKey } from './model.js';
import { buildFilter, queryRelays, DEFAULT_RELAYS } from './relay.js';
import { COURSES, courseName, starName, formatFrames } from './stars.js';

const RELAYS_KEY = 'sm64lb.relays';
const app = document.getElementById('app');
const statusEl = document.getElementById('status');

const state = {
  allowlist: [],
  runs: new Map(), // id -> run
  rejectedSeen: new Set(), // fingerprints of invalid events, so relay echoes count once
  rejected: 0,
  relayResults: [],
  loading: false,
  showUnlisted: false,
};

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

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  state.relayResults = [];
  renderStatus();
  let pending = 0;
  const flush = () => {
    pending = 0;
    render();
  };
  state.relayResults = await queryRelays(getRelays(), buildFilter(), (ev) => {
    // Dedupe only on VERIFIED ids: an event's id is just a claim until
    // parseRun checks it, so a forgery reusing a real run's id must not be
    // able to shadow the genuine event by arriving first.
    if (!ev || typeof ev.id !== 'string' || state.runs.has(ev.id)) return;
    const run = parseRun(ev);
    if (run) state.runs.set(run.id, run);
    else {
      const fingerprint = `${ev.id}:${ev.sig}:${ev.content}`;
      if (!state.rejectedSeen.has(fingerprint)) {
        state.rejectedSeen.add(fingerprint);
        state.rejected++;
      }
    }
    // Coalesce re-renders while events stream in.
    if (!pending) pending = setTimeout(flush, 150);
  });
  state.loading = false;
  render();
}

function cabinets() {
  return buildIndex([...state.runs.values()], state.allowlist);
}

function renderStatus() {
  const relays = getRelays();
  const chips = relays
    .map((url) => {
      const r = state.relayResults.find((x) => x.relay === url);
      const cls = !r ? 'pending' : r.ok ? 'ok' : 'bad';
      const title = !r ? 'querying…' : r.ok ? `${r.count} events` : r.error;
      return `<span class="chip ${cls}" title="${esc(title)}">${esc(url.replace(/^wss:\/\//, ''))}</span>`;
    })
    .join('');
  statusEl.innerHTML = `
    <div class="chips">${chips}</div>
    <div class="counts">
      ${state.loading ? '<span class="spin">★</span> querying relays · ' : ''}
      <b>${state.runs.size}</b> verified runs${state.rejected ? ` · <span title="bad signature, wrong shape, or not sm64">${state.rejected} rejected</span>` : ''}
      · <button class="link" data-action="refresh">refresh</button>
      · <button class="link" data-action="settings">relays</button>
    </div>`;
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'c' && parts[1]) return { pubkey: parts[1], name: parts[2] ?? '', star: parts[3] };
  if (parts[0] === 'about') return { about: true };
  return {};
}

const cabinetHref = (c) => `#/c/${c.pubkey}/${encodeURIComponent(c.eventName)}`;

function renderHome() {
  const all = cabinets();
  const listed = all.filter((c) => c.listed);
  const unlisted = all.filter((c) => !c.listed);
  const noAllowlist = state.allowlist.length === 0;
  const shown = noAllowlist || state.showUnlisted ? all : listed;

  let html = '';
  if (noAllowlist && all.length) {
    html += `<p class="notice">No cabinets are on this site's allowlist yet, so every validly signed
      sm64 cabinet found on the relays is shown. A signature only proves which ROM build produced a run —
      anyone can build a ROM. <a href="#/about">Why this matters</a>.</p>`;
  }
  if (!shown.length) {
    html += state.loading
      ? '<p class="empty">Looking for star captures…</p>'
      : `<p class="empty">No ${noAllowlist ? '' : 'listed '}cabinet runs found on these relays yet.</p>`;
  } else {
    html += '<div class="cabinets">';
    for (const c of shown) {
      const stars = new Set(c.runs.map((r) => `${r.course}-${r.keyId}`)).size;
      html += `
        <a class="cabinet ${c.listed ? 'listed' : 'unlisted'}" href="${cabinetHref(c)}">
          <div class="cab-name">${esc(c.label || c.eventName)}</div>
          ${c.label ? `<div class="cab-event">${esc(c.eventName)}</div>` : ''}
          <div class="cab-meta">${c.runs.length} runs · ${stars} stars</div>
          <div class="cab-key mono">${shortHex(c.pubkey)} ${c.listed ? '<span class="badge">listed</span>' : '<span class="badge warn">unlisted</span>'}</div>
        </a>`;
    }
    html += '</div>';
  }
  if (!noAllowlist && unlisted.length) {
    html += `<label class="toggle"><input type="checkbox" data-action="unlisted" ${state.showUnlisted ? 'checked' : ''}>
      Show ${unlisted.length} unlisted cabinet${unlisted.length === 1 ? '' : 's'} (valid signature, unknown operator)</label>`;
  }
  return html;
}

function findCabinet(r) {
  return cabinets().find((c) => c.key === cabinetKey(r.pubkey, r.name));
}

function cabinetHeader(cab) {
  return `
    <nav class="crumbs"><a href="#/">All cabinets</a> › <a href="${cabinetHref(cab)}">${esc(cab.label || cab.eventName)}</a></nav>
    <div class="cab-head">
      <h2>${esc(cab.label || cab.eventName)}</h2>
      ${cab.listed ? '<span class="badge">listed</span>' : '<span class="badge warn" title="Valid signature, but this site\'s operator has not vouched for this cabinet">unlisted</span>'}
    </div>
    <p class="sub">Event <b>${esc(cab.eventName)}</b> · cabinet key <span class="mono" title="${cab.pubkey}">${shortHex(cab.pubkey)}</span>
      · ROM built ${new Date(cab.builtAt * 1000).toISOString().slice(0, 10)}</p>`;
}

function renderCabinet(r) {
  const cab = findCabinet(r);
  if (!cab) return state.loading ? '<p class="empty">Loading…</p>' : '<p class="empty">No runs for this cabinet on these relays. <a href="#/">Back</a></p>';
  if (r.star) return renderStar(cab, r.star);

  const boards = starBoards(cab.runs);
  const byCourse = new Map();
  for (const b of boards) {
    if (!byCourse.has(b.course)) byCourse.set(b.course, []);
    byCourse.get(b.course).push(b);
  }
  let html = cabinetHeader(cab);
  html += `<table class="board"><thead><tr><th>Star</th><th class="num">Best time</th><th class="num">Coins</th><th class="num">Runs</th></tr></thead>`;
  for (const [course, list] of byCourse) {
    html += `<tbody><tr class="course-row"><th colspan="4"><span class="abbr">${esc(COURSES[course]?.abbr ?? course)}</span> ${esc(courseName(course))}</th></tr>`;
    for (const b of list) {
      const best = b.runs[0];
      const mostCoins = Math.max(...b.runs.map((x) => x.coins));
      html += `<tr class="clickable" data-href="${cabinetHref(cab)}/${b.key}">
        <td><span class="star">★</span> <a href="${cabinetHref(cab)}/${b.key}">${esc(starName(b.course, b.keyId))}</a></td>
        <td class="num time">${formatFrames(best.frames)}</td>
        <td class="num">${mostCoins}</td>
        <td class="num">${b.runs.length}</td></tr>`;
    }
    html += '</tbody>';
  }
  html += '</table>';
  return html;
}

function renderStar(cab, starKey) {
  const board = starBoards(cab.runs).find((b) => b.key === starKey);
  if (!board) return cabinetHeader(cab) + '<p class="empty">No runs for this star.</p>';
  let html = cabinetHeader(cab);
  html += `<h3><span class="star">★</span> ${esc(starName(board.course, board.keyId))}
    <span class="sub">— ${esc(courseName(board.course))}</span></h3>`;
  html += `<table class="board runs"><thead><tr><th class="num">#</th><th class="num">Time</th><th class="num">Frames</th>
    <th class="num">Coins</th><th class="num">Act</th><th>Run (event id)</th></tr></thead><tbody>`;
  board.runs.forEach((run, i) => {
    const rank = run.frames ? i + 1 : '–';
    html += `<tr class="${i < 3 && run.frames ? `podium p${i + 1}` : ''}">
      <td class="num">${rank}</td>
      <td class="num time">${formatFrames(run.frames)}</td>
      <td class="num mono">${run.frames || '—'}</td>
      <td class="num">${run.coins}</td>
      <td class="num">${run.act}</td>
      <td><details><summary class="mono">${shortHex(run.id)}</summary>
        <pre>${esc(JSON.stringify(run.raw, null, 2))}</pre></details></td></tr>`;
  });
  html += '</tbody></table>';
  html += `<p class="fine">Times are in-course frames at 30 fps, measured by the cabinet from when Mario gained control
    to the star grab. Players are anonymous — a cabinet signs the run, not the player.</p>`;
  return html;
}

function renderAbout() {
  return `
    <nav class="crumbs"><a href="#/">All cabinets</a> › About</nav>
    <h2>How this works</h2>
    <p>Each cabinet runs a modified Super Mario 64 ROM (<a href="https://github.com/wScottSh/sm64-nostr">sm64-nostr</a>)
      with no network connection. Grabbing a star signs the run on the N64 as a Nostr event (kind 8064, BIP-340 Schnorr)
      and shows it as a QR code. A phone camera opens the QR's link and the reader page broadcasts the event to a relay.</p>
    <p>This site asks relays for those events, recomputes every event id, verifies every signature in your browser,
      and ranks what survives. There is no server — close this tab and the leaderboard can be rebuilt by anyone from the relays.</p>
    <h3>What a signature proves</h3>
    <p>Only <b>origin</b>: "this run was produced by the ROM built with this key." It does not prove honest play, and
      because anyone can build a ROM with their own key, it does not prove the cabinet was a real one. Each event's
      organizer builds a private ROM with a fresh key and never distributes it. This site's operator lists the keys
      they vouch for in <span class="mono">cabinets.json</span>; everything else is shown as <b>unlisted</b>.</p>
    <h3>What the fields mean</h3>
    <ul>
      <li><b>Cabinet key</b> — one ROM build for one event, not a person.</li>
      <li><b>ROM built</b> — the event's <span class="mono">created_at</span>: when the ROM was signed, not when the run happened (the N64 has no clock).</li>
      <li><b>Time</b> — in-course frames at 30 fps. Castle Toad stars have no course timer and show —.</li>
      <li><b>Act</b> — the act selected on entry. The star is identified by course + star index, since every star is open in any act.</li>
    </ul>`;
}

function renderSettings() {
  const relays = getRelays();
  return `
    <nav class="crumbs"><a href="#/">All cabinets</a> › Relays</nav>
    <h2>Relays</h2>
    <p>One relay URL per line. Saved in this browser only.</p>
    <textarea id="relays" rows="6" spellcheck="false">${esc(relays.join('\n'))}</textarea>
    <p><button data-action="save-relays">Save &amp; reload</button>
       <button class="secondary" data-action="reset-relays">Reset to defaults</button></p>`;
}

function render() {
  renderStatus();
  const r = route();
  if (location.hash === '#/relays') app.innerHTML = renderSettings();
  else if (r.about) app.innerHTML = renderAbout();
  else if (r.pubkey) app.innerHTML = renderCabinet(r);
  else app.innerHTML = renderHome();
}

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'refresh') refresh();
  else if (action === 'settings') location.hash = '#/relays';
  else if (action === 'save-relays' || action === 'reset-relays') {
    if (action === 'reset-relays') localStorage.removeItem(RELAYS_KEY);
    else {
      const urls = document.getElementById('relays').value.split(/\s+/).filter((u) => /^wss?:\/\//.test(u));
      localStorage.setItem(RELAYS_KEY, JSON.stringify(urls));
    }
    location.hash = '#/';
    refresh();
  } else if (!action) {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a')) location.hash = row.dataset.href;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'unlisted') {
    state.showUnlisted = e.target.checked;
    render();
  }
});
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

(async () => {
  state.allowlist = await loadAllowlist();
  render();
  refresh();
})();
