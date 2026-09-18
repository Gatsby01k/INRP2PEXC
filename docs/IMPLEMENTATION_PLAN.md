# INRP2P Exchange — Implementation Plan

Status: Phase 0, revision 3 (`DECISIONS.md` Revision 3).
Rule: each phase has exit criteria; a phase is closed only when all criteria pass from a clean checkout in CI. Later-phase behaviour is not built early.

## Phase 0 — Specification (this commit)
Deliverables: PRODUCT, ARCHITECTURE, DOMAIN_MODEL, STATE_MACHINES, FINANCIAL_INVARIANTS, SECURITY, UX_FLOWS (navigation, component inventory, wireframes, responsive rules), DECISIONS, this plan.
Exit: founder reviews ✔ (rev 2, rev 3); decisions per `DECISIONS.md` Revision 3 incl. approved stack (D-06), direct route settlement (D-14), authenticated rejection (D-15) ✔; cross-document consistency review ✔; founder acceptance; tag `phase-0-accepted`.

## Phase 1 — Foundation
- Node.js 24 LTS, TypeScript 6 strict, pnpm monorepo, PostgreSQL 18.6 via Testcontainers, lint boundaries between packages, CI (typecheck, lint, unit, integration with Testcontainers Postgres, secret scan).
- `kernel`: Money/Rate/Currency, conversion + rounding, ids, DB clock, typed errors.
- `db`: migrations, roles (`app_rw`, `worker`, `migrator`), append-only triggers, transaction helper with lock-order helper.
- `identity`: Better Auth (operator config: credential login + mandatory TOTP; client config: email-OTP login + email verification), schema as explicit SQL migrations, `step_up_verification`, RBAC matrix (incl. route, custody and direct-payout permissions), auth audit hooks. Verify the pinned Better Auth version against SECURITY §2 (cookies, timeouts, revocation, TOTP); report any gap. No custom session framework.
- `audit`: writer, redaction, sealing job.
- `ledger`: accounts, balanced journal posting, posting-key uniqueness, balance queries, global zero check.
- Idempotency key store + command pipeline skeleton; outbox + Graphile Worker dispatcher.
Compliance hooks from D-07 are schema-level only here (no KYC workflow).
Exit: canonical money tests (100k @ 102.00/104.20 → ₹10.2M / ₹220k; reverse direction; rounding table); unbalanced journal rejected; ledger/audit UPDATE/DELETE rejected at DB; idempotent replay; RBAC tests for every matrix cell; MFA enforced for every operator route; operator and client sessions isolated by host/cookie.

## Phase 1.5 — Design system
Tokens (UX_FLOWS §1, approved D-10), locale-independent INR formatter with international grouping (D-11), Geist, `ui` package, all components in UX_FLOWS §4 in Storybook with realistic values, formatting library, accessibility checks (axe) and Playwright visual regression baselines for every component state.
Exit: component review sign-off; AA contrast automated check green; reduced-motion variants present.

## Phase 2 — Reference data
Clients, contacts, client users (`can_accept_quotes`), bank accounts (encryption, archive-not-edit), client wallets, settlement entities, INR settlement accounts, `inr_account_day`, liquidity routes with `settlement_model` (only `PER_TRADE` accepted), rate snapshots, rates desk commands, treasury wallets, `CustodyAdapter` port + `custody_provider_config`, deposit addresses and assignments.
**Gate (D-02):** before building the deposit-address implementation, confirm the chosen custody/wallet provider supports TRC20 address derivation or pooling (and how funds on those addresses are consolidated). If it does not, stop and report the exact limitation; do not substitute other attribution logic. The rest of Phase 2 may proceed.
Exit: capacity reservation race test (two concurrent reservations on last capacity → exactly one succeeds); two concurrent address allocations never return the same address; capability recorded in `custody_provider_config` and queryable by the acceptance module (enforced in Phase 3); non-`PER_TRADE` route model rejected; paused account rejects reservations; rate snapshot append-only; client bank change audited.

