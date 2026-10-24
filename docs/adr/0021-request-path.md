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
