# INRP2P Exchange — Production hardening register

Working register for the production task of 2026-10-04 (source `main` at `d0cc778`). Branch
`claude/production-hardening`. Every item states what was found, what changed, how it is proved and what is still
outside the repository. A result is recorded only with the command, SHA and environment that produced it;
`NOT RUN` and `BLOCKED` stay visible until a real run replaces them.

## Readiness, kept apart

| Gate | Meaning | Status |
|---|---|---|
| 1. Code ready | fixes implemented, regressions covered, required checks green on the final SHA | in progress |
| 2. Staging verified | production-like environment, real adapters, notifications, both directions, recovery, monitoring, operator procedures | **NOT RUN** — no staging environment or provider credentials exist in this workspace |
| 3. Production prepared | domains, secrets, custody, bank accounts, liquidity, staff access, monitoring, backups; external conditions closed by their owners | **BLOCKED** — owner/infrastructure inputs (§ External prerequisites) |

Fake-provider tests never close gate 2; CI never closes gate 3.

## Runs (gate 1 evidence)

Local runs on a developer Mac (macOS 15 / Darwin 24.6, Node 24.21.0, pnpm 12.4.2, Docker 29.8, PostgreSQL
`postgres:18.6` via Testcontainers). They are code-level evidence only — fake chain and custody adapters — and close
nothing on gates 2 or 3. CI on the final SHA replaces them in the final report.

| Date | SHA | Command | Result |
|---|---|---|---|
| 2026-10-05 | `c861005` | `pnpm typecheck` · `pnpm lint` · `pnpm secret-scan` | PASS · PASS · PASS (985 files) |
| 2026-10-05 | `c861005` | `pnpm test:unit` | PASS — 30 files, 1537 tests |
| 2026-10-05 | `c861005` | `pnpm test:integration` | PASS — 39 files, 760 tests; 1 skipped: `apps/web/test/proxy.int.test.ts` runs only against a `next build` or in CI |
| 2026-10-05 | `0250273` | `pnpm typecheck` · `pnpm lint` · `pnpm secret-scan` | PASS · PASS · PASS (998 files) |
| 2026-10-05 | `0250273` | `pnpm test:unit` | PASS — 31 files, 1549 tests |
| 2026-10-05 | `0250273` | `pnpm test:integration` | PASS — 41 files, 792 tests; 1 skipped (the built-app proxy test, as above) |
| 2026-10-05 | `ef24e4a` | `pnpm typecheck` · `pnpm lint` · `pnpm secret-scan` | PASS · PASS · PASS (1010 files) |
| 2026-10-05 | `ef24e4a` | `pnpm test:unit` | PASS — 32 files, 1557 tests |
| 2026-10-05 | `ef24e4a` | `pnpm test:integration` | PASS — 45 files, 830 tests; 1 skipped (the built-app proxy test, as above) |

## Items

| ID | Pri | Kind | Title | Status |
|---|---|---|---|---|
| ADR-16 | P0 | owner decision | Counterparty-funded execution (`docs/adr/0016-…`) | recorded |
| A1 | P0 | confirmed defect | TRON receipt/history normalization | fixed — code ready |
| A2 | P0 | confirmed defect | History pagination and cursor safety | fixed — code ready |
| A3 | P0 | confirmed defect + external | Provider degradation, D-05 quorum, backfill (TD-06), real smoke (TD-07) | code ready; real smoke **NOT RUN** |
| B1 | P0 | owner decision → implementation | Counterparty-funded execution enforced in commands and the database | code ready |
| B2 | P0 | confirmed defect + implementation | Observed custody balances and the physical-availability gate | code ready; real-provider reads **NOT RUN** (TD-07) |
| B3 | P0 | proof | Counterparty funding proved at command, database and screen level | code ready |
| B4 | P1 | owner decision | No direct trader → client path | enforced (not offered) |
| B5 | P0 | confirmed defect | Desk screens and evidence paths still paid from the treasury and assumed log 0 | fixed — code ready |
| C1 | P0 | confirmed defect | Second person for payouts above ₹2,500,000 | fixed — code ready |
| C2 | P0 | confirmed defect | OWNER request/approve (TD-20), protected bootstrap/recovery, replay re-authorization | fixed — code ready |
| C3 | P0 | confirmed defects + external | Auth: TD-01, TD-02, TD-11 (client TOTP), operator enrolment; TD-03 KMS-backed KEK | code ready; KMS key **BLOCKED** (owner) |
| D1 | P0 | confirmed defect | TD-18: an open trade can follow a client's new destination (two people, step-up, append-only) | fixed — code ready |
| D2 | P0 | confirmed defect | TD-19: an overpayment can be returned without unwinding the trade | fixed — code ready |
| D3 | P0 | implementation + owner decision | TD-21: a trader's reserve applied to USDT its own order did not deliver; held against INR | USDT side and INR hold code ready; INR conversion / recovery terms **BLOCKED** (owner) |
| D4 | P0 | confirmed defects + proof | Trader lifecycle end to end; sweep error isolation; rewards never paid from principal | fixed — code ready |
| E1 | P0 | confirmed defects + integration | TD-04: email provider for codes and notifications; no fictitious delivery success | code ready; staging inbox **NOT RUN**; provider account **BLOCKED** (owner) |
| E2 | P1 | verification + implementation | Statement import verified; TD-12 receipts in private, versioned, write-once object storage | code ready; bucket and retention **BLOCKED** (owner) |

