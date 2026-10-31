# ADR 0021 — The request path: no database at the edge, one session read per request, a page that opens on the click

Status: **Accepted** — 2026-10-24, after the owner reported that moving between sections and tabs of the operator
desk took one to two seconds. Changes where the session is checked (SECURITY §2.0–§2.1, §2.3a), not what is checked.

## 1. Context

Measured against the built app (`next start`, the visual fixture world, `pg_stat_statements`) and production's own
response headers:

- **The proxy ran at the edge and read the database.** On Vercel, `proxy.ts` is Routing Middleware: it runs in the
  region nearest the person (`x-vercel-id: fra1::…` for a request it answers itself), while the functions run in
  `iad1` and the database is Neon `us-east-1`. The proxy ran the whole session check on every request — Better Auth's
  session read (session, then user), the guard's own read, a write to `session_activity`, then roles and grants:
  **six statements, five round trips in a row, one of them a write** — across an ocean (~90 ms from Frankfurt, ~190 ms
  from Mumbai per round trip), plus a new TLS connection to Neon whenever the pool had been idle for ten seconds.
  Constructing its runtime also started Better Auth's schema introspection, from the edge.
- **Then the page did it again**, next to the database: `operatorPage()` repeated all six statements and added a
  seventh (step-up freshness); on a full render or `router.refresh()` the layout did it a third time.
- **Every link in view was prefetched through that check.** A dynamic page with no `loading.js` gives a prefetch
  nothing to keep, yet each one passed the proxy: opening Orders sent 1 navigation and 13 prefetches — 63 statements,
  10 of them writes to the same `session_activity` row; Clients 68.
- **Nothing showed until the server had answered.** With no loading boundary, a click on a section waited for the
  whole page before the router changed anything: the rail's pill, the URL and the page all moved together, late.
- **Reads that grew with the page.** Rates read three statements per open route obligation, in a row (up to 300);
  the Desk read its queue twice per refresh (layout and page) and its strip in six round trips where two suffice.

## 2. Decision

### 2.1 The proxy reads no database
It classifies the host, sets the CSP nonce and the security headers, and on a session-gated path turns away a request
that carries **no session cookie for that surface** — sign-in for a page, `401` for anything else — using Better Auth's
own optimistic helper (`getSessionCookie`, wrapped as `carriesSessionCookie`). It opens no pool and builds no Better
Auth instance (`hostConfig()` instead of `getRuntime()`); its unit test runs with no `DATABASE_URL` at all. On the
public host a session-gated path is refused whatever cookie it carries: cookies are host-only, so none belongs there.

### 2.2 The check that decides runs where the data is, once per request
Every page, route handler and server action already read the session itself (`operatorContext` / `clientContext`,
`requireOperatorSession` / `requireClientSession`), and every command authorizes again inside its own transaction
(`authorizeOperator`: session still open, roles re-read, step-up). That is now the only session check, and it is
cheaper:

- Better Auth reads the session and its user in **one** statement (`advanced.database.joins`, the framework's own
  option — no session code of ours replaces it, SECURITY §2.0).
- The guard reads everything INRP2P decides on — surface, account status, expiry, idleness, MFA enrolment and
  verification, step-up freshness, roles and grants — in **one** statement.
- `session_activity` is written at most once a minute (`ACTIVITY_WRITE_INTERVAL_SECONDS`). The idle timeout counts from
  the recorded activity, which can only be older than the real one: a session ends at most a minute *earlier* than 30
  minutes of inactivity, never later.
- React `cache` makes it one read per request: the layout, the page and anything rendered for the same request share it.
  `cache` is scoped to one server request, so nothing about one request or operator reaches another.

