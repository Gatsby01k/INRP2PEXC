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

## Items

| ID | Pri | Kind | Title | Status |
|---|---|---|---|---|
| ADR-16 | P0 | owner decision | Counterparty-funded execution (`docs/adr/0016-…`) | recorded |
| A1 | P0 | confirmed defect | TRON receipt/history normalization | fixed — code ready |
| A2 | P0 | confirmed defect | History pagination and cursor safety | fixed — code ready |
| A3 | P0 | confirmed defect + external | Provider degradation, D-05 quorum, backfill (TD-06), real smoke (TD-07) | code ready; real smoke **NOT RUN** |

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