(The table grows as stages are worked; each row has a section below.)

## ADR-16 — Counterparty-funded execution

- **Requirement.** Owner decision 2026-10-04: trades are executed entirely with trader (counterparty) liquidity and
  the client's own funds; the platform never advances its own USDT/INR.
- **Recorded.** `docs/adr/0016-counterparty-funded-execution.md` (before/after flows, journals, invariants FI-70…79,
  migration and mixed-version rollout), `docs/DECISIONS.md D-16`.

## A1 — TRON receipt and history normalization (P0, confirmed defect)

- **Found (reproduced on `d0cc778`).** Regressions against the documented wire formats
  (developers.tron.network: event, gettransactioninfobyid, TRC20 history), served over HTTP by an in-memory
  TronGrid-compatible node (`packages/adapters/src/testing/fake-trongrid.ts`), failed on the unmodified adapter:
  1. a standard receipt — `log.address` is 20-byte hex without `41` — threw `INVALID_ADDRESS` ("provider returned an
     invalid log contract"): no USDT transfer could ever be confirmed through a real node;
  2. the account history, which has no `block`/`block_number`, threw "provider returned an unusable block number":
     the scanner could not read any address;
  3. a transaction with the watched transfer at log 2 was reported as log 0 (`event_index ?? 0`);
  4. a receipt without `receipt.result` was read as `FAILED` (it reverts a client's leg).
- **Changed.** `packages/kernel/src/tron.ts` `normalizeTronAddress` (base58check, 21-byte `41…` hex, 20-byte log hex;
  anything else refused). `packages/adapters/src/tron.ts`: `parseTransactionInfo` decodes the receipt (id must match,
  block/time required, `receipt.result` required, each log classified TRANSFER / OTHER / MALFORMED; TRC721 Transfer
  stepped over; ABI-padded topics checked; one 32-byte value; >2⁶³ refused); the block number, result and log
  position come from the receipt, never the history; a transaction's every Transfer into the address is reported
  (identical transfers in one tx included). `getTransfer` returns `FOUND` / `TX_FAILED` / `NOT_FOUND` and throws on
  missing/foreign logs. Operator read-back (`crypto.submit_tx_for_verification`, `trader_reserve.record_withdrawal_sent`)
  picks the log by its facts, never "log 0", and asks for the index when ambiguous.
- **Tests.** `packages/adapters/test/tron-wire.unit.test.ts` (A1 block, incl. the TRON documentation's own example
  log decoding to TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t / 3,000,000,000), `packages/kernel/test/tron.unit.test.ts`.

## A2 — Complete window reads and a safe cursor (P0, confirmed defect)

- **Found (reproduced on `d0cc778`).** 200 old transfers + 1 new: one HTTP request
  (`only_to=true&limit=200&order_by=block_timestamp,asc`, no time bounds), 0 transfers found, and the scanner judged
  completeness on the filtered array — so the cursor could pass the new transfer's block for good.
- **Changed.** `TronProvider.readIncomingTransfers` → `TransferWindow { transfers, complete, completeThrough,
  incompleteReason, pages, requests }`. The window's edges become timestamps (`getblockbynum`, ±1 ms, which can never
  reach a neighbouring 3 s block), every page is followed (fingerprint; a full page without one continues by the last
  timestamp), receipts are fetched with bounded concurrency, retry with backoff on transient failures only, per-request
  timeout and an overall budget. Anything unproven — failed page, repeated token, page limit, budget, receipt
  unavailable or contradicting the index, malformed log — leaves `complete=false` and `completeThrough` at the last block
  wholly proven. `runTronScan` advances the cursor to the minimum proof over all watched addresses (never backwards,
  row locked, IX066), records the window, completeness, reason and serving provider on the cursor (migration 0024), keeps
  already-recorded transfers out of the per-run budget, and dedupes on `(tx, log)`.
- **Tests.** `tron-wire.unit.test.ts` (A2 block: 0/1/199/200/201/450 events, 200 old + 1 new, missed slot, many events
  sharing a timestamp across a page boundary, second page failing, transient retry, receipt withheld, receipt
  contradicting the index, repeated token, page limit, time budget, edges unavailable, reverted tx, out-of-window rows);
  `packages/scanner/test/hardening.int.test.ts` (scanner over HTTP: 200 old + 1 new detected and attributed; a page
  failing mid-window stops the cursor at the proof and the next run completes with no duplicate rows; incomplete reads
  from every provider; listing down; two concurrent scans → one row per transfer, one leg per trade).

## A3 — Degradation, D-05 quorum, backfill (TD-06), real smoke (TD-07) (P0)

- **Found.** The scanner read through the primary only; the verifier called providers one after another and turned
  "the primary does not know it" into `null` — which the orphan sweep read as "orphaned" (a single lagging provider
  could strip a client's deposit). A second provider reporting different facts was quietly ignored below the threshold.
- **Changed.** `QuorumChainVerifier` (replaces `DualProviderChainVerifier`): every provider asked in parallel with its own
  timeout; answers `FOUND` (facts + `agreedBy`/`agreedGroups` of providers that report the same facts **and** call the
  block final by their own solidified head + `unavailable` + `degraded`), `TX_FAILED`, `NOT_FOUND` (with who said so),
  `CONFLICT` (never resolved by majority), `UNAVAILABLE`. Settlement maps them: D-05 quorum ≥ 10,000 USDT unchanged
  (two independence groups), a failure needs the same quorum as a confirmation, conflict/unavailable wait and open the
  desk case (conflict at once). Degraded confirmations are marked in the audit event. The orphan sweep acts only when
  every configured provider answered and none knows the transaction. The scanner fails over across providers for
  detection; `chain_provider_status` records each provider's last success/failure/heads (migration 0024); the USDT
  screen shows provider health, an incomplete-window notice and backfills; new health checks `scanner_block_lag`,
  `chain_providers_degraded`, `chain_quorum_waiting` with runbooks (`provider-outage` rewritten to the real behaviour,
  `chain-quorum-failure`, `chain-backfill`). TD-06 closed (see TECH_DEBT). Smoke gate extended (window read, JSON report).
- **Tests.** `packages/adapters/test/tron.unit.test.ts` (conflict, unavailable/degraded, NOT_FOUND attribution,
  finality per provider, TX_FAILED, same-group mirrors), `hardening.int.test.ts` (failover + provider status; orphan
  refused while a provider is unavailable, done when all answer; backfill lifecycle and refusals),
  `scripts/test/tron-smoke.unit.test.ts` (dry run pass/fail, no key in the report).
- **Real smoke — NOT RUN.** Needs two genuinely independent TRON endpoints (different independence groups), API keys
  in the `tron-smoke` workflow environment secrets, and a known reference transfer with its expected sender,
  destination, amount and log index. Command: `pnpm run smoke:tron` with `INRP2P_SMOKE_*` (see `scripts/tron-smoke.ts`)
  or the manual `tron-smoke` workflow; add `INRP2P_SMOKE_REPORT_FILE` to keep the report. Owner: whoever holds the
  provider accounts. TD-07 stays open until a PASS report is recorded here.

## B1 — Counterparty-funded execution, enforced (P0)

- **Found (on `d0cc778`).** Acceptance of a BUY trade on a `TO_EXCHANGE` route reserved the platform's own treasury
  USDT (`reserveTreasuryUsdt`) and the client was paid from the HOT wallet before the counterparty delivered anything;
  an INR payout on a SELL trade drew on the exchange account's capacity whether or not the route's INR had arrived.
  In both directions the platform's money advanced execution — what D-16 forbids.
- **Changed.** Migration `0025_counterparty_funding.sql`: `trade_funding` (insert-once; existing trades backfilled
  `LEGACY_EXCHANGE_FUNDED`, every new trade `COUNTERPARTY_FUNDED` by trigger, IX082), `funding_source` (a view: confirmed
  client legs = client funds, confirmed `FROM_ROUTE_TO_EXCHANGE` settlements = counterparty funds, each at its location
  `INR:{account}` / `TRON:{address}`), `funding_allocation` earmarks (ACTIVE → CONSUMED | RELEASED) with deferred
  source-total (IX085) and coverage (IX086) checks, IX083 (no treasury reservation for a funded trade), IX084 (source
  shape/wallet), IX087 (DVP before `TO_ROUTE`), IX088 (an address holding earmarked money never returns to the pool).
  Commands: `createPayoutLeg` allocates counterparty funds at the paying location, `recordRouteSettlementInTx`
  (`TO_ROUTE`) allocates client funds after asserting delivery under the trade lock, `createRefundLeg` allocates client
  funds; confirm consumes, cancel/fail release. Acceptance no longer reserves; trader collection accounts must be ACTIVE
  and `BOTH` (pass-through needs payouts from where the trader's INR lands).
- **Tests.** `test/integration/counterparty-funding.int.test.ts` (both directions at zero platform USDT/INR; nothing
  stands in for the counterparty; partial and missing delivery; concurrency), the settlement, audit-regression, direct
  payout, properties (FI-71/72/75), statements, desk, quotes and traders suites ported to real-command delivery.
- **Rollout.** Mixed versions fail closed (ADR 0016 §7): an old instance's acceptance is refused by IX083, its
  uncovered outflows by IX086.

## B2 — Observed custody balances and the physical-availability gate (P0)

- **Found (on `d0cc778`).** Nothing in production ever wrote what a treasury wallet holds: `observed_balance_minor`
  stayed 0 and `observed_at` null outside fixtures, and a payout only lowered `reserved`, so USDT already sent could
  look available again. No USDT payout or refund checked the chain balance of the address it left. The cooldown job
  would have failed on every run once one deposit address held earmarked money (IX088 aborting its transaction).
- **Changed.** Migration `0026_custody_observation.sql`: `custody_balance_observation` (append-only; `AGREED` = two
  independence groups report the same balance, `SINGLE_SOURCE`, `DISAGREED`, `ERROR`; usable ⇔ balance and block), IX089
  (a wallet's observed balance is only ever its latest recorded reading — nothing writes a number by hand), and
  `inrp2p_address_earmarked` now counts a planned outflow as still there. `readBalance` asks every provider in parallel
  and never averages or majority-votes; worker cron `custody_observe` reads every live treasury wallet and every address
  holding a trade's money each minute; the desk's **Refresh** (`custody:refresh_balance`: OWNER, SETTLEMENT_OPERATOR,
  FINANCE) checks the permission before any provider is called and again inside the recording command, with the
  reading taken by the server (the request names only the address). `payout_leg.send` and `refund_leg.create` (USDT)
  require a usable reading under 300 s (one source only below the D-05 threshold) showing the amount free after every
  outflow that reading does not reflect (`CUSTODY_OBSERVATION_STALE` / `CUSTODY_BALANCE_INSUFFICIENT`). USDT screen:
  custody positions (chain shows, leaving, free on chain, trades' money, planned out, not seen on chain) with refresh;
  health check `custody_outflows_unobserved` → runbook `custody-observation-stale`. The cooldown job passes over
  earmarked addresses. e2e and visual fixture worlds no longer write a treasury balance; their routes deliver first.
- **Defects found by the new tests and fixed before commit.** A planned outflow with no transfer yet was not
  subtracted (SQL `NULL` in the filter); the guard accepted any earlier reading, not only the latest; the earmark
  function treated a planned outflow as gone.
- **Tests.** `packages/settlement/test/availability.int.test.ts` (no / contradicted / failed / 301 s-old reading; single
  source either side of 10,000 USDT; an outflow subtracted until a reading covers it and never twice; a reading before
  the delivery; USDT moved out outside the platform; IX089 and append-only; the cooldown job with an earmarked address),
  `packages/scanner/test/custody.int.test.ts` (worker reading, disagreement, single source, addresses chosen, refresh
  permission, foreign address, no provider), `packages/scanner/test/balances.unit.test.ts`, worker job wiring.
- **Remaining.** INR has no physical reading (TD-25); funding cannot follow a custody sweep (TD-26 — a launch-checklist
  custody setting until built); balances from real providers are part of the TD-07 smoke (**NOT RUN**).

## B3 — Proofs (P0)

| Claim | Where it is proved |
|---|---|
| Both directions settle with zero platform USDT and INR | `counterparty-funding.int.test.ts` — client sells USDT (trader Buy USDT) and client buys USDT (trader Sell USDT), each from a world with no treasury balance and no reservation; the HOT wallet has no ledger entry afterwards |
| No payout before the counterparty funded — command | `FUNDING_NOT_CONFIRMED` in the same suite and `settlement.int` (BUY) |
| — database | raw `settlement_leg` insert of an unearmarked exchange payout refused at commit (IX086); raw `TO_ROUTE` insert before delivery refused (IX087); raw treasury reservation refused (IX083, acceptance suite) |
| — screen / API | server actions only call the domain commands (`runCommand`); the payout panel offers only places holding the counterparty's money and says it is waiting otherwise; the client sees "waiting for liquidity" (`portal.int`) |
| Other trades' money and Security Reserves never stand in | same suite — another trade's delivery at the same account cannot be used (FUNDING_LOCATION/INSUFFICIENT; raw earmark IX084) |
| Capacity is not money | the trader's held capacity funds nothing; a payout account with capacity and other money still refuses (`FUNDING_NOT_CONFIRMED`) |
| Trader default / partial | partial delivery funds a partial payout only; nothing delivered → the client's own funds are refunded from where they are and the trade unwinds |
| Concurrency | two payouts racing for one delivery: one earmark; refund vs payment to the trader racing for the client's money: never both |
| Physical cover (B2) | `availability.int.test.ts` |
| Desk projection does not leak the route rate | `desk.int` — a SETTLEMENT_OPERATOR sees counterparty funds capped at what the client is owed, no arrival figures |

## B4 — No direct trader → client path

Not offered. A trader route is created `TO_EXCHANGE` only and the database holds that shape
(`liquidity_route_trader_shape`, 0022); the routes command refuses to reconfigure a trader route
(`TRADER_ROUTE_MANAGED`). Proved in `counterparty-funding.int.test.ts` (command and raw update). Whether a direct path
is wanted stays an open owner question (ADR 0016 §8).

## B5 — Desk screens and evidence paths (P0, confirmed defect)

- **Found.** After the D-16 commands landed, three desk screens still offered only treasury sources — the payout panel
  (USDT from a treasury wallet), the refund panel (USDT from a treasury wallet), the trader desk (USDT to a trader from
  a treasury wallet) — every one of which the commands now refuse, so the desk could not settle a counterparty-funded
  trade. The same screens, and the server behind them, recorded a USDT transaction as **log 0** whenever no index
  was given (`payout_leg.record_evidence`, `refund_leg.confirm`, `route_settlement.record`); a batch whose payment is
  not the first log could not be recorded. A USDT refund went to "the first active source wallet" in no defined order.
- **Changed.** `locateTransferLog` (settlement) reads the transaction and picks the one log with the configured
  contract, the sender, an expected recipient and the amount — refusing none or several with what the chain shows;
  a named index is held to the same facts. The refund destination is whichever of the client's registered source
  wallets the transaction paid. The desk trade read model gains `funding` (places, what is free, whether the
  counterparty delivered — arrival figures only with `route_positions:view`); the payout, refund and trader screens
  offer only the places holding the right party's money and pass the deposit address when the money is there; the
  client portal shows "waiting for liquidity". The e2e and visual worlds deliver the counterparty's side first.
- **Tests.** `audit-regressions.int` (a stranger's transaction refused at record time; a batch with the payment at
  log 1 found by its facts; the same payment twice requires the index), `desk.int` (funding projection and its access
  rule), `portal.int` (waiting for liquidity, then preparing the payment).

## C1 — Second person for a large payout (P0, confirmed defect)

- **Found (on `d0cc778`).** SECURITY §4 sets ₹2,500,000 per leg above which the person who sent a payout does not
  confirm it; nothing recorded who sent a leg, nothing checked it — `direct-payout.int.test.ts` confirmed ₹10,200,000
  with the operator who had sent it.
- **Changed.** Migration `0027_approvals.sql`: `settlement_leg.sent_by` / `confirmed_by` (written from the command's
  verified actor; set once; legs already in flight keep NULL — no sender is invented), `payout_approval_policy`
  (append-only; default enabled at ₹2,500,000; the latest row is in force), `inrp2p_payout_needs_second_person` (an INR
  leg's amount; a USDT leg at the trade's frozen client rate, exact) and the guard IX090: above the threshold the
  confirmer is a person, not `SYSTEM`, and not the sender — or, for a leg with no recorded sender, not its creator.
  `payout_leg.confirm` refuses the same with `SECOND_APPROVER_REQUIRED` before anything is written.
  `settings.payout_approval` (`settings:payout_approval`, OWNER ⧗, reason, audited) moves or switches the threshold —
  the explicit single-person-desk setting SECURITY §4 describes. The payout panel names the sender and does not offer
  the sender a Confirm above the threshold; the e2e demo has the settlement operator confirm on their own desk.
  Automatic chain confirmation does not change this: the scanner verifies a payout's transaction but never confirms the
  leg — a person does.
- **Tests.** `packages/settlement/test/approvals.int.test.ts` (₹2,499,999.99 / ₹2,500,000.00 / ₹2,500,000.01; the
  sender refused; another operator with a stale step-up or without the permission refused; another settlement operator
  confirms and the record names both; an idempotent retry returns the same result and posts nothing; two confirmers at
  once → one; a USDT leg either side of the threshold at its client rate; IX090 for raw updates — same person, `SYSTEM`,
  no confirmer, changing the sender, sending without a sender; a legacy leg without a sender; the policy switch),
  `direct-payout.int.test.ts` (confirmed by a second operator).

## C2 — OWNER grants (TD-20), protected bootstrap/recovery, replay (P0, confirmed defect)

- **Found (on `d0cc778`).** `assignOperatorRole` accepted any other active OWNER's id as `approverUserId` — that OWNER
  never acted. Nothing could create the first OWNER in production (only test fixtures did), and no procedure existed to
  end an operator's access (the account-takeover runbook asked for it). `executeCommand` returned a stored result for a
  replayed key before `authorize`, so a person whose role was withdrawn, whose step-up had lapsed, or whose account was
  disabled got the result back; the request identity did not include the surface; and command authorization never
  checked that the account was active or the session still open.
- **Changed.** `identity.request_owner` / `approve_owner` / `reject_owner` / `cancel_owner_request` (OWNER ⧗; the
  approver is the approving session's operator, a different active OWNER from the requester and the grantee; the grant
  happens in the approving transaction). `assignOperatorRole`: no self-grant, `approverUserId` refused, OWNER only in
  single-OWNER mode (audited as such). Migration 0027: `operator_role_request` and IX091 — the application role can
  never create the first OWNER, never grant OWNER past one OWNER without an approval made in the same transaction, never
  remove an OWNER. `scripts/operator-admin.ts` `bootstrap-owner` / `disable-operator` (infrastructure credential, secrets
  from the environment, dry run without `--yes`, audited with host and OS user; the last OWNER only with
  `--allow-last-owner`) — RUNBOOKS `operator-access`. The pipeline re-runs `authorize` before returning a stored result;
  the request hash includes the surface; `authorizeOperator` checks the account is ACTIVE and the session open.
- **Tests.** `packages/identity/test/rbac.int.test.ts` (request/approve in two sessions; requester, non-OWNER and stale
  step-up cannot approve; used once; decline and withdrawal; IX091 for raw inserts/deletes; the first OWNER and
  single-OWNER mode on a fresh database), `test/integration/operator-admin.int.test.ts` (bootstrap, second bootstrap
  refused, recovery), `test/integration/pipeline.int.test.ts` (replay after step-up lapse → `STEP_UP_REQUIRED`, after the
  role is withdrawn → `FORBIDDEN`, after sign-out → `UNAUTHENTICATED`, disabled account → `FORBIDDEN`, another operator
  or the client surface with the key → `IDEMPOTENCY_KEY_REUSED`).
- **Rollout.** The request hash now includes the surface: an intent started before the deploy and retried after it is
  refused as `IDEMPOTENCY_KEY_REUSED` instead of replayed; the domain state guards stop a duplicate, and the desk asks
  the operator to reload. Run `bootstrap-owner` once per environment before the first sign-in.

## C3 — Auth, MFA and keys (P0)

- **TD-01 (confirmed, fixed).** Better Auth's planner warned about `auth_rate_limit.last_request` ("expected number but
  got int8") although Better Auth itself declares it `bigint`: its comparator lists `bigint` but not the introspected
  name `int8`. Patched there (`patches/better-auth@1.7.5.patch`: `int8`, `int2`, `float4`, `float8` added); the schema
  and the applied migration are unchanged and nothing is silenced — the auth test asserts the planner hears nothing.
- **TD-02 (confirmed, fixed).** An operator address on the client OTP sign-in returned **500** with no body, and the
  client surface had emailed it a code. A client-surface before hook refuses non-client addresses with exactly the
  unknown-address / wrong-code answers, sends nothing, creates no session or cookie, and audits once. Found with it: the
  audit redactor masks the key `code`, so every `session.failed` had recorded `[REDACTED]` instead of the error — the
  reason is now stored under `error`.
- **TD-11 (fixed).** Client TOTP: enrolment (fresh sign-in only, confirmed by a code, recovery codes once), step-up
  recorded on the rotated session, no self-removal / secret re-display / recovery codes without a step-up / trusted
  devices on the client surface, desk reset `client_user.reset_mfa` (OWNER/SUPPORT ⧗, ends sessions), and the client
  administrator's destination and quote-authority controls behind the step-up dialog.
- **Operator enrolment (confirmed defect, fixed).** No screen let an operator without an authenticator set one up — a
  bootstrapped OWNER could never get in. The desk sign-in now takes them through it after the password; the desk still
  opens only after a verified code.
- **TD-03 (code ready; production BLOCKED).** AWS KMS key-encryption key with SigV4 (checked against AWS's published
  examples), encryption context, ARN-only keys, role credentials, retries for transient failures and fail-closed
  otherwise, rotation through previous key ids, and a production configuration check refusing local or test keys.
  Hosting is not chosen; the KMS key, its account and the roles are owner inputs (RUNBOOKS `field-encryption-keys`).
  A different cloud needs its own adapter behind the same port.
- **Tests.** `packages/identity/test/auth.int.test.ts` (planner silent; epoch-ms round trip; cross-surface refusals;
  client enrolment, rotation, refusals, stale session), `packages/clients/test/clients.int.test.ts` (desk reset),
  `packages/adapters/test/aws-kms.unit.test.ts` (signer vectors, wrap/unwrap, context and key binding, retry vs refusal
  vs outage, credentials, production refusals, rotation).

## D1 — A changed destination for an open trade (TD-18) (P0, confirmed defect)

- **Found (on `d0cc778`).** A trade's destination was frozen in `trade_economics`; when the client archived it, the
  `CLIENT_BANK_CHANGED` case could not be resolved by paying a new one — the panel offered `confirm_new_destination`,
  which recorded a resolution and changed nothing, and payouts stayed refused. The only exit was refund and cancel.
- **Changed.** Migration `0028_destination_change_and_excess_refund.sql`: `trade_destination_change` (append-only;
  reason and the client's confirmation required; one open request per trade; decided by someone other than the
  requester — CHECK), `inrp2p_trade_payout_destination` (latest approved change, else as accepted) and IX092 — the new
  destination is the same client's, ACTIVE and of the kind the trade pays; it replaces the destination in force;
  nothing PENDING or PROCESSING at approval; and every payout leg insert goes to the destination in force.
  Commands in `packages/settlement/src/destination-change.ts`: request (OWNER, SETTLEMENT, FINANCE, SUPPORT ⧗),
  approve/decline (OWNER, FINANCE ⧗, not the requester), withdraw (the requester). Approval refuses a payout in
  flight (`PAYOUT_IN_FLIGHT`), cancels payouts only planned to the old destination on the record (capacity and
  earmarks released), resolves the case, notifies the client (`TRADE_DESTINATION_CHANGED`) and advances the trade.
  `confirm_new_destination` is no longer a resolution an operator records directly. Desk: the trade's **Destination**
  panel; client portal: the trade shows the destination in force.
- **Tests.** `packages/settlement/test/destination-change.int.test.ts` (other client's / archived / same destination
  refused; stale step-up; requester, settlement operator and dealer cannot approve; finance approves; economics
  untouched; case resolved; client told; payout goes to the new account and a raw insert to the old one is IX092;
  planned leg cancelled with capacity and earmark released; sent leg blocks until failed; decline and withdraw; raw
  self-approval (CHECK) and same-destination (IX092); the plain resolve refused), `packages/desk/test/desk.int.test.ts`.

## D2 — Returning an overpayment (TD-19) (P0, confirmed defect)

- **Found (on `d0cc778`).** DOMAIN_MODEL listed `refund_excess`; no command implemented it, a refund always returned
  everything, and completion (FI-21, command and trigger) did not net refunds, so a partly refunded trade could never
  complete.
- **Changed.** Migration 0028: `settlement_leg.refund_kind` (`UNWIND` | `EXCESS`; NULL on older legs = unwind), an
  excess leg must name its destination (CHECK), IX093 (deferred: excess planned + in flight + returned ≤ received −
  receivable), and the completion trigger restated: received less excess *confirmed* back = receivable.
  `trade.refund_excess` (`settlement:create_payout`) plans at most the remaining excess to a destination of the
  client named at planning (USDT: an ACTIVE SOURCE/BOTH wallet — never simply the address it came from; INR: an
  ACTIVE bank account), from where the client's money is (earmarked, B2-checked), refused on top of an unwind;
  resolves the overpayment cases when the whole excess is planned back. `refund_leg.confirm` (⧗✱) pays only the named
  destination and posts the ordinary refund journal once; an excess does not trigger the pay-out-or-refund
  exclusivity, and confirming it advances the trade. `advanceTrade` and `payout_leg.confirm` use the same
  predicates. Desk: **Cancel or refund → Return the excess**.
- **Tests.** `packages/settlement/test/excess-refund.int.test.ts` (USDT: amount above the excess refused, receiving-only
  wallet refused, planned → payable, second excess refused, paid in full but open until the excess is back, the raw
  completion refused (IX021), confirmer without `refund:approve` refused, wrong wallet refused, completes with the
  client receivable at zero; IX093 and the destination CHECK on raw inserts; nothing to return on an exact payment;
  excess then unwind of the rest then `refund_and_cancel`; INR from the account it arrived in, earmark consumed).

## D3 — Applying a trader's Security Reserve (TD-21) (P0)

- **Found (on `d0cc778`).** The reserve was credited, locked and withdrawn through the ledger, but nothing could use
  it. Since D-16 an undelivered trader order leaves the client waiting for liquidity (the platform does not advance
  its own money), so the reserve was the trader's guarantee with no way to call on it.
- **Decided here, and not.** Built: the mechanism that needs no owner terms — the trader's own reserve, applied by two
  people to USDT one of its own orders still owes, and, against an INR shortfall, a two-person **hold** that keeps part
  of the reserve from being withdrawn while the INR debt stays open (nothing moves or posts; it ends with its order or
  is released with a reason). Not built: converting a held reserve into an INR recovery (needs the owner's valuation
  terms or a real conversion with evidence — never a bare `Dr USDT / Cr INR`), any other use of a reserve (penalty,
  cost, forfeiture — owner), anything automatic. Whether an order delivered from the reserve keeps its frozen reward is
  listed as an owner question (today it does).
- **Changed.** Migration `0029_trader_reserve_application.sql`: `trader_reserve_application` (append-only status;
  requester ≠ decider CHECK; one live application per order), `inrp2p_trader_reserve_balance` / `_free`,
  `inrp2p_route_delivery_open`, IX094 (own order, Sell USDT, IN_PROGRESS, obligation owes USDT, amount ≤ owed and ≤
  free reserve; under the trader lock at request and approval), `route_settlement.reserve_application_id` and IX095
  (a delivery naming an application only while APPROVED, exact amount, USDT, to the order's own address, from the
  trader's reserve address or a treasury wallet; every other route delivery paid by the route and never from an
  exchange address; application and settlement statuses agree at commit). Ledger purpose `TRADER_RESERVE_APPLIED`.
  Commands `@inrp2p/traders` `reserve-application.ts` (request, approve — issues the delivery address, holds the
  amount, notifies — decline, withdraw, end, record sent from the chain), `@inrp2p/settlement` `reserve-delivery.ts`
  (recording, scanner attribution, confirmation posting once, failure ending it). Reserve figures gain `applying`
  (not withdrawable). Desk: trader page **Reserve applied to orders**; trader: reserve figure and history.
- **Tests.** `test/integration/trader-reserve-application.int.test.ts` (not before the trader's turn; dealer refused;
  over the owed amount; one live application; requester and settlement operator cannot approve; approval issues the
  address and holds the amount, which cannot be withdrawn; wrong amount and a stranger's transfer refused; one journal
  Dr TRADER_RESERVE / Cr ROUTE_RECEIVABLE; reserve 800 → 300 with the shortfall shown; order delivered; client paid
  from the order's address after a B2 observation; trader paid its INR; order completed; obligation and ledger at
  zero; trader notified and its projection private; scanner path from a treasury wallet with the four-line journal;
  a wrong amount opens a case and leaves the application approved; on an INR order: an amount must be named, two
  people, held and not withdrawable, nothing posted, no transfer can be recorded for it, a delivery naming it refused
  (IX095), released with a reason, and a second hold ended by the sweep when the client trade is unwound; reserve
  short refused with the free figure; withdraw/decline/end; IX094 and IX095 on raw inserts, including the exchange's
  own USDT booked as a delivery), `packages/ledger/test/movement.unit.test.ts`.
- **Gate 3.** BLOCKED on the owner: recovery terms for INR shortfalls and other uses (ADR-16 §8), and TD-22 (the
  programme agreement) before any trader provides real money.

## D4 — Trader lifecycle, sweep isolation, rewards from margin (P0, confirmed defects)

- **Found (on `d0cc778`).** `runTraderSweep` said each order was its own step "so one failure never holds up the
  rest", but it awaited the steps in a loop: the first order that threw ended the run, and every later lapsed offer,
  ended hold and settled order waited — with capacity held — until that order stopped failing; nothing reported it.
  Reward payouts could be drawn from any exchange INR account up to the trader's payable, so a reward could be paid
  with a client's INR waiting to pay a trader, or a trader's INR waiting to pay a client (ADR-16 §6 said "realized
  margin only"; nothing enforced it). No single test followed a trader through its whole life.
- **Changed.** The sweep guards each step: a failure rolls back that order's transaction alone, is reported
  (`failures`: step, order, code, message) and logged by the worker, and is retried next run; health signal
  `trader_orders_overdue` (offers, holds and settled orders left ten minutes) with runbook `trader-sweep-behind`.
  Migration `0030_reward_from_margin.sql`: `inrp2p_inr_account_free_margin` (leftovers of trades finished on both
  sides at that account, less rewards paid or pending there, capped by the account's balance beyond open trades'
  money) and IX096 on every reward payout insert, serialized per account; `trader_reward.record_payout` refuses the
  same first (`TRADER_REWARD_NOT_COVERED`); the desk shows each account's free margin and offers the best first. The
  P&L now shows the economics after rewards and recorded fees (net may be negative and is shown so), each trade's
  margin after its frozen reward, rewards owed against the margin free to pay them, and lists the costs the ledger
  does not carry (TRX, custody fees, unrecorded bank charges) as not deducted, with who covers them. The
  `overdue_route_obligations` explanation is corrected for D-16 (the client waits for the counterparty's money).
- **Tests.** `test/integration/trader-lifecycle.int.test.ts` — one trader: apply, approve, reserve, both blocks; a Buy
  USDT order (client USDT in, trader INR in, client paid from the trader's INR, trader paid from the client's USDT)
  and a Sell USDT order (client INR in, trader USDT to the order's address, client paid from it, trader paid from the
  client's INR); sweep completes both and accrues their rewards; free margin ₹500 / ₹400 per account; rewards paid
  from each; IX096 one paisa over; P&L gross ₹900, rewards ₹157.30, net ₹742.70 and per-trade nets; a started order
  survives switching off with its frozen rate and reward and the reserve still locked; switched off with nothing open,
  reserve unlocked and withdrawn; every account at zero; notifications.
  Sweep: a fault planted on one order's row — the other expires, the failure is reported with its code, the health
  signal warns, the retry clears it. `test/integration/traders.int.test.ts` now pays the reward after the client is
  paid, and proves it refused before that and from an account the trade never touched.

## E1 — Email: acceptance codes, sign-in codes, client notifications (TD-04) (P0)

- **Found (on `d0cc778`).** The worker wired `UnconfiguredNotificationAdapter`: acceptance codes and client
  notification emails could not be delivered anywhere. The email channel claimed `email_sent_at` *before* sending, so a
  provider failure after the claim read as delivered — the fictitious success the task forbids. An acceptance code was
  read without a lock and sent afterwards, so a code superseded in between could still go out, and an expired-but-not-
  yet-closed code was sent. The web sign-in sender called Resend with no timeout, no retry and no idempotency.
- **Changed.** `packages/adapters/src/resend.ts` (one client for the worker and the web app: idempotency key per
  delivery, timeout per attempt, bounded backed-off retries, success only with a provider id, refusals permanent, errors
  free of content and secrets), `notificationAdapterFromEnv`; the port's messages carry their delivery id and failures
  are `NotificationDeliveryError` (code, retryable). Acceptance codes: sent under the delivery row's lock, never when the
  challenge is closed or expired, sealed until really delivered. Client emails: migration `0031_email_delivery.sql`,
  one row per recipient (PENDING → SENT with provider id / FAILED with a code), `email_sent_at` only when all went.
  Health `acceptance_codes_undelivered`, `email_deliveries_failing`; runbook `email-delivery`; `.env.example`.
- **Tests.** `packages/adapters/test/resend.unit.test.ts`, `packages/quotes/test/delivery.int.test.ts` (outage leaves
  the code sealed and the retry sends once; a refusal is not a delivery; an expired code is erased, not sent; a new code
  waits for a send under way; a code superseded first is never sent), `packages/notifications/test/email.int.test.ts`
  (outage → pending, retried, each recipient once; refusal → FAILED, not retried, never "sent").
- **Gates.** Gate 2: the real inbox check in staging is **NOT RUN**. Gate 3: the Resend account, its verified sending
  domain (SPF/DKIM/DMARC) and the API key in the secret manager are owner inputs (**BLOCKED**).

## E2 — Bank reconciliation and receipts (TD-12) (P1)

- **Verified, unchanged.** Manual statement import (`statement.import`, OWNER/FINANCE ⧗): one transaction for the file,
  its lines, outcomes and cases; the same file (sha256) refused twice per account; references matched the way FI-22
  makes a UTR unique (trimmed, upper-cased) and only through that account; a confirmed payment the statement does not
  show opens a blocking case (the fake-UTR control, S7). No bank feed exists and none was invented (TD-14 stays open: it
  needs a provider and a contract). Client updates remain polling; TD-10 is not recorded as push.
- **Receipts (found on `d0cc778`).** Tenant scoping (a client's session resolves only its own receipts), `no-store`,
  `nosniff` and download dispositions were in place; receipts were proved by hash and regenerated, never stored, and a
  PDF was re-printed per request.
- **Changed.** `packages/adapters/src/object-store.ts` (S3 API, SigV4, write-once, checksums, Object Lock, bucket
  description; MinIO-tested), migration `0032_receipt_objects.sql` (IX097), `packages/reporting/src/storage.ts`
  (store at issue, serve the recorded version after re-hashing, backfill), worker wiring (bucket from the environment,
  refuses an unversioned bucket, optional PDF printer and retention), the download route, runbook `receipt-integrity`,
  `.env.example`. PDFs: integrity is the hash of the stored bytes; meaning is the HTML hash they were printed from.
- **Tests.** `packages/adapters/test/object-store.int.test.ts`, `packages/reporting/test/receipt-storage.int.test.ts`
  (both against a local MinIO container).
- **Gate 3.** The production bucket (private, versioned, Object Lock), its write role and the retention period are owner
  inputs (**BLOCKED**).

