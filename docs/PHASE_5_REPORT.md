# INRP2P Exchange — Phase 5 Report (TRON monitoring)

Status: provisionally approved; hardening corrections applied (§11). **Not fully closed**: the TD-07 smoke gate exists but has NOT been run against real providers. Phase 6 not started.
Base: `4900209` (Phase 4 review corrections). Scope: `IMPLEMENTATION_PLAN.md` Phase 5 only — the TRON adapter over two providers, the block/address scanner with its cursor, transfer detection, solidification confirmation, allocation, exception detection and BUY outbound verification. No UI (Phase 6), no attachments, no receipts.

## 1. The shape of the phase in one paragraph

Phase 4 decided **what makes a USDT transfer count** (FI-24 finality, FI-26 attribution, D-05 agreement) and hid the chain behind the `ChainVerifier` port. Phase 5 puts real facts behind that port and adds the jobs that go looking for them, without moving a single rule. The scanner detects, the verifier decides, the settlement commands of Phase 4 do the writing: `tron_scan` calls `recordClientDeposit`, `tron_confirm` calls the same client-leg confirmation an operator calls, and neither of them can confirm anything the two providers did not agree on. One change of substance was needed in Phase 4's code: agreement is now a property of the **answer** (`TransferReceipt.agreedBy`) rather than of the configuration, so a second provider that lags or disagrees blocks a large confirmation instead of being counted because it was configured.

## 2. What exists

```
packages/adapters   + TronProvider port, TronHttpProvider (TronGrid-compatible), DualProviderChainVerifier,
                      sameTransfer; TransferReceipt.agreedBy; testing: FakeTronChain, FakeTronProvider
packages/scanner    NEW — scanner policy, chain cursor, watched addresses, tron_scan, tron_confirm,
                      tron_orphan_sweep
packages/settlement + confirmClientLegInTx / revertClientLegInTx (the T4 and T3 cores, callable by the system),
                      markCryptoOrphaned, treasury destination for a direct-to-treasury deposit,
                      typed VerificationResult; the D-05 quorum reads receipt.agreedGroups
packages/db         + migration 0016 (chain_cursor) and its schema types
packages/kernel     + Phase 5 error codes (CHAIN_PROVIDER_ERROR and friends)
apps/worker         + chainMonitoringFromEnv (DISABLED / READY / DEGRADED / UNCONFIGURED) and the three TRON jobs
scripts             + tron-smoke.ts, the credential-gated provider gate (TD-07), with a manual GitHub workflow
```

## 3. Migration 0016

One table. The scanner's only persistent state is where it has read to — everything it discovers lives in `crypto_transfer`, whose `(network, tx_hash, log_index)` uniqueness (FI-23) makes re-detection free.

| Column | Meaning |
|---|---|
| `network`, `scanner` | one cursor per logical scanner (`tron_deposits`), unique together |
| `last_scanned_block` | highest block read; each run re-reads a configured overlap below it |
| `last_solidified_block` | the finality line the providers reported at the last run |
| `last_run_at`, `updated_at` | operational visibility (a lag alert reads these) |

Guards: `inrp2p_guard_immutable_columns` (only the four mutable columns change), `inrp2p_guard_chain_cursor` raising **IX066** on any backwards move, and the usual no-delete trigger. Column-level GRANTs let the app advance the cursor and nothing else.

A monotonic cursor is a deliberate choice. A provider that suddenly reports a lower head is lagging or wrong, and rewinding on its word would re-emit work and hide the regression; a gap longer than the overlap is a deliberate backfill (**TD-06**), never a silent rewind. Losing the cursor entirely costs a rescan and nothing else.

## 4. The three jobs

