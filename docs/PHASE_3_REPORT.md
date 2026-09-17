# INRP2P Exchange — Phase 3 Report (Requests & Quotes)

Status: implemented, awaiting review. Phase 4 not started.
Base: `b2f456b` (Phase 2 accepted with review corrections). Scope: `IMPLEMENTATION_PLAN.md` Phase 3 only — trade requests, quotes, shareable links, acceptance challenges, acceptance/rejection, trade opening with frozen economics, route obligation, deposit assignment and accept journal, expiry jobs, client projections. No trade lifecycle beyond `AWAITING_FIRST_LEG`, no settlement legs, no TRON scanning, no UI screens.

## 1. D-02 gate — still **OPEN**, and Phase 3 respects it

No custody provider is confirmed, so `getDepositAddressCapability('TRON')` is `UNSUPPORTED` unless an operator records one. SELL acceptance calls `assertSellAcceptanceSupported` before anything is written: with the gate open, accepting a SELL quote fails with `CUSTODY_CAPABILITY_UNSUPPORTED`, the quote stays `SENT` and no trade exists (exit test in `acceptance.int.test.ts`). No provider adapter and no attribution fallback were introduced. BUY acceptance is unaffected — the client receives USDT and sends nothing.

## 2. What exists

```
packages/quotes    policy (injected, never from payloads); link tokens and OTP primitives; request create/decline/withdraw/TTL-expiry;
                   quote create/send/counter/cancel; quote links create/revoke/view; acceptance challenges (send, verify, consume);
                   accept/reject in-app and via link; quote expiry command + sweeper; acceptance-code outbox handler; client projections
packages/trades    trade opening from an accepted quote (trade + frozen economics + transition + route obligation + accept journal),
                   client trade view with SELL deposit instructions
packages/adapters  + NotificationAdapter port, UnconfiguredNotificationAdapter; testing: FakeNotificationAdapter
packages/treasury  + reserveTreasuryUsdt / releaseTreasuryReservation (BUY on a TO_EXCHANGE route, FI-33)
packages/db        + migrations 0012–0014, schema types, pinnable business clock and trade stubs for tests
apps/worker        + quote_expire (scheduled at expires_at by the quote.sent handler), quote_expiry_sweep (1 min),
                   acceptance-code delivery handler, field-protection config (unconfigured by default — TD-03/TD-04)
```

## 3. Migrations

