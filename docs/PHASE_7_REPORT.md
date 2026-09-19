# Phase 7 — Client product

Status: implemented, gates green, **stopped for review**. Phase 8 not started.

Plan line: *Exchange (both directions), firm quote states, quote link page + OTP acceptance verification (D-01,
W3b), trade tracking, history, bank & wallets, account, notifications (in-app + email). Exit: E2E from link open
on mobile viewport to completion; client JSON leakage test; visual regression for client validation list;
Lighthouse mobile ≥ 90 for link page.*

---

## 1. What a client can now do

The desk has had a product since Phase 6. This phase gives the other side of every trade one too: a person with a
phone, a message and a decision to make.

| Screen | Path | What it is |
|---|---|---|
| Exchange | `/exchange` | Ask for a price, then act on the one the desk sent. One live conversation at a time. |
| Trade | `/trades/{ref}` | Where the money is: four stages, the deposit address, the payments as they land. |
| History | `/history` | Their own trades, newest first, filtered by what is still running. |
| Accounts | `/accounts` | Bank accounts and wallets — where their money is allowed to go. Read-only (see §2). |
| Notifications | `/notifications` | What they were told, and whether they have seen it. |
| Sign in | `/sign-in` | A code to an address the desk already knows (SECURITY §2.2). |
| Quote link | `/q/{token}` on the public host | A firm price for whoever holds the link, and a challenge before anything moves. |

Two new domain packages carry the reads, and neither one decides anything:

* **`@inrp2p/portal`** — the client's own projections: `portalAccess` (who is asking, from the session, never
  from a URL), `clientDestinations`, `exchangeView`, `portalTrade`, `clientHistory`. Every return value passes
  through `clientSafe`, which runs `assertClientSafe` in production and not only in tests, so a future join that
  adds a column nobody reviewed fails the request rather than teaching a client what the desk paid for their
  USDT.
* **`@inrp2p/notifications`** — the in-app inbox, written from the events the domain already emits, plus the
  email channel that carries the same words to the same people.

### The quote link (D-01, D-15, W3b)

The link page is built on one premise: **holding a link is not authority**. Opening it reads the quote through the
client projection and writes nothing but the link's own telemetry and an audit event. Accepting or formally
declining needs a six-digit code, sent only to a verified address of someone the client already authorized to
decide, verified in its own committed transaction (so a wrong code costs an attempt) and then re-verified and
consumed inside the acceptance transaction. No session substitutes for the code, and the page never sees one.

The page lives on the public host and is the *only* thing published there — `gateFor` now refuses every other
path on that host rather than rendering it, because a page that needs a session has no business on an origin that
never receives one.

### Notifications, in-app and by email

`clientNotificationHandler` turns the `client.*`, `quote.sent` and `trade.opened` events into inbox rows. A
notification therefore exists only because a command wrote a state change and enqueued an event in the same
transaction — it cannot be true of a trade that did not happen. The row is keyed by the event id, so an
at-least-once redelivery says the same thing once.

`clientNotificationEmailHandler` is the second channel, and it composes nothing of its own: it reads the row the
inbox handler just wrote and sends *that* text, claiming `email_sent_at` with a conditional update before it
sends. If the two channels could word things differently, one of them would eventually be wrong.

Not every kind earns an email — a client who has just accepted a quote is looking at the trade. `QUOTE_SENT`,
`REQUEST_DECLINED`, `TRADE_COMPLETED`, `TRADE_CANCELLED` and the two destination changes do; the rest stay in the
inbox.

---

## 2. Decisions taken in this phase

**A client page identifies a quote by its reference, not by an id.** The client projections carry no internal
ids (SECURITY §5), so the server actions take `quoteRef` / `requestRef` and resolve them with `quoteIdForRef`,
filtered by the client the session resolved to. A reference from another client's quote is simply not found, and
the command then authorizes the membership again for itself.