| Job | Cron | What it does | What it refuses to do |
|---|---|---|---|
| `tron_scan` | every minute | Lists TRC20 transfers of the configured contract into every watched address (assigned **and** cooled-down deposit addresses, active treasury wallets) from the cursor minus the overlap; records each as DETECTED through `recordClientDeposit`, one idempotent command per chain event keyed `tron:{txHash}:{logIndex}`; advances the cursor | Confirm anything; attribute by amount or sender; accept a transfer the provider reports under another contract |
| `tron_confirm` | every minute | Offers every DETECTED transfer to the `ChainVerifier`. Confirmed **and** claimed by a client leg → the Phase 4 T4 confirmation runs (one journal, leg COMPLETED, trade payable). Confirmed and unclaimed → suspense posting. Failed receipt → transfer FAILED and the client leg reverted (T3). Still pending past the configured age → a `TX_NOT_FINAL` case | Release money to a client: a confirmed **outbound** payout transfer is only verified; completing that leg stays `settlement:confirm_payout` (⧗) |
| `tron_orphan_sweep` | every 10 minutes | Marks a DETECTED transfer the providers no longer report as ORPHANED, voids its allocation, fails the leg, puts the trade back to `AWAITING_FIRST_LEG` | Touch a CONFIRMED transfer — it sat in a solidified block, which is irreversible; its disappearance would be a reconciliation case for a human |

Watching a cooled-down address is deliberate: a late payment to a closed trade must be **seen** and turned into `FUNDS_AFTER_TRADE_CLOSED`, not missed.

## 5. Dual-provider agreement (D-05), precisely

`DualProviderChainVerifier` asks the primary for the facts and the secondary whether it sees exactly the same ones — hash, log index, contract, sender, destination, amount, block number, receipt status (`sameTransfer`); block *time* is provider metadata and is not compared.

Every adapter declares a stable **independence group**: who actually operates the data behind it. The receipt carries both `agreedBy` (the provider names, for the audit trail) and `agreedGroups` (the distinct groups among them), and `verifyCryptoTransfer` measures the quorum on the groups: at or above `dualProviderThresholdUsdt` (10,000 USDT), fewer than two independent groups refuses confirmation with the typed code `INSUFFICIENT_PROVIDER_QUORUM`. Two adapters onto the same vendor, cluster or upstream node are one source of truth however they are named, so they add redundancy and never a quorum. The group is configured, never inferred from the URL, because two hostnames of one vendor look independent and are not. The confirming row records `verified_by = agreedBy.join(',')` and the audit event carries the groups.

The facts are always the primary's, never a blend: a disagreeing secondary subtracts confidence, it never contributes a value. Below the threshold a single provider still settles, which is what makes an outage degrade rather than stop the desk.

## 6. What Phase 4 code changed, and why

1. **`TransferReceipt.agreedBy` / `agreedGroups`** (adapters) and the D-05 check reading them (settlement). Before, the rule read `deps.chain.providers.length`, which says how many providers are *configured*. That would have confirmed a large amount on one provider's word the moment the second one lagged. This is the one semantic correction of the phase; the review then tightened it from "two names agreed" to "two independent sources agreed" (§11).
2. **`confirmClientLegInTx` / `revertClientLegInTx`** extracted from `confirmFirstLeg` / `revertFirstLeg`. Same bodies, no policy of their own; the operator commands are now thin wrappers, and the scanner reaches the identical code as a system job. The operator path keeps its step-up exactly as before.
3. **`revertClientLegInTx` voids the leg's allocation.** A reverted leg's evidence never satisfied anything, so leaving the link in place would have been a lie about which movement paid for what.
4. **A direct-to-treasury deposit now resolves its treasury wallet** in `recordClientDeposit`, so an unclaimed deposit straight to a treasury address can post to `SUSPENSE:UNALLOCATED` on confirmation, as STATE_MACHINES §5 says it must. Funds at an address we do not recognise at all still have no destination account and stay unposted with their case open.

No permission was added or changed: everything in this phase is either a system job or an existing operator command.

## 7. Exit criteria

`packages/scanner/test/scanner.int.test.ts` — 19 tests, real jobs against two fake TRON nodes over one fake chain.