## Phase 3 — Requests & quotes
Trade requests, quote create/send/counter/decline/cancel, quote links (view-only token), acceptance challenges (INRP2P domain OTP, not Better Auth), `quote.accept` / `quote.reject` (authenticated app) and `quote.accept_via_link` / `quote.reject_via_link` (OTP-verified), link validity default 180 s / min 120 s, expiry job + sweeper, acceptance creating Trade + economics (frozen route execution mode) + route obligation (OPEN) + deposit assignment + accept journal (incl. route receivable/payable and deferred margin), client projection types.
Exit tests: opening a link never changes state; unauthenticated link "Decline" makes no server mutation and the quote stays SENT; link rejection without OTP impossible; link acceptance without OTP impossible; link quote with validity < 120 s rejected, default 180 s; OTP expiry never exceeds quote expiry; wrong / expired / superseded / reused OTP rejected; OTP valid but quote expired rejected; attempts and send limits enforced; accept at T−1ms succeeds; at T+1ms fails; same quote accepted twice; two operators/clients accepting the same request concurrently; superseded quote cannot be accepted; rate change after acceptance doesn't change trade; client API JSON never contains route/margin/provider keys; link token lookup constant time and rate-limited; SELL acceptance disabled when custody capability is `UNSUPPORTED`.

## Phase 4 — Trade state machine & settlement legs
Trade transitions T1–T10, hold overlay, route obligation allocation and cancellation, settlement legs with payer `EXCHANGE_ACCOUNT` / `ROUTE`, movements (`fiat_transfer`, `crypto_transfer` records) with one journal per movement, `transfer_allocation` (CLIENT / ROUTE dimensions), direct route payout confirm (`DIRECT_TO_CLIENT`), `TO_EXCHANGE` route settlements (record against one obligation side; confirm posts the movement journal and allocates that side atomically — no separate allocation step in V1, see `STATE_MACHINES.md §9`), fiat transfers (UTR uniqueness), capacity consume/release, completion + margin realization, cancellation reversal, financial adjustments (two-person), exception cases + resolution commands.
Exit tests — **direct route payout, no double counting**:
  1. Canonical: SELL 100,000 USDT, client ₹102.00, route ₹104.20, mode `DIRECT_TO_CLIENT`; one route payout ₹10,200,000 with one UTR → exactly one `fiat_transfer`, exactly one movement journal (Dr CLIENT_PAYABLE / Cr ROUTE_RECEIVABLE), leg COMPLETED, trade COMPLETED, margin ₹220,000 realized, route obligation PARTIALLY_SETTLED with INR remaining ₹220,000 and ledger ROUTE_RECEIVABLE for that obligation = ₹220,000 (FI-64).
  2. Replaying the confirm (same idempotency key; new key) posts nothing and allocates nothing again.
  3. Recording the same UTR as a `FROM_ROUTE_TO_EXCHANGE` route settlement, as another leg, or on another trade is rejected (FI-22, FI-28).
  4. Manually allocating a direct movement to a second route settlement or a second leg is rejected (unique dimension).
  5. A movement with payer `EXCHANGE_ACCOUNT` cannot be allocated to a route obligation; a `ROUTE` payer leg is rejected on a `TO_EXCHANGE` trade (FI-65).
  6. Direct payout larger than client remaining or than route-delivers remaining → whole command rolls back; `ROUTE_DIRECT_PAYOUT_MISMATCH` opened; no leg, allocation or journal persists.
  7. Concurrent confirms of two direct legs whose sum exceeds route remaining → exactly one succeeds.
  8. Mixed payers: route direct ₹10,000,000 + exchange account ₹200,000 → trade COMPLETED, route INR remaining ₹420,000; client payable zero; ledger balanced per currency.
  9. Failed direct leg: no journal, no route allocation, obligation unchanged.
  10. Residual ₹220,000 later settled by `FROM_ROUTE_TO_EXCHANGE` → obligation SETTLED once USDT side also settled; ledger route balances zero.
  11. Client projections/receipts of a direct payout never include route identity.
  12. Global property test: for random sequences of direct/exchange/route movements, Σ client payable reductions = Σ CLIENT-dimension allocations, Σ route receivable reductions = Σ ROUTE-dimension allocations, and each movement id appears in exactly one journal.