| # | File | Contents |
|---|---|---|
| 0012 | business_clock_rate_limits | `inrp2p_now()` — the single business clock for Phase 3+; identical to `statement_timestamp()` in deployed databases and pinnable **only** when the table `inrp2p_test_clock_permit` exists (no migration creates it; the integration-test template does). `rate_limit_counter` (fixed windows, hashed keys, worker-only DELETE) |
| 0013 | requests_quotes | `trade_request` (RQ ref, per-direction destination rule, whitelisted transitions); `quote` (QT ref, FI-02 derived-margin CHECK, FI-05/FI-06 partial unique indexes for one `SENT` and one `ACCEPTED` per request, FI-03 economics-immutable trigger, expiry fixed once at send, FI-07 "a LINK decision always carries a consumed challenge"); `quote_link` (SHA-256 of the token only, telemetry columns); `acceptance_challenge` (salted code hash, ≤5 min and never beyond the quote, 5 attempts, one PENDING per quote+user, insert guard IX044: SENT quote, expiry ≤ quote expiry, link and recipient belong to the quote's client, no delete); `otp_delivery` (sealed code, erase-once, no delete); deferred trigger: a challenge recorded on a quote is CONSUMED for that quote and that decision |
| 0014 | trades | `trade` (IX ref, insert guard requiring an ACCEPTED quote, empty transition whitelist in Phase 3), `trade_transition`, `trade_economics` (insert-once; trigger checks equality with the quote), `route_obligation` (trigger checks equality with the economics), `treasury_reservation` + wallet reserved ≤ observed guard; FKs from `deposit_assignment.trade_id` and `capacity_reservation.trade_id` to `trade` |

Grants follow the Phase 2 pattern: `inrp2p_app` gets SELECT/INSERT plus column-level UPDATE on lifecycle columns only, no DELETE anywhere; `inrp2p_readonly` cannot read code hashes, salts or sealed codes.

## 4. Commands and permissions

| Command | Authority | Notes |
|---|---|---|
| `request.create` | client user of the client, or operator `request:create` | destination must be ACTIVE and owned by the client; amount within policy |
| `request.decline` | `request:decline` + reason | cancels the live quote (`DECLINED_BY_DESK`) |
| `request.withdraw` | client user of the client, or operator `request:withdraw` (**new matrix row**, §6) | cancels the live quote (`WITHDRAWN`) |
| `quote.create` | `quote:create` | desk supplies amount, side, client rate and validity; INR value, route value and margin are computed from the current snapshot (FI-02); negative margin needs a reason |
| `quote.send` | `quote:send`, plus `quote:send_negative_margin` ⧗ when the margin is negative | refuses a stale snapshot, supersedes the previous SENT quote, fixes `expires_at` from database time, optional link |
| `quote.cancel` | `quote:cancel` | SENT→CANCELLED (`OPERATOR`) or DRAFT→CANCELLED (`DISCARDED`); request returns to OPEN |
| `quote_link.create` / `revoke` | `quote_link:create` / `quote_link:revoke` | link needs ≥120 s of remaining validity; revoke closes pending challenges |
| `quote_link.view` | none (public, rate limited) | view-only; writes link telemetry and an audit event, never the quote |
| `quote_link.request_otp` | none (public, rate limited) | recipient chosen from masked authorized acceptors; code goes only to that user's verified email |
| `quote.accept` / `quote.reject` | authenticated client user with `can_accept_quotes` (D-01, D-15) | in-app; a client session never bypasses the link OTP — that is a different command |
| `quote.accept_via_link` / `quote.reject_via_link` | a consumed acceptance challenge | rate limit per token → verify in its own committed transaction → command re-verifies under the locks and consumes |
| `quote.expire`, `request.expire_inactive` | SYSTEM (worker) | idempotent; act only when database time has passed the deadline |

Audit: `request.created/declined/withdrawn/expired`, `quote.created/sent/cancelled/accepted/rejected/expired/acceptance_failed`, `quote_link.created/opened/revoked`, `acceptance_otp.sent/failed/verified/superseded/expired`, `trade.opened`, `treasury.reserved`, `deposit_address.assigned`. `quote_link.local_decline` is deliberately absent: the page's "Decline" is a local dismissal with no server call.

## 5. Security properties held in this phase

- **Token.** 128-bit CSPRNG, base62, 22 characters; only its SHA-256 is stored. Every candidate — well-formed or not, `null` or an object — is hashed the same way before the lookup, and the stored digest is compared with `timingSafeEqual`, so the response does not depend on how close a guess was. Unknown, malformed and revoked tokens answer identically (`LINK_NOT_FOUND`). Opens are limited to 30/min per IP.
- **Codes.** 6 digits CSPRNG, stored as a salted keyed hash, valid ≤5 minutes and never beyond the quote's `expires_at`, 5 attempts, 3 sends per quote per 10 minutes, 10 sends/hour per IP, 5 decisions/min per token. A new send supersedes the previous challenge. Every OTP failure returns the same sentence ("The code is invalid or has expired."); only the remaining-attempts hint differs. Wrong attempts are counted in a **committed** transaction, so a rolled-back decision cannot reset the counter.
- **Code handling.** The plaintext code exists in the process that generates it and in the sealed `otp_delivery` row, bound to the challenge by AAD. It is erased on delivery and whenever the challenge closes; it never enters the outbox payload, the audit trail, the idempotency store or any log. The database refuses to restore an erased code or replace an existing one. Link tokens are handed to an `onToken` callback so they never reach the command result the idempotency store keeps.
- **Client projections.** `ClientQuoteView` and `ClientTradeView` are the only shapes a client API or the link page may serialize; `assertClientSafe` walks the value and rejects any key matching route, margin, snapshot, provider, custody, dealer, obligation, execution, reference rate, operator, creator, hash, salt or sealed (unit and integration tests).
- **Time.** Every deadline is judged by `inrp2p_now()` inside the transaction, never by an app-server or browser clock. Expiry jobs are a convenience: acceptance re-checks the expiry under the row locks.

## 6. Interpretations and deviations for review

1. **`request:withdraw` is a new permission row** in SECURITY §3 (OWNER ✔, DEALER ✔, others —). The client-side path is authorized by membership; the operator-on-behalf path needed a permission, and reusing `request:decline` would have conflated two different outcomes. No existing permission changed.
2. **Default validity.** A quote created without `validitySeconds` takes the shareable-link default of 180 s (D-01 rev 3). Explicit values stay bounded to 30–1800 s, and a link still needs ≥120 s.
3. **Policy values that DECISIONS does not fix** (maximum request size 5,000,000 USDT / 500,000,000.00 INR, 24 h request TTL, 900 s maximum snapshot age, KYC not required for acceptance) are defaults in `DEFAULT_QUOTE_POLICY`, injected per deployment and never read from a payload. `requireKycVerified` is **off** until counsel defines the policy (D-07); switching it on is one policy value.
4. **Replaying a code on a decided quote** answers `QUOTE_NOT_SENT` rather than `QUOTE_ALREADY_ACCEPTED` on the link path, so an unauthenticated holder learns no more than the view already shows. The in-app path, which is authenticated, still answers `QUOTE_ALREADY_ACCEPTED`.
5. **Trade transitions are not enabled yet.** Migration 0014 gives `trade` an empty transition whitelist: Phase 3 opens trades in `AWAITING_FIRST_LEG` and nothing can move them until Phase 4 adds the whitelist with its state machine.
6. **Treasury reservation** is made at acceptance only for BUY on a `TO_EXCHANGE` route (FI-33); over-commitment is refused with `TREASURY_INSUFFICIENT`. Release paths exist but are exercised by Phase 4.
7. **No email provider is bound** (TD-04): the worker wires `UnconfiguredNotificationAdapter`, so a queued code fails delivery loudly rather than being logged. The worker's field protection is also unconfigured by default (TD-03), so opening a sealed code needs keys the deployment supplies.

## 7. Exit criteria

| Exit test (IMPLEMENTATION_PLAN Phase 3) | Where | Result |
|---|---|---|
| Opening a link never changes state | `requests-quotes.int.test.ts` "the view never mutates the quote" (full row compared before/after) | pass |
| Unauthenticated "Decline" makes no server mutation; the quote stays SENT | `acceptance.int.test.ts` "a link holder cannot accept or reject without a code" (+ no `local_decline` audit action exists) | pass |
| Link rejection without OTP impossible | same test (`rejectQuoteViaLink` without a code) | pass |
| Link acceptance without OTP impossible | same test (`acceptQuoteViaLink` without a code) | pass |
| Link quote with validity < 120 s rejected; default 180 s | `requests-quotes.int.test.ts` "validity bounds hold…" | pass |
| OTP expiry never exceeds quote expiry | `acceptance.int.test.ts` "a code never outlives the quote" (+ DB guard IX044) | pass |
| Wrong / expired / superseded / reused OTP rejected | `acceptance.int.test.ts` attempts, supersede and reuse tests | pass |
| OTP valid but quote expired rejected | `acceptance.int.test.ts` "a valid code cannot accept an expired quote" (pinned clock) | pass |
| Attempts and send limits enforced | attempts test (5 attempts → FAILED) and "sends are limited per quote and per IP" | pass |
| Accept at T−1 ms succeeds, at T+1 ms fails | `acceptance.int.test.ts` "acceptance at T−1 ms succeeds and at T+1 ms fails" (pinned business clock) | pass |
| Same quote accepted twice | "a quote can be accepted once" | pass |
| Two clients accepting concurrently | same test: two parallel `quote.accept` commands → exactly one succeeds, one trade | pass |
| Superseded quote cannot be accepted | "a superseded, cancelled or rejected quote can never be accepted" | pass |
| Rate change after acceptance doesn't change the trade | "a rate change after acceptance never changes an open trade" | pass |
| Client JSON never contains route/margin/provider keys | `security.unit.test.ts` + `assertClientSafe` on every client view returned in the integration tests | pass |
| Link token lookup constant time and rate limited | `security.unit.test.ts` (uniform hashing, `timingSafeEqual`) + "lookup is by token hash only" and "link opens are rate limited per IP" | pass |
| SELL acceptance disabled when custody capability is `UNSUPPORTED` | "SELL acceptance is refused while the custody deposit-address capability is UNSUPPORTED" | pass |

## 8. Gates run locally

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | lockfile up to date, supply-chain policies pass |
| `pnpm workspace:graph` | acyclic, 19 packages |
| `pnpm versions:check` | version matrix OK; PostgreSQL 18.6 enforced by CI |
| `pnpm secret-scan` | 489 files clean |
| `pnpm lint` | clean (new packages added to the ARCHITECTURE §3 boundary map and to the no-float-money rule set) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | 197 tests, 11 files |
| `pnpm test:integration` | 455 tests, 15 files (PostgreSQL 18.4 locally; CI runs 18.6) |
| `pnpm --filter @inrp2p/web build` | succeeds |

Component visual/accessibility tests are unchanged and run in CI's canonical container (`docs/VISUAL_BASELINES.md`).

## 9. Open items carried forward

- **D-02** remains open; SELL acceptance stays disabled until a provider capability is recorded.
- **TD-03** (KMS-backed KEK) and the new **TD-04** (no email provider for acceptance codes) both block enabling link acceptance in a deployed environment.
- Phase 4 owns: trade transitions, settlement legs, INR/USDT movements, exceptions (including the `capacity.over_committed` signal), consuming capacity and treasury reservations, and the client-facing trade timeline.