| Plan requirement | Test |
|---|---|
| duplicate event idempotent | rescanning the overlap window detects nothing new; one transfer row, one leg, one allocation |
| transfer to another trade's address never allocated to this trade | the other trade gets the leg; this one stays `AWAITING_FIRST_LEG` with no legs |
| same tx on two trades rejected | an operator submitting the same hash while working a second trade still attributes it to the destination's trade; the second trade gets nothing |
| cooled-down address deposit → `FUNDS_AFTER_TRADE_CLOSED` | the cancelled trade's address is COOLDOWN; the late transfer opens exactly that case and creates no leg |
| short and over payment | 90 of 100 → `USDT_WRONG_AMOUNT` and the trade on hold; 120 of 100 → `USDT_OVERPAYMENT` |
| wrong destination / contract ignored or suspense | a provider reporting the transfer under another contract → ignored, no row written, and the same transfer is detected normally by an honest provider; a deposit straight to the treasury wallet → `UNALLOCATED_DEPOSIT`, then exactly one journal DR treasury / CR `SUSPENSE:UNALLOCATED` |
| seen-not-final stays DETECTED | unsolidified → still DETECTED, trade still `FIRST_LEG_DETECTED`, no case; after solidification the leg completes with its single journal |
| orphaned tx reverts | ORPHANED, leg FAILED, allocation voided, trade back to `AWAITING_FIRST_LEG`, no journal ever posted |
| provider disagreement blocks confirmation | 20,000 USDT with the secondary blind → stays DETECTED, `TX_NOT_FINAL` opened, trade unchanged; once it agrees → CONFIRMED, `verified_by` naming both |
| duplicate provider identity cannot form quorum (review §11.1) | two differently named adapters declaring one independence group → the same 20,000 USDT transfer stays DETECTED with `verified_by` null, `verifyCryptoTransfer` returns the typed `INSUFFICIENT_PROVIDER_QUORUM`, and the case carries that code; a genuinely independent second source then confirms it |
| cursor recovery after a long outage (review §11.4) | four transfers spread over 400 blocks, a cursor 500 blocks back and a 50-block window → the first run does not reach the head and the newest transfer is still unseen; successive runs walk the whole gap and every transfer is processed |
| the cursor never runs ahead of the work | a provider that fails part-way through a pass leaves the cursor exactly where it was |
| (below threshold) | 5 USDT confirms on one provider, `verified_by` naming one |
| BUY outbound verification by tx hash | not final → the operator's confirm is refused; after solidification the scanner marks the transfer CONFIRMED but leaves the leg PROCESSING; the operator's step-up confirm completes the trade |
| failed receipt | transfer FAILED, leg FAILED, trade back to awaiting, no journal |
| cursor | advances with the chain; a backwards update is refused with IX066 |

`packages/adapters/test/tron.unit.test.ts` — 13 tests: agreement naming one or both providers and reporting their groups, two adapters in one group counting once, an unusable provider identity refused, facts always the primary's, `sameTransfer` field by field, an unknown transfer as `null`, an unsupported network refused, TronGrid parsing (head and solidified head, contract and block filtering), unreadable answers refused rather than guessed, and a failing or unreachable node becoming `CHAIN_PROVIDER_ERROR`.

`apps/worker/test/worker.int.test.ts` — the three jobs exist and are scheduled; with monitoring deliberately disabled they do nothing (no cursor row, no commands), and with monitoring enabled but unconfigured every one of them fails with `CHAIN_MONITORING_UNCONFIGURED` rather than returning quietly. All four states are asserted from the environment, including two endpoints of one operator landing in DEGRADED with a reason that says so.

`scripts/test/tron-smoke.unit.test.ts` — the smoke gate's configuration parsing: a complete configuration, every missing setting named at once, malformed values rejected, and two providers declaring the same independence group refused outright.

The live gate itself is **NOT RUN** — see §11.3 and TD-07.

## 8. Interpretations for review

