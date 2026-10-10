# nostr-leaderboard

The Mario 64 Bingo website for [sm64-nostr](https://github.com/wScottSh/sm64-nostr): airgapped Super Mario 64
cabinets that sign every star grab on the N64 as a Nostr event and show it as a QR code. The
scanner (nostr-leaderboard-scanner) broadcasts those events to relays; **this site reads them back live, verifies them, and fills in each
build's 120-star bingo board.**

Static site, no server. Every claim is checked in the browser: the NIP-01 id is recomputed from the event's own
fields and the BIP-340 Schnorr signature is verified against the build's pubkey. Anything that fails is
counted as rejected and never displayed.

## What it shows

- **Builds.** One per signing key + signed event name (`["n", ...]` tag). A build is one ROM build for one
  event, never a player. The home page lists every build with its stars collected out of 120 and its claim count.
- **Bingo board.** Per build, a full-screen board of the 120 stars: 15 courses x 7 (six acts + 100 coins), Castle
  Secrets (Toad, MIPS, the slide), and Secret Levels (cap stages, aquarium, rainbow, the three Bowser stages). A
  star is collected once the build has at least one verified claim for it. The board picks its card and tile
  layout for any window shape.
- **Claims.** Per star, every verified claim on that build, fastest first (in-course frames at 30 fps, shown as the
  in-game `M'SS"cc`); untimed claims (`frames: 0`, e.g. Toad stars) sort last; coins break ties. Each claim
  expands to its raw signed event. Stars outside the 120 still get a claim page but never count toward the board.
  `created_at` is the ROM build time, so claims have no "first claimer" order.
- **Live.** The relay subscription stays open after the initial load and reconnects dropped relays with
  backoff. A star collected after the page loaded pops on the board and shows in the board's ticker.

## Routes

| Hash | Page |
|---|---|
| `#/` | All builds |
| `#/c/<pubkey>/<event name>` | That build's bingo board |
| `#/c/<pubkey>/<event name>/<course>-<keyId>` | One star's claims on that build (the scanner links here) |
| `#/about` | How it works |
| `#/relays` | Relay list; saving reconnects |

## Known gap

The Bowser in the Sky Grand Star goes through the same ROM star-grab handler as every other star
(`bhvGrandStar` uses `INTERACT_STAR_OR_KEY`), so it probably reports as course 18 star 0, the same key as the
BITS red-coin star. On the board the two would be one tile. Unconfirmed; it needs a ROM run.

## Event contract (from sm64-nostr format v3)

Query: `{"kinds":[8064], "#t":["ag-lb"]}`. A run is accepted only if its id and signature verify and it has
`["t","ag-lb"]`, `["t","sm64"]`, exactly one `["n","<EVENT NAME>"]`, and content
`{"course","act","coins","frames","nonce","keyId"}` with in-range integers. `created_at` is the ROM's build
epoch, not the time of the run (the N64 has no clock).

## Trust: the allowlist

A signature proves only *origin* — "produced by the ROM built with this key" — not honest play, and anyone can
build a ROM with their own key. So which builds count is the operator's call: list the keys you vouch for in
[`public/cabinets.json`](public/cabinets.json):

```json
{ "cabinets": [ { "pubkey": "<64-char hex from the build wizard / keys/registry.md>",
                  "name": "SUMMER JAM 2026", "label": "Summer Jam @ The Arcade" } ] }
```

`name` (optional) pins the entry to one event name; `label` (optional) is the display name. Listed builds show
by default; other validly signed builds are behind a "show unlisted" toggle. While the list is empty, every
valid build is shown with a warning banner.

## Develop

```
npm install
npm test            # verifier/model/board/relay tests, incl. a real ROM-pipeline-signed event
npm run dev         # http://localhost:8064
npm run demo-relay  # ws://localhost:7777 with signed demo claims + one forgery, plus a new
                    # live claim every 6 s; add it on the site's "relays" page
npm run build       # -> dist/
```

Default relays: `relay.damus.io` (where the sm64-nostr reader broadcasts), `nos.lol`, `relay.primal.net`.
Visitors can change them on the relays page (stored in their browser only).

## Deploy

`.github/workflows/pages.yml` tests, builds, and publishes `dist/` to GitHub Pages on every push to `master`.
One-time setup: repo Settings → Pages → Source = **GitHub Actions**.

---

## Original concept doc

> Superseded by the sm64-nostr design (kind 8064, format v3, phone-camera reader). Kept for history; the event
> schema below (kind 33334, `NOSTR-EVENT:1:` QR prefix) is **not** what cabinets emit.

**TL;DR:** Here is the complete, self-contained handoff package: (1) a full user story written in plain English for any AI/agent, and (2) a rigorous, first-principles implementation specification that dissolves every dependency (no clock, no eternal web pages, no client assumptions) using only NOSTR primitives (NIP-01 + NIP-133 kind 33334), monotonic counters, prefixed QR text, physical paper redundancy, and one-time Arweave upload. Copy-paste both sections directly to any AI coder with zero prior context—they contain every detail needed to build the arcade machine firmware, QR generator, broadcaster, and indexer logic.

### Complete User Story
**Title:** As an arcade machine owner/operator, I want players to submit verifiable high scores to a global, decentralized NOSTR leaderboard without the machine ever connecting to the internet, so that the leaderboard remains tamper-proof, credible (machine-attested), and permanently accessible even if clients, domains, or storage networks change in the next 100 years.

**Actor:** Arcade player (human with a smartphone and NOSTR identity) interacting with an offline arcade cabinet.

**Goal:** After finishing a game session, the player receives a QR code containing an immutable, cryptographically signed score record from the machine. They scan it, publish the machine's signed event to NOSTR relays via any available tool, then optionally attach their personal identity claim. The resulting dual-event chain appears on any global leaderboard that queries for this game.

**Preconditions:**
- The arcade machine has a dedicated, secret NOSTR keypair (never exposed).
- The machine has no internet, no RTC/clock, and runs on embedded hardware (e.g., Arduino, ESP32, Raspberry Pi Zero in air-gapped mode).
- The player has a NOSTR client or browser on their phone.

**Main Flow:**
1. Player completes a game session on the arcade machine.
2. Machine increments its internal monotonic boot/play counter (unique nonce).
3. Machine constructs a full, signed NOSTR event (kind 33334 per NIP-133) containing the exact score, game ID, and nonce.
4. Machine generates a QR code prefixed with "NOSTR-EVENT:1:" followed by the complete signed JSON (minified, optionally gzip+base64).
5. Screen displays the QR + on-screen instructions + printed cabinet manual with full backup steps.
6. Player scans QR with phone camera → copies text → opens a static broadcaster page (or types into any WebSocket tool).
7. Broadcaster validates the machine signature offline, lets player choose relays, and broadcasts the exact signed event.
8. Player then creates a second event signed by their own nsec that references the machine event ID via `e`-tag (co-attestation).
9. Both events are published to public relays.
10. Any NOSTR indexer/client querying the game's `d`-tag + machine pubkey + nonce sees the score and associated player claim(s).

**Alternative/Edge Flows:**
- Multiple players scan the same QR: each can publish their own claim event; indexers flag duplicates via nonce.
- No phone/browser: player uses printed base64 + manual WebSocket instructions to publish later.
- Game machine reboots: monotonic counter continues from non-volatile storage.

**Acceptance Criteria (non-functional, eternal):**
- Machine event is immutable and verifiable by any future tool using only cryptography.
- No reliance on any specific domain, app, or decentralized storage surviving beyond the initial upload.
- Ordering of scores is preserved via nonce (not wall-clock).
- Leaderboard can be reconstructed from raw relays 100 years later using only the event graph.
- Fraud (duplicate claims) is publicly detectable and filterable at the indexer layer.
- Entire system works if every current NOSTR client disappears tomorrow.

**Success Metric:** A score played today on the arcade appears on a global leaderboard query tomorrow, and the cryptographic proof still validates in 2126.

### Full Implementation Specification
This spec is written from first principles: NOSTR is nothing more than signed JSON events sent over WebSocket (NIP-01). The arcade machine is the sole source of truth for score *values*. The network is an event graph, not a database. We dissolve clock and permanence problems by making the machine event self-describing and broadcastable by humans with paper + any computer. All code/examples are language-agnostic but include ready-to-adapt snippets.

#### 1. Core Architecture (Dissolved Dependencies)
- **Machine side (offline):** Embedded firmware only. Hardcoded game private key (or securely derived). Monotonic 64-bit counter in non-volatile storage (EEPROM/flash). No RTC needed.
- **Transport:** Single QR containing text payload. Prefix ensures future parsers recognize it.
- **Broadcast:** Primary = human-readable text + manual instructions. Secondary = one-time Arweave-uploaded static HTML (optional).
- **Player claim:** Second event signed by player's nsec, linked via `e`-tag + echoed nonce.
- **Leaderboard:** Emergent from any relay query + simple indexer logic (sort by nonce then claim time). No central service required.

#### 2. NOSTR Event Schemas (Exact JSON)
**Machine-signed Score Event (Game Authority) – Kind 33334 (NIP-133)**
```json
{
  "kind": 33334,
  "content": "12345",                                   // or JSON string: "{\"score\":12345,\"level\":5,\"time\":123}"
  "created_at": 0,                                     // fixed safe base (or base + counter % some large number)
  "tags": [
    ["d", "your-game-unique-id-v1"],                   // game identifier – same for all scores of this title
    ["x", "play-nonce:boot-1742-seq-005"],             // REQUIRED unique monotonic identifier
    ["t", "highscore"],
    ["game-time", "1742-005"]                          // human-readable counter for debugging
  ],
  "id": "<computed SHA256>",
  "pubkey": "<game machine pubkey hex>",
  "sig": "<Schnorr signature hex>"
}
```
Serialization for ID/sig (NIP-01 exact order): `[0, pubkey, created_at, kind, tags, content]`

**Player Co-Attestation Event (Optional but Recommended)**
Any kind (33334 or 1); must contain:
- `["e", "<machine-event-id>", "", "root"]`
- Echo of `["x", "play-nonce:boot-1742-seq-005"]`
- Player's real `created_at` (phone time)

#### 3. Machine-Side Implementation (Offline Firmware)
- Store monotonic counter in non-volatile memory; increment on every play/boot.
- Use any NOSTR library capable of offline signing (nostr-sdk Rust, python-nostr, nostr-tools JS, or bare secp256k1 + SHA256).
- Pseudocode:
  ```python
  counter = read_flash_counter() + 1
  write_flash_counter(counter)
  event_template = {
    "kind": 33334,
    "content": str(score),
    "created_at": 0,
    "tags": [["d", GAME_ID], ["x", f"play-nonce:boot-{boot_id}-seq-{counter}"]]
  }
  signed_event = sign_event(event_template, GAME_PRIVKEY)  # adds id, pubkey, sig
  payload = "NOSTR-EVENT:1:" + json.dumps(signed_event, separators=(',',':'))
  generate_qr(payload)  # version 40 QR, gzip+base64 if >4KB
  ```
- Display QR + "Scan with any phone → open broadcaster or paste into WebSocket".

#### 4. QR Format (Eternal, No External Tool Required)
Exact string inside QR:
`NOSTR-EVENT:1:<minified-signed-json-or-gzip-base64>`

Version 1 is immutable. Future parsers strip prefix and decode.

#### 5. Broadcast Mechanism (Self-Contained & Paper-Redundant)
**Primary (eternal):** Printed manual in cabinet + on-screen text:
```
1. Scan QR or copy the text after "NOSTR-EVENT:1:"
2. Open any WebSocket to a public relay (e.g. wss://relay.damus.io)
3. Send exactly: ["EVENT", <paste the full JSON>]
4. Done. Event ID will be shown.
```
Any terminal, script, or future AI can do this forever.

**Secondary (convenience):** One-time upload the following static HTML to Arweave (permaweb URL printed on cabinet). HTML is <100 KB, pure JS (jsQR + noble-curves for validation + WebSocket). It:
- Scans/pastes QR.
- Validates signature offline.
- Lets user select/add relays.
- Sends ["EVENT", ...].
- Optionally generates player claim template.

Upload once via arweave.net or bundlr; fee is permanent endowment.

#### 6. Leaderboard/Indexing Logic (Application Layer)
Any relay query:
```json
{"kinds": [33334], "authors": ["game-pubkey"], "#d": ["your-game-unique-id-v1"]}
```
Then:
- Collect machine events.
- For each, find player events with matching `e`-tag + echoed `x` nonce.
- Sort first by parsed nonce (deterministic), then by earliest player claim `created_at`.
- Flag any nonce with >1 distinct player claim as disputed.

Existing gamestr.io forks can add this with <50 lines.

#### 7. Security & Edge Cases
- Machine privkey never leaves firmware (rotate via physical update if needed).
- Nonce prevents replay/duplicates.
- Signature verification is the only trust root.
- Spam: relays handle via NIP-13 PoW if needed.
- No clock: ordering is nonce-driven; OpenTimestamps (NIP-03) can be layered later for approximate real-time proof.

#### 8. Testing & Handoff Checklist for AI Agent
- Generate test keypair → sign sample event → QR → simulate broadcast → query public relays.
- Verify signature with any nostr-tools library.
- Confirm duplicate claim on same nonce is detectable.
- Include full example signed JSON in repo.

This package is now complete and self-contained. Hand it off verbatim—no further context required. The system is maximally decentralized, cryptographically eternal, and solves every constraint you raised without handwaving.