Other exit tests: multiple INR legs; partial settlement; failed leg + replacement; duplicate UTR; over-allocation blocked (concurrent); cancelled trade releases capacity; adjustment preserves original economics and posts compensating journal; P&L counts only completed trades; trade completes while route obligation stays OPEN (FI-62); property-based test of random command sequences never violates FI-20/21/30/40.

## Phase 5 — TRON monitoring
TronAdapter (two providers), block/address scanner with cursor, transfer detection, solidification confirmation, allocation, exception detection (short/over/unexpected sender/duplicate/not final), BUY outbound verification by tx hash.
Attribution strictly by deposit assignment (FI-26); funds to cooled-down / unassigned addresses → suspense + exception.
Exit tests (recorded fixtures + fake adapter; the testnet smoke test is deferred to `TECH_DEBT.md` TD-07 and blocks real USDT): duplicate event idempotent; transfer to another trade's address never allocated to this trade; cooled-down address deposit → `FUNDS_AFTER_TRADE_CLOSED`; same tx on two trades rejected; short and over payment; wrong destination/contract ignored or suspense; seen-not-final stays DETECTED; orphaned tx reverts; provider disagreement blocks confirmation.

## Phase 6 — Operator product
Desk (strip + grouped queue + context panels), Orders, Rates (incl. Route positions), route settlement recording + allocation via `ManualRouteAdapter` (FINANCE/OWNER), direct route payout legs in the payout panel (payer selector, route-reported sent, UTR, confirm), INR, USDT (incl. deposit pool status), Clients (create quote, repeat trade), trade operations, command bar, keyboard flows, step-up dialogs.
Exit: E2E demo scenario driven entirely through operator UI + fake chain; keyboard-only run of quote → payout; visual regression for operator validation list.

## Phase 7 — Client product
Exchange (both directions), firm quote states, quote link page + OTP acceptance verification (D-01, W3b), trade tracking, history, bank & wallets, account, notifications (in-app + email).
Exit: E2E from link open on mobile viewport to completion; client JSON leakage test; visual regression for client validation list; Lighthouse mobile ≥ 90 for link page.

## Phase 8 — Finance outputs
P&L page (realized vs expected), receipts (PDF/CSV/JSON from immutable snapshot, grayscale print check), exports, reconciliation job + manual bank statement import, remaining exception resolutions.
Exit: receipt byte-stable regeneration from snapshot (hash matches); reconciliation opens exceptions idempotently; P&L equals ledger revenue.

## Phase 9 — Public site & hardening
Landing + SEO routes (metadata, structured data without fabricated figures, sitemap), copy review for zero regulatory claims (D-07), security headers/CSP, rate limits, load test on quote accept and payout confirm, backup/restore drill, monitoring + alerts, runbooks, launch checklist.
Exit: launch checklist complete (below), penetration test findings triaged, counsel sign-off (D-07).

---

## Plan challenge (required before production code)