1. **The scanner never releases money.** The plan says "BUY outbound verification by tx hash". I read that as verification only: `tron_confirm` marks the outbound transfer CONFIRMED so the desk sees a settled fact, but completing the payout leg stays `settlement:confirm_payout` with its step-up. Automating the release would have moved a two-key decision into a cron job.
2. **Only DETECTED transfers are orphaned.** TRON solidification is final by definition, so a CONFIRMED transfer going missing means something worse than a reorg and deserves a human, not an automatic reversal. No automatic path from CONFIRMED to ORPHANED exists in the scanner.
3. **`TX_NOT_FINAL` is a WARNING, not blocking.** It tells the desk a transfer has been pending too long (a lagging provider, a disagreement, an unsolidified block); it does not put the trade on hold, because nothing about the trade is wrong yet.
4. **The cursor is monotonic** (§3), and a backfill is deliberate tooling rather than a rewind (TD-06).
5. **Suspense needs a destination account.** An unclaimed deposit to a treasury wallet or a known deposit address posts DR treasury / CR suspense on confirmation; funds at an address with no treasury wallet behind it keep their `UNALLOCATED_DEPOSIT` case and post nothing, because there is no account to debit. That is the honest reading of FI-27.
6. **Detection uses the primary provider only.** Listing from both would double the work to gain nothing: agreement is required where it matters, at confirmation. A primary that misses transfers delays detection; it can never confirm one.

## 9. Gates run locally

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | lockfile up to date, supply-chain policies pass |
| `pnpm workspace:graph` | acyclic, 20 workspace manifests (`@inrp2p/scanner` added) |
| `pnpm smoke:tron` | **NOT RUN** — exits 2 with the missing settings listed; no chain access or credentials in this environment (TD-07) |
| `pnpm versions:check` | version matrix OK (21 manifests); PostgreSQL 18.6 enforced by CI |
| `pnpm secret-scan` | 535 files clean (the TRC20 `Transfer` topic is marked as the published constant it is) |
| `pnpm lint` | clean (scanner added to the ARCHITECTURE §3 boundary map and the no-float-money rule set) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | 214 tests, 13 files (was 197/11 before Phase 5) |
| `pnpm test:integration` | 506 tests, 19 files (was 484/18 before Phase 5); PostgreSQL 18.4 locally, CI runs 18.6 |
| `pnpm --filter @inrp2p/web build` | succeeds |

## 10. Open items carried forward

- **TD-05 is closed**: the port has real implementations and the scanner exists. What remains is deployment configuration — endpoints, independence groups, keys, the USDT contract address — and the launch checklist still carries "TRON dual provider configured; scanner lag alert tested".
- **TD-06** is narrowed to a deliberate historical backfill *behind* the cursor; ordinary recovery after an outage is now tested behaviour, not debt.
- **TD-07** is open with the gate written but **NOT RUN**. Phase 5 is not fully closed until `pnpm smoke:tron` passes against two real, independent providers.
- **TD-03** (KMS keys) and **TD-04** (email provider) are unchanged; **D-02** (custody capability for unique deposit addresses) is still the gate on SELL acceptance.
- Phase 6 owns the desk screens over all of this, including the USDT panel and deposit-pool status, plus attachments and receipts.

## 11. Review corrections (follow-up commit on `7c90e17`)

Phase 5 was provisionally approved with four hardening corrections. The scanner, verifier and settlement semantics are unchanged; what changed is what counts as an independent provider, what an enabled-but-broken deployment does, and how far one scan run may advance the cursor.

### 11.1 D-05 now counts independent sources, not names

Each provider declares a stable `independenceGroup` — who actually operates the data behind that adapter. `DualProviderChainVerifier` exposes the configured `independenceGroups` and puts the agreeing ones on every receipt as `agreedGroups`; `verifyCryptoTransfer` measures the quorum there. Two differently named adapters onto the same vendor now agree loudly and still count as **one** source, so they can never satisfy the ≥ 10,000 USDT requirement.

The group is configuration, not inference: `TronHttpProvider` requires it, and `chainMonitoringFromEnv` requires `INRP2P_TRON_PRIMARY_GROUP` (and `_SECONDARY_GROUP` when a second endpoint is set). Deriving it from the URL was considered and rejected — `api.trongrid.io` and `api.eu.trongrid.io` look independent and are not, and a wrong guess here is exactly the failure this correction exists to prevent.