A page that finds the session over sends the person to sign in; on the client host the proxy hands it the path they
asked for (`x-inrp2p-return`, always the proxy's own value, checked again with `safeReturnPath`), so they still come back.

### 2.3 A section opens on the click
`(operator)/loading.tsx`, and one per section with records (orders, clients, traders, desks), draw the page frame in
placeholders. The router prefetches that static shape with each link and shows it on the click, so the rail and the
masthead move at once and the page arrives into its own shape. It holds no figure and no heading: a number on the desk
is either the server's current one or absent. A change of a page's own query (a tab, a period, a selected row, a
search) does not show it — Next keys loading boundaries without search params — so figures stay on screen until the new
ones are read, and the clicked tab or row says it took the click. Prefetches render only the shape: they read nothing.

React reveals a page no sooner than 300 ms after its loading shape appeared (it never flashes content), so on a
loopback server a section takes about that long. In production the answer from `iad1` takes that long anyway.

### 2.4 Reads that do not grow with the page
Route positions: two statements for the page (`obligationsRemaining` — the one formula, which `obligationRemaining`
now uses for a single obligation too — and every settlement at once). The queue's three reads go out together; the strip
reads the IST day alongside what does not depend on it (two rounds, not six); the layout's queue and clock are the Desk
page's own (`_desk/reads.ts`); the operator's name comes with the session; Traders reads each trader's standing at once.

## 3. Consequences

- Measured on the built app (`origin/main` 21b7539 against this change, one seeded database, one script; top-level
  statements from `pg_stat_statements`, i.e. round trips; first visit, so the prefetches the page triggers count):

  | | before: statements · writes | after: statements · writes |
  |---|---|---|
  | Orders (1 navigation + 8 prefetches) | 63 · 10 | 4 · 0 |
  | Clients (1 + 9) | 68 · 11 | 3 · 0 |
  | Exceptions | 29 · 4 | 6 · 0 |
  | Rates | 59 · 3 | 14 · 0 |
  | Desk | 23 · 2 | 12 · 0 |
  | Desk refresh (`LiveRefresh`, every 20 s: layout and page) | 43 · 4 | 14 · 0 |
  | Rates, full load | 67 · 3 | 20 · 0 |

  The proxy's share is zero and prefetches read nothing; the session costs two statements, and a write once a minute.
  On a click the rail and the section's shape change in 16–18 ms, before the server is asked (before: nothing changed
  until the page had arrived). On loopback the page itself then lands at 190–330 ms — React's 300 ms reveal; before, at
  25–80 ms, because a loopback server pays none of the distances above. In production the edge alone cost five round
  trips across the Atlantic (≈450 ms from Frankfurt, ≈950 ms from Mumbai, more with a new TLS connection to Neon) before
  the page began; that is gone.
- The proxy's bundle traces 146 files (was 555): no `pg`, no Kysely, no Better Auth instance.
- A request that carries a stale or forged desk cookie reaches the page, which refuses it exactly as before (sign-in,
  or `401`/`403` from a route). The built-app test checks both, and that no page renders without MFA.
