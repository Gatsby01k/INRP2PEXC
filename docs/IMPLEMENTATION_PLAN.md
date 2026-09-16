# INRP2P Exchange — Implementation Plan

Status: Phase 0 draft, for review.
Rule: each phase has exit criteria; a phase is closed only when all criteria pass from a clean checkout in CI. Later-phase behaviour is not built early.

## Phase 0 — Specification (this commit)
Deliverables: PRODUCT, ARCHITECTURE, DOMAIN_MODEL, STATE_MACHINES, FINANCIAL_INVARIANTS, SECURITY, UX_FLOWS (navigation, component inventory, wireframes, responsive rules), DECISIONS, this plan.
Exit: founder review; D-01, D-02, D-03, D-07, D-11 decided; documents revised; Phase 0 tagged `phase-0-accepted`.

## Phase 1 — Foundation
- pnpm monorepo, TS strict, lint boundaries between packages, CI (typecheck, lint, unit, integration with Testcontainers Postgres, secret scan).
- `kernel`: Money/Rate/Currency, conversion + rounding, ids, DB clock, typed errors.
- `db`: migrations, roles (`app_rw`, `worker`, `migrator`), append-only triggers, transaction helper with lock-order helper.
- `identity`: operator users, Argon2id, TOTP MFA, sessions, step-up, RBAC matrix, client users + email OTP.
- `audit`: writer, redaction, sealing job.
- `ledger`: accounts, balanced journal posting, posting-key uniqueness, balance queries, global zero check.
- Idempotency key store + command pipeline skeleton; outbox + Graphile Worker dispatcher.
Exit: canonical money tests (100k @ 102.00/104.20 → ₹10.2M / ₹220k; reverse direction; rounding table); unbalanced journal rejected; ledger/audit UPDATE/DELETE rejected at DB; idempotent replay; RBAC tests for every matrix cell; MFA enforced for every operator route.

## Phase 1.5 — Design system
Tokens (UX_FLOWS §1), Geist, `ui` package, all components in UX_FLOWS §4 in Storybook with realistic values, formatting library, accessibility checks (axe) and Playwright visual regression baselines for every component state.
Exit: component review sign-off; AA contrast automated check green; reduced-motion variants present.

## Phase 2 — Reference data
Clients, contacts, bank accounts (encryption, archive-not-edit), client wallets, settlement entities, INR settlement accounts, `inr_account_day`, liquidity routes, rate snapshots, rates desk commands, treasury wallets, deposit address pool (per D-02).
Exit: capacity reservation race test (two concurrent reservations on last capacity → exactly one succeeds); paused account rejects reservations; rate snapshot append-only; client bank change audited.

## Phase 3 — Requests & quotes
Trade requests, quote create/send/counter/decline/cancel, quote links, expiry job + sweeper, acceptance command creating Trade + economics + accept journal, client projection types.
Exit tests: accept at T−1ms succeeds; at T+1ms fails; same quote accepted twice; two operators/clients accepting the same request concurrently; superseded quote cannot be accepted; rate change after acceptance doesn't change trade; client API JSON never contains route/margin/provider keys; link token lookup constant time and rate-limited.

## Phase 4 — Trade state machine & settlement legs
Trade transitions T1–T10, hold overlay, settlement legs, fiat transfers (UTR uniqueness), capacity consume/release, completion + margin realization, cancellation reversal, financial adjustments (two-person), exception cases + resolution commands.
Exit tests: multiple INR legs; partial settlement; failed leg + replacement; duplicate UTR; over-allocation blocked (concurrent); cancelled trade releases capacity; adjustment preserves original economics and posts compensating journal; P&L counts only completed trades; property-based test of random command sequences never violates FI-20/21/30/40.

## Phase 5 — TRON monitoring
TronAdapter (two providers), block/address scanner with cursor, transfer detection, solidification confirmation, allocation, exception detection (short/over/unexpected sender/duplicate/not final), BUY outbound verification by tx hash.
Exit tests (recorded fixtures + fake adapter + testnet smoke): duplicate event idempotent; same tx on two trades rejected; short and over payment; wrong destination/contract ignored or suspense; seen-not-final stays DETECTED; orphaned tx reverts; provider disagreement blocks confirmation.

## Phase 6 — Operator product
Desk (strip + grouped queue + context panels), Orders, Rates, INR, USDT, Clients (create quote, repeat trade), trade operations, command bar, keyboard flows, step-up dialogs.
Exit: E2E demo scenario driven entirely through operator UI + fake chain; keyboard-only run of quote → payout; visual regression for operator validation list.

## Phase 7 — Client product
Exchange (both directions), firm quote states, quote link page + acceptance verification (D-01), trade tracking, history, bank & wallets, account, notifications (in-app + email).
Exit: E2E from link open on mobile viewport to completion; client JSON leakage test; visual regression for client validation list; Lighthouse mobile ≥ 90 for link page.

## Phase 8 — Finance outputs
P&L page (realized vs expected), receipts (PDF/CSV/JSON from immutable snapshot, grayscale print check), exports, reconciliation job + manual bank statement import, remaining exception resolutions.
Exit: receipt byte-stable regeneration from snapshot (hash matches); reconciliation opens exceptions idempotently; P&L equals ledger revenue.

## Phase 9 — Public site & hardening
Landing + SEO routes (metadata, structured data without fabricated figures, sitemap), security headers/CSP, rate limits, load test on quote accept and payout confirm, backup/restore drill, monitoring + alerts, runbooks, launch checklist.
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
| **Permission failures** | UI hides buttons but API allows; margin leaks in JSON | Command-level authorization, DTO field absence, leakage tests, matrix tests per cell, MFA/step-up enforced server-side | Misconfigured role grants by OWNER → audited, alerts on role changes |

Additional risks surfaced while writing Phase 0:
- **USDT attribution without keys** (D-02) is the single largest operational ambiguity.
- **Route settlement not modelled** (D-03) — margin is correct per trade but treasury/INR positions won't reconcile end-to-end without it.
- **Leaked quote link** (D-01).
- **Compliance obligations** (D-07) can block launch regardless of product quality.

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
- [ ] Public site reviewed: no fabricated volume/rates/times/regulatory claims