Refusals are typed. `verifyCryptoTransfer` returns a discriminated `VerificationResult`: `{ confirmed: true }`, or `{ confirmed: false, code, reason }` with `code` in `WRONG_STATE | NOT_ON_CHAIN | WRONG_CONTRACT | DESTINATION_MISMATCH | AMOUNT_MISMATCH | RECEIPT_FAILED | NOT_SOLIDIFIED | INSUFFICIENT_PROVIDER_QUORUM`. The scanner branches on `RECEIPT_FAILED` instead of re-reading the row, and a `TX_NOT_FINAL` case now carries the code, so "waiting for the chain" and "these two providers are one source" are distinguishable on the desk.

Tests: duplicate groups cannot form a quorum (unit and integration), an unusable provider identity is refused, and the same 20,000 USDT transfer that a mirrored pair leaves DETECTED confirms once a genuinely independent source is added.

### 11.2 Chain monitoring has an explicit state

`chainMonitoringFromEnv` returns one of four states with reasons, and never throws:

| State | When | What the jobs do |
|---|---|---|
| `DISABLED` | `INRP2P_TRON_MONITORING=disabled`, or no TRON settings at all | nothing, and that is healthy — this is how development and tests run |
| `READY` | enabled, configured, two independent groups | everything |
| `DEGRADED` | enabled and configured, one independent source | scan and confirm below the D-05 threshold; large amounts cannot confirm, and the worker says so at startup |
| `UNCONFIGURED` | enabled but settings missing or invalid | every chain job fails with `CHAIN_MONITORING_UNCONFIGURED`; `chainMonitoringReady` is false and `main.ts` refuses to start |

Forgetting the flag does not silence anything: with no flag but any TRON setting present, monitoring is treated as enabled, so such a deployment is READY, DEGRADED or UNCONFIGURED — never quietly off. Nothing substitutes fake data: an unconfigured deployment still has `UnconfiguredChainVerifier` behind the port, which throws on every lookup.

### 11.3 The manual provider smoke gate exists — and has NOT been run

`scripts/tron-smoke.ts` (`pnpm smoke:tron`) and the `workflow_dispatch`-only `tron-smoke` GitHub workflow. It takes the primary and secondary providers with their independence groups and optional API keys, the network, the token contract, a known transaction hash and log index, and the expected sender, destination and amount. It verifies connectivity and the finality line on both providers, canonical parsing of the transaction on both, that their facts are identical, that the parsed facts match what was expected, and finally the real `DualProviderChainVerifier` decision including solidification and quorum. It refuses two providers that declare the same independence group, since proving independence is the point. Credentials come from secrets; nothing is committed, and the script prints provider names, groups and transaction facts only.

It is excluded from CI by construction (a manual workflow plus a script, not a test). In this environment it is **NOT RUN**: there is no chain access and no provider credentials — `pnpm smoke:tron` exits 2 listing the missing settings. **TD-07 stays open and Phase 5 is not fully closed until this gate passes against real configured providers.** What CI does cover is the gate's configuration parsing, including its refusal of a same-group pair.

### 11.4 Cursor recovery walks the whole gap

A run now reads a **bounded window**: `[cursor − rescanOverlapBlocks, min(head, that + maxBlocksPerRun)]` (default 20,000 blocks). The cursor is advanced after the window has been processed and only across what was actually read — if a provider returned a full page for some address, the cursor stops below that block and the next run re-reads from there. A failure anywhere in the pass throws before the advance, so the cursor stays where it was and the run simply repeats.

The consequence is the one the review asked for: a worker offline for far longer than the 200-block overlap resumes at its old cursor and processes the entire missing range window by window, instead of jumping to the head and skipping everything in between. `ScanReport` now reports `windowEnd`, `cursorAt`, `truncated` and `caughtUp` so an operator can see catching-up in progress. Tested with four transfers spread over 400 blocks, a cursor 500 blocks behind and a 50-block window: the first run provably does not see the newest transfer, and repeated runs pick up all four.

### What did not change

The scanner still only detects, the verifier still decides alone, the settlement commands still do all the writing, and the scanner still never releases money to a client. No permission was added or changed. Migration 0016 is untouched.