| Risk | Where it breaks in naive builds | How this plan closes it | Residual risk |
|---|---|---|---|
| **Money precision** | JS `number`, `NUMERIC` read as float by drivers, rounding in UI | `bigint` minor units in DB and TS, pg driver type parser for BIGINT → bigint, lint bans, decimal-string JSON, one conversion function with explicit rounding mode per payer | Display rounding for averages (display only) |
| **Double settlement** | Two operators both create the last ₹2M leg; retry of "confirm" | Trade row lock + FI-20 deferred check; leg confirmation state-guarded + posting key; idempotency keys | Real-world double bank transfer by humans outside system → caught by reconciliation, not prevented |
| **Race conditions** | Accept vs expire; concurrent sends; completion vs new leg | Single lock order, `FOR UPDATE`, partial unique indexes, DB time only | Deadlocks if lock order violated → lint helper + deadlock retry (idempotent) |
| **Capacity over-allocation** | Totals read then written without lock | `inr_account_day` row lock, check under lock, reservation state machine, day-scoped rows | Capacity is operator-maintained; bank-side limits may differ → reconciliation + exception |
| **Duplicate blockchain events** | Webhook replay, scanner overlap, two providers | Unique `(network, tx_hash, log_index)`; allocation unique; scanner cursor overlap by design | Provider outage delays confirmations (never false-confirms) |
| **Duplicate UTRs** | Typos, reused references | Normalization + unique per rail; change requires step-up + audit | Different banks formatting same UTR differently → normalization rules need real samples |
| **Quote expiry races** | App-server clock, in-memory timers, client countdown trusted | DB `statement_timestamp()`, lock-guarded mutually exclusive predicates, job + sweeper | Network latency near expiry means some clients see "expired" after pressing at 00:01 — acceptable, explained in UI |
| **Margin calculation** | Margin typed, computed in UI, wrong sign for BUY | Derived only, stored with CHECK constraint, direction-specific formula tested both ways | Fees not modelled in V1 margin (explicit zero) |
| **Historical pricing mutation** | Trades join to "current rate" | Snapshots copied into insert-only `trade_economics`; adjustments as separate records | Reports must never join to current rates → query review checklist |
| **Leaked quote link** | Bearer link accepts on behalf of client | Token is view-only; OTP to verified email of authorized user, consumed atomically with acceptance (D-01, FI-07) | Compromised client mailbox |
| **USDT misattribution** | Shared address + amount matching | Unique per-trade deposit address via custody adapter; no heuristics (D-02, FI-26) | Provider capability not yet confirmed — Phase 2 gate |
| **Route settlement drift / double counting** | Route side untracked; direct route→client payout recorded twice (as payout and as route settlement) | Separate route obligations recognized at acceptance; one movement row + one journal per UTR/tx; dimension-unique allocations; atomic direct confirm (D-03, D-14, FI-27/28, FI-60…65) | Only `PER_TRADE` implemented; route statements imported manually |
| **Permission failures** | UI hides buttons but API allows; margin leaks in JSON | Command-level authorization, DTO field absence, leakage tests, matrix tests per cell, MFA/step-up enforced server-side | Misconfigured role grants by OWNER → audited, alerts on role changes |

Remaining external dependencies (not blocking Phase 1):
- Custody/wallet provider capability for unique TRC20 deposit addresses — Phase 2 gate (D-02).
- India counsel sign-off — production launch gate; no regulatory claims until then (D-07).

## Production launch checklist (maintained through phases)
- [ ] Counsel sign-off on registrations, KYC/AML, tax, banking terms (D-07)
- [ ] All Phase 1–9 exit criteria green in CI from clean checkout
- [ ] Ledger global zero check green for 7 consecutive days in staging
- [ ] Demo scenario E2E green (100k SELL, multi-leg payout, receipt, ₹220k margin)
- [ ] MFA enrolled for every operator; OWNER break-glass tested
- [ ] Backups + PITR restore drill completed
- [ ] Audit seal exported off-site daily
- [ ] TRON dual provider configured; scanner lag alert tested
- [ ] Rate limits and CSP verified in production config
- [ ] Penetration test done, criticals fixed
- [ ] Runbooks: stuck USDT confirmation, failed bank transfer, duplicate UTR, provider outage, capacity emergency, suspected account takeover
- [ ] Public site, receipts, notifications reviewed: no fabricated volume/rates/times; no regulatory claims unless confirmed by counsel
- [ ] Custody provider deposit-address capability recorded in `custody_provider_config` (not `UNSUPPORTED`)
- [ ] Route settlement runbook for `PER_TRADE` routes; overdue obligation alert tested