- Budgets that fail when this regresses: `packages/identity/test/session-cost.int.test.ts` (two statements, a write at
  most once a minute, none for no session), `packages/desk/test/read-cost.int.test.ts` (route positions in three
  statements whatever the number of obligations; the queue's and strip's statements in flight together),
  `apps/web/test/proxy.unit.test.ts` (the proxy with no database), `apps/web/e2e/navigation.spec.ts` (a section opens
  with the server's answer held back; a tab keeps the page; one request per click; every section within budget).

## 4. Addendum (2026-10-31): the proxy's own start, the workspace's frame, the public pages, the robot

A production-focused audit of the public site and the client app, after §1–§3. Production was down for the whole audit
(the Neon project over its quota), so the only production figures are the outage's own; everything else was measured
against the built app (`next start`, the visual fixture world, `pg_stat_statements`), on a Pixel 7 profile with the CPU
slowed four times, through a TCP proxy shaped like a phone in India reaching Vercel (`apps/web/e2e/netsim.ts`: two
last-mile round trips to open a connection, one per request, and the Mumbai → `iad1` round trip for everything the
edge cannot answer). The proxy is a model, not India; the figures it uses are stated there.

### 4.1 The proxy still reached the database — through its own start
§2.1 made `proxy.ts` read no database, but Next 16 runs the proxy on the Node.js runtime and registers instrumentation
there too (`build/templates/middleware.js` → `ensureInstrumentationRegistered` → `register()`). `register()` ran the
production start-up check, whose database half opened a connection to Neon and sent a statement — from the edge region
nearest the visitor, on every cold proxy: TCP, the TLS request and handshake, the login and the statement, about seven
round trips (≈0.6 s from Frankfurt, ≈1.3 s from Mumbai at §1's figures) before the proxy could classify a host. And a
database the proxy never reads could take every surface down: during the outage every request to `www.inrp2p.com`,
public pages included, spent 1.85–2.0 s and answered `500 MIDDLEWARE_INVOCATION_FAILED` (measured from Europe, five in a
row), while `favicon.ico`, which skips the proxy, answered in 0.13 s.

Decision: the check keeps both halves and moves one. The configuration half still runs in `register()`. The database
half (`databaseStartCheck`) runs before the first statement a process sends: `getRuntime()` gates both pools on it
(`createDb(pool, { ready })`, Kysely's lazily resolved pool), so nothing — not a session read, not a command — reaches the
database until it has passed, and a failed check still exits the process before anything of the application's is sent.
A process that never uses the database (the proxy, a public page) never checks it. A flag set by the proxy's module was
rejected: `next start` registers instrumentation lazily on the first request, after loading the proxy, so the flag would
have switched the check off for a whole self-hosted server. Pages that only need host names read `hostConfig()`, not
the runtime, so the public pages and the sign-in page no longer build pools or Better Auth instances.

### 4.2 The public pages stay rendered per request
Their HTML carries the per-request CSP nonce, and it has to: Next 16.3 sends a page's data as inline scripts, which a
strict policy allows only by nonce or hash. A cached page would replay one nonce to everyone (no nonce at all);
experimental SRI hashes only the external scripts; and a hash of each inline script would have to be in the header
before the page is rendered. So the HTML is not cached and the CSP is unchanged. What changes is that the public pages
no longer touch the database anywhere — not in the proxy, not in their function — so a cold start does not wait for
Neon and a database outage no longer takes the public site down. Their server time is small (TTFB 5–16 ms on loopback);
the cost a visitor in India pays is the round trip to `iad1` (≈190 ms on every page view). Rendering the public segments
nearer (a `preferredRegion` of their own, now that they need no database) is a deployment decision left open here.

### 4.3 The client workspace reads once, together
- Who is asking is one statement (`workspaceAccess`: the user, their membership and its client joined; all unique), and
  it is read once per request: `clientContext` holds the frame's `workspaceContext` to the Exchange's gate instead of
  reading it again, and Exchange, Bank & wallets and Account no longer read it a third time for the email.
- The frame's own reads — inbox, payment hold, the trader's standing with its desk (one join), desks dealt with — go out
  together (`server/workspace-frame.ts`): one round trip, not five.
- The Exchange screen reads the destinations (banks and wallets) and the latest request together, and a quote's
  destination and network fee together.

Measured on the built app: an Exchange load (with the prefetches it triggers) 22–23 → 17–18 statements; a click from
History to the Exchange 16 → 13. With the database 3 ms away, as `iad1` is from Neon, the Exchange's whole response took
39 → 29 ms (cold) and 42 → 32 ms (warm); 10 ms away, 121 → 81 ms and 125 → 84 ms — about twelve database round trips in
a row before, seven and a half after. Budgets: `packages/portal/test/read-cost.int.test.ts`,
`apps/web/test/workspace-frame.int.test.ts`. No index was added: each of these reads is served by a unique key or an index that
exists (`client_user_user_id_key`, `client_notification_unread`, `trader_profile_client_id_key`, `desk_trader_id_key`,
`desk_client_client_idx`, `bank_account_client_idx`, `crypto_wallet_client_idx`, `trade_request_client_idx`,
`quote_request_idx`, `quote_network_fee_pkey`), and the slowest of the seventeen took 0.31 ms (`pg_stat_statements`):
the cost was the round trips, not the plans.

### 4.4 The robot starts in steps
On the phone profile the live robot used to start in one task of 330–338 ms (135 ms on a desktop), at about the moment
people start to touch the page: the figure's geometry, the renderer, the studio's reflections and the programs, all at
once. It now starts a step per task — the display's frame rate, the body, the arms, the head, the headset, the renderer
and reflections, the programs — the same parts in the same order (`figureSteps`; `buildFigure` still builds at once for
the poster scripts). Measured in a GPU-backed Chromium: the robot's own blocking time 280 → 34–50 ms, its longest task
330–338 → 84–100 ms (phone profile); 85 → 0 ms with no long task (desktop). The home page's total blocking time 333–353 →
92 ms (with a GPU), 353 → 265 ms (without one, where the robot stays the poster). Frames at rest and while scrolling held
16.7 ms at the 95th percentile on this GPU before and after.

The robot also stays the still image on a connection the browser rates 3G or slower (its code is about 150 KB
compressed), production builds skip three's per-program shader logs (synchronous calls into the GPU process), and a
device whose GPU cannot keep up hands back to the still image by itself: `governor.ts` watches the robot's frames against
the display's own (measured before the robot drew, so a 30 Hz battery-saving cap is not mistaken for a slow GPU), steps
the pixel ratio down a quarter at a time to one, then shows the poster. A device that keeps up is never touched (the
e2e test checks the full pixel ratio is kept, and plays a slow GPU to see the poster come back).

### 4.5 Found, not changed here
On a cold load of the Exchange the workspace's loading shape (`(client)/loading.tsx`) paints first and the page arrives
in the same response a few milliseconds later; React 19.3 then reveals a streamed boundary no sooner than 300 ms after
the shell's first frame. On the 4G profile the heading arrives at ≈635 ms and is shown at ≈995 ms (LCP ≈1.07 s instead of
≈0.84 s); it is the same on `main`. The loading shape is §2.3's decision for clicks; changing how a full load uses it is
left to its own change (made in the follow-up at the end of this section).

On Slow 4G a cold search page is drawn before Geist arrives (`font-display: swap`), and when it does a line re-wraps: in
CI a page's onboarding note gained a line 1.8 s in and everything under it moved 17 px (CLS 0.14 on two of three loads;
none on a Mac, whose fallback happens to wrap the same). A stand-in for Geist scaled to its width (Arial at 102 %) was
tried and did not remove it in CI; it would not reach Android, whose fallback is Roboto, either. What removes a swap is
not drawing the fallback at all — `font-display: optional` with the fonts preloaded — and that shows a first slow view in
the system's face instead of Geist. That trade is the brand's to make, so the Slow 4G budget prints layout shift rather
than holding it, and the 4G budget holds it.

#### Follow-up (2026-10-31): a full load draws the page
Traced on the 4G profile: the Exchange's whole HTML — frame, loading shape and page — is in the browser by ≈390 ms; its
six stylesheets arrive at ≈640 ms. The parser stops at its first inline script until they land, and when they do the
browser draws a frame first (the frame and the shape) and reads on after it. React's shell script marks that frame
(`$RT`), so when the page's reveal (`$RC`) runs at ≈705 ms it is held to ≈1000 ms. On a warm load the stylesheets are
cached, the parser reaches `$RC` before any frame, and the page is shown at once: the hold was a cold load's alone.

Decision: the workspace's layout puts `<link rel="expect" href="#page-head" blocking="render">` in the document's head,
and `PageHead`, which every workspace page opens with (the desk's `DeskHead` is one), carries that id. Chrome draws
nothing until the heading has been read; the parser then runs on through the page to `$RC` in the same breath, so the
first frame is the page — no loading shape, no hold. Clicks are untouched: a link holds rendering only while the
document's own head is being read, so on a client navigation it does nothing, and the shape opens the section on the
click (§2.3). Browsers without `expect` (Safari, Firefox) draw as before. Every workspace page reads only the database,
in parallel with the layout, so its heading follows the frame by a few database round trips, never a call elsewhere.

Measured with the probe behind `mobile-perf` (Exchange, Pixel 7, CPU ×4, medians of 5 loads, 8 for the chosen one):

| | 4G cold: heading shown / LCP | 4G warm LCP | Slow 4G cold: heading shown / LCP | Slow 4G warm LCP | HTML |
| --- | --- | --- | --- | --- | --- |
| before | 999 / 1084 ms | 344 ms | 1592 / 1820 ms | 444 ms | 8.4 KB |
| `experimental.inlineCss` | 565 / 752 ms | 504 ms | 1035 / 1592 ms | 816 ms | 110 KB |
| `expect` until the document ends | 704 / 872 ms | 496 ms | 1333 / 1832 ms | 608 ms | 8.4 KB |
| **`expect` until the page's heading** | **703 / 880 ms** | **352 ms** | **1335 / 1832 ms** | **456 ms** | 8.4 KB |

The suite itself, before → after (medians of 3, CPU ×4): the Exchange's cold LCP 1100 → 856 ms on 4G and 1852 → 1828 ms on
Slow 4G, its heading shown 300 → 47 ms and 301 → 48 ms after reaching the document; warm LCP 352 → 348 and 472 → 464 ms.
A click from History to the Exchange drew the shape 85–96 ms after the click and the page 427–441 ms after it, before
and after (554 → 555 ms to the heading, as the suite times it). In 31 of 32 loads `$RC` ran before the first frame; the other was a warm load where a cached script ran in the
middle of the page, which was then held as before — never later than before.

Rejected:
- `experimental.inlineCss`: no stylesheet to wait for, so no hold, but the Exchange's stylesheets are 51 KB compressed
  and Next inlines them twice (in `<style>` and again in the page's data): every document grows from 8.4 to 110 KB,
  cached stylesheets or not, and warm loads lose 160 ms on 4G and 370 ms on Slow 4G. It applies to every page.
- Holding the first paint until the document ends (an id no element has): the same on a cold load, but on a warm load
  the document ends only after the cached scripts it starts have run (hydration), and the first frame moved from 344 to
  496 ms.
- Moving the loading boundary: whichever boundary the page streams into, React writes the page outside the shell (it is
  over the 12.8 KB React inlines) and reveals it with `$RC`, so the frame the stylesheets' arrival draws comes first.
- Clearing React's `$RT` from a script of our own: it works, but it edits React's private runtime and still shows the
  shape for a frame.

What is left: on a cold load the LCP is now the page's lede, recorded when Geist arrives — the fonts are requested only
once the first frame lays out text (≈780–870 ms on 4G, ≈1.8 s on Slow 4G), so on Slow 4G the heading shows 260 ms sooner
but LCP did not move. Preloading the fonts would start them with the stylesheets; it is the same trade as the swap
above, so it stays with that decision.

### 4.6 Budgets that fail when this regresses
`apps/web/test/production-start.unit.test.ts` (no statement before the check, one check per process, a failed check
sends nothing), `apps/web/test/robot-governor.unit.test.ts`, the read-cost tests above, and `apps/web/e2e/mobile-perf.spec.ts`
(project `mobile-perf`; the CPU calibrated per machine to an M1 slowed four times): the home page, a search page, the
client's sign-in and the Exchange, three cold and three warm loads each on the 4G and Slow 4G profiles, held to TTFB,
LCP 2.5 s, CLS 0.1 (4G; printed on Slow 4G, §4.5), and — generously, because CI's runners moved the same build's home
page between 388 and 858 ms of blocking time — total blocking time and a tap answered within 500 ms; the Exchange's
heading shown within 200 ms of reaching the document, cold and warm (React's hold is 300 ms: §4.5's follow-up), the hold's
link in the head and its target in the page; one request per click inside the workspace, and a click that draws the
section's shape within 500 ms with the server's answer held back; and, where the browser has a hardware GPU, the robot's start
(no task over 200 ms), its frames at rest and scrolling (95th percentile under 25 ms) and its hand-back to the poster.