**`PoolCustodyAdapter` is honest about what it can do.** In POOL mode (D-02) the provider does not issue an
address per trade; addresses are imported once and handed out from `deposit_address` under `FOR UPDATE SKIP
LOCKED`. The only thing an adapter contributes at acceptance time is its identity and its declared capability,
which is exactly what `requireAdapterMatchesRecord` checks against the recorded `custody_provider_config`. So the
adapter implements that and nothing else: `listDepositAddresses` returns nothing rather than inventing addresses
(a fabricated address is a client's funds sent nowhere), and `allocateDepositAddress` refuses, because a POOL
provider deriving on demand is a contradiction rather than a fallback. With nothing configured,
`UnconfiguredCustodyAdapter` reports UNSUPPORTED — the same answer the database gives with no capability
recorded — so SELL acceptance refuses loudly.

**The `Host` header decides the surface, and a configured port is compared when one is given.** A configured host
without a port still matches the name on any port (what a deployment behind a load balancer needs). This is what
lets a harness serve all three surfaces from one loopback address on three ports, which was the alternative to
either loosening a real origin check or trusting name resolution again — the failure that cost Phase 6 two
canonical runs.

**A permanently failing outbox was found and named.** The dispatcher refuses to mark an event dispatched when no
handler claims it: *"an event nobody handles is a wiring bug."* It was right. Eleven event types — the nine
`desk.*` signals, `capacity.over_committed` and `receipt.generate` — had no handler at all and were retrying ten
times and failing for good. Nothing was lost (the desk's queue, the INR screen and the exception list are all
derived from the rows), but a permanently failing outbox is a bad place to look for a real problem. The fix is
not a catch-all: `ACKNOWLEDGED_SIGNALS` names each type with what it is waiting for, and a type that is not on
the list still fails loudly. Recorded as **TD-10**.

**The link's "Not now" is a local dismissal, and nothing else.** SECURITY §2.3 and D-15 are explicit: the
unauthenticated Decline on the link page changes nothing, and the quote stays SENT until it is formally rejected
with a code, cancelled, superseded or runs out. The page now says exactly that — *"Nothing has been sent to the
desk"* — and offers telling the desk as a separate, deliberate act that goes through the same code challenge as
acceptance. A client who believes they have declined, and has not, is a client the desk will chase.

**The client Accounts screen shows and does not change, and there are no client server actions for
destinations.** Adding or archiving one is a sensitive client-admin action needing an enrolled authenticator and
a fresh TOTP step-up (SECURITY §2.2, D-08) — and client TOTP enrolment does not exist: `clientAuthOptions` has
the email-OTP plugin and no `twoFactor` plugin, so there is no code a client could type that would satisfy the
rule. A control that cannot work is worse than no control, and a server action that every call would refuse is
not a smaller gap than none — it is the same gap with an attack surface. The screen says destinations are changed
with the desk, which is what already happens (`client_bank:add`, `client_wallet:manage`, both ⧗, both audited).
Recorded as **TD-11**.

**The email channel is registered only when a provider exists.** An acceptance code that cannot be delivered must
fail loudly — the person is waiting for it. A notification email is different: the inbox is the channel of record
and it is already written, so a handler that throws on every send would fail its event and take the working
channel down with the unconfigured one. The worker says so at startup instead: *client notifications: in-app only
— no email provider is configured (TD-04)*.

---

## 3. Exit criteria

| Criterion | Result |
|---|---|
| E2E from link open on a mobile viewport to completion | **Met** — `apps/web/e2e/client.spec.ts`, Pixel 7 profile, 5 tests |
| Client JSON leakage test | **Met** — `packages/portal/test/leakage.int.test.ts`, 3 tests over 7 payloads |
| Visual regression for the client validation list | **Met** — 9 new page captures (20 in the manifest); recording is TD-09 |
| Lighthouse mobile ≥ 90 for the link page | **Met** — performance 94–97, accessibility 100, best practices 96 |

### The end-to-end run

One client, one phone, across all three surfaces of the built app:

1. The desk prices a request and sends a quote with a shareable link (real commands, real authorization).
2. The link opens on the public host. The quote is there; the route rate, the margin and the route's name are
   not. **Opening it changed nothing** — the quote is still `SENT`.
3. A wrong code is refused with a message that says nothing about which half was wrong, and the quote is *still*
   `SENT`. So is "Not now": the dismissal is local, the quote is untouched, and the link still works afterwards
   (D-15).
4. The real code — taken through the product's own delivery path, `deliverAcceptanceCode`, so the harness plays
   the email provider rather than reading a column — accepts it. A trade exists.
5. The client signs in through the real form on the client host, follows that trade: deposit instructions, then
   the confirmed transfer, then ₹40,000 still to come after the first payout, then settled.
6. History and the inbox show it, and neither says anything of the desk's.
7. The client host refuses what belongs to the desk; the public host refuses the client product, sign-in
   included.

### The leakage test

Seven payloads — access, destinations, exchange, trade, history, inbox, quote link — searched twice. Once for
**keys** the desk owns, which proves `assertClientSafe` is actually in the path. Once for **values**, which is the
half a key check cannot do: the world is built so the desk buys at ₹92.50 and sells at ₹90.00, making ₹2,500 on
the trade, and those figures must not appear anywhere under any field name. A third test asserts the payloads are
not simply empty: the client's own rate, amount, ₹90,000 and the ₹50,000 already paid are all there.

### Visual regression

Nine new captures, same canonical environment and same fixture world as the operator list:
`client-exchange-quote`, `client-trade-awaiting-usdt`, `client-trade-settling`, `client-trade-completed`,
`client-history`, `client-accounts`, `client-notifications`, and the link on a phone before and at the code step
(`link-quote-mobile`, `link-verification-mobile`). The client captures are taken under a session the product
itself issued; the link captures with `storageState: { cookies: [], origins: [] }`, because the link must render
for someone who has never signed in and a baseline taken with a cookie in the jar would not prove it.

All twenty reproduce pixel-for-pixel through the self-check path against a freshly re-seeded database. None of
them is a baseline until the canonical run records them (**TD-09**).

Three read models gained an `id` tiebreak while making this deterministic — `exchangeView`, `clientHistory` and
`clientInbox` all ordered by a timestamp alone, and rows written in one transaction share it. That is a real
ordering bug outside the fixture too: "the latest request" was whichever row the planner returned.

### Lighthouse

```
Performance    94–97  ok   (gate 90; the spread is the throttled run's own variance)
Accessibility    100  ok
Best Practices    96  ok
SEO               50  reported only
```

Lighthouse's own mobile defaults, against the built page, in the pinned Chromium the pixel baselines use. SEO is
printed but not gated: a private quote is deliberately `noindex`, and gating on it would mean either lying about
the page or making it indexable.

---

## 4. Gates

| Gate | Result |
|---|---|
| `pnpm run lint` | pass |
| `pnpm run typecheck` | pass |
| `pnpm run versions:check` | pass (25 manifests) |
| `pnpm run secret-scan` | pass (665 files) |
| `pnpm run workspace:graph` | pass (acyclic) |
| `pnpm run test:unit` | 241 tests, 15 files |
| `pnpm run test:integration` | 551 tests, 24 files |
| `pnpm --filter @inrp2p/web build` | pass |
| `pnpm --filter @inrp2p/web test:e2e` | 7 tests (2 desk, 5 client-mobile) |
| `pnpm --filter @inrp2p/web test:visual:selfcheck` | 20 captures, reproduced |
| `pnpm --filter @inrp2p/web test:lighthouse` | pass |

Canonical visual comparison cannot run here: `mcr.microsoft.com` is refused by the organization's egress policy
(TD-09), so the self-check path was used, exactly as in Phase 6.

---

## 5. Schema

One migration, `0017_notifications.sql`:

* `client_notification` — the inbox. A notification is a **pointer**, not a copy of the trade: the reference the
  client already knows and the few figures the message needs.
* `outbox_event_id uuid NOT NULL UNIQUE`, deliberately **not** a foreign key. The dispatcher holds `FOR UPDATE`
  on the event row while it runs handlers, so a foreign key here would make the insert wait for a key-share lock
  on the row its own dispatcher holds — the handler would block on the transaction that invoked it. (It did: the
  first version of the test timed out at 243s.) The uniqueness is what the column is for, and the outbox is
  append-only, so the reference cannot dangle in practice.
* `CHECK client_notification_no_internal_terms` — `route|margin|spread|provider|custody|dealer|obligation|
  liquidity|suspense` refused in the title and body. Cheap, and it fails at write time rather than in front of
  the client.
* Immutable except `read_at` and `email_sent_at`; no deletes; column-level `GRANT UPDATE`.

---

## 6. Test-only configuration introduced

Two switches, both off unless named, both documented, neither able to exist in production:

| Setting | What it does | Guard |
|---|---|---|
| `INRP2P_CLIENT_OTP_SINK_FILE` | Writes client sign-in codes to a file so a run can sign in through the real form | Throws when `INRP2P_ENV=production` |
| `INRP2P_CUSTODY_PROVIDER` / `INRP2P_CUSTODY_CAPABILITY` | The provider slug acceptance checks itself against | Not test-only; `POOL` is the only implemented capability, anything else refuses at startup |

The sink exists because the alternative was forging a session row in the harness, which would have skipped the
one thing the test proves: that the product issues the session the client pages then run under. A login code in a
log is a login code in whatever reads the logs, so there is still no logging adapter.

---

## 7. What is not done

* **Email is wired, not delivered** (TD-04, widened). Acceptance codes, client sign-in codes and notification
  emails all need the same missing `NotificationAdapter`. Until it exists the in-app inbox is the client's only
  channel and no client can sign in to a deployed environment.
* **Receipts** — `receipt.generate` is enqueued on full settlement and acknowledged, not consumed. Phase 8.
* **A desk push channel** — the `desk.*` signals and `capacity.over_committed` are acknowledged, not consumed
  (TD-10).
* **Page baselines are not recorded** (TD-09) — twenty captures, one canonical run.
* **Client-side destination management** (TD-11) — needs client TOTP enrolment first.
* **BUY direction in the client UI** is present (the direction toggle, wallet destinations, the request command
  accepts it), but no end-to-end run drives a BUY trade from the client side; the operator specs cover BUY
  settlement.

---

## 8. Files

**New packages.** `packages/portal` (access, destinations, exchange, trade, history), `packages/notifications`
(inbox, handler, email, signals, messages).

**New client product.** `apps/web/src/app/(client)/` — layout, nav, sign-out, exchange, trade, history,
accounts, notifications. `apps/web/src/app/q/[token]/` — the public link page.
`apps/web/src/app/sign-in/ClientSignInForm.tsx`.

**New server wiring.** `apps/web/src/server/client.ts` (client context and command runner),
`apps/web/src/server/quotes.ts` (custody and field protection for the web),
`apps/web/src/server/client-otp.ts`, `apps/web/src/server/link.ts`,
`apps/web/src/server/actions/client.ts`, `apps/web/src/server/actions/link.ts`.

**Changed.** `surface.ts` (client sign-in gate, public host tightened, port-aware host matching), `proxy.ts`,
`runtime.ts`, `harness/desk-server.ts` (three surfaces), `packages/adapters` (custody and notification ports),
`apps/worker/src/main.ts`, `eslint.config.js`, `scripts/check-versions.ts`.

**New tests.** `packages/portal/test/leakage.int.test.ts`, `packages/notifications/test/email.int.test.ts`,
`apps/web/e2e/client.spec.ts`, `apps/web/visual/client-pages.spec.ts`, `apps/web/visual/link-pages.spec.ts`,
`apps/web/lighthouse/run.ts`.
