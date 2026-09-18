# INRP2P Exchange — Phase 5 Report (TRON monitoring)

Status: complete, awaiting review. Phase 6 not started.
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
                      D-05 now reads receipt.agreedBy
packages/db         + migration 0016 (chain_cursor) and its schema types
packages/kernel     + Phase 5 error codes (CHAIN_PROVIDER_ERROR and friends)
apps/worker         + chainFromEnv (two TronGrid-style endpoints + the USDT contract) and the three TRON jobs
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

`DualProviderChainVerifier` asks the primary for the facts and the secondary whether it sees exactly the same ones — hash, log index, contract, sender, destination, amount, block number, receipt status (`sameTransfer`); block *time* is provider metadata and is not compared. The receipt carries `agreedBy`, the providers that matched. `verifyCryptoTransfer` then applies the rule: at or above `dualProviderThresholdUsdt` (10,000 USDT), `agreedBy.length < 2` refuses confirmation, and the confirming row records `verified_by = agreedBy.join(',')`.

The facts are always the primary's, never a blend: a disagreeing secondary subtracts confidence, it never contributes a value. Below the threshold a single provider still settles, which is what makes an outage degrade rather than stop the desk.

## 6. What Phase 4 code changed, and why

1. **`TransferReceipt.agreedBy`** (adapters) and the D-05 check reading it (settlement). Before, the rule read `deps.chain.providers.length`, which says how many providers are *configured*. That would have confirmed a large amount on one provider's word the moment the second one lagged. This is the one semantic correction of the phase.
2. **`confirmClientLegInTx` / `revertClientLegInTx`** extracted from `confirmFirstLeg` / `revertFirstLeg`. Same bodies, no policy of their own; the operator commands are now thin wrappers, and the scanner reaches the identical code as a system job. The operator path keeps its step-up exactly as before.
3. **`revertClientLegInTx` voids the leg's allocation.** A reverted leg's evidence never satisfied anything, so leaving the link in place would have been a lie about which movement paid for what.
4. **A direct-to-treasury deposit now resolves its treasury wallet** in `recordClientDeposit`, so an unclaimed deposit straight to a treasury address can post to `SUSPENSE:UNALLOCATED` on confirmation, as STATE_MACHINES §5 says it must. Funds at an address we do not recognise at all still have no destination account and stay unposted with their case open.

No permission was added or changed: everything in this phase is either a system job or an existing operator command.

## 7. Exit criteria

`packages/scanner/test/scanner.int.test.ts` — 16 tests, real jobs against two fake TRON nodes over one fake chain.

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
| (below threshold) | 5 USDT confirms on one provider, `verified_by` naming one |
| BUY outbound verification by tx hash | not final → the operator's confirm is refused; after solidification the scanner marks the transfer CONFIRMED but leaves the leg PROCESSING; the operator's step-up confirm completes the trade |
| failed receipt | transfer FAILED, leg FAILED, trade back to awaiting, no journal |
| cursor | advances with the chain; a backwards update is refused with IX066 |

`packages/adapters/test/tron.unit.test.ts` — 11 tests: agreement naming one or both providers, facts always the primary's, `sameTransfer` field by field, an unknown transfer as `null`, an unsupported network refused, TronGrid parsing (head and solidified head, contract and block filtering), unreadable answers refused rather than guessed, and a failing or unreachable node becoming `CHAIN_PROVIDER_ERROR`.

`apps/worker/test/worker.int.test.ts` — the three jobs exist and are scheduled, and do nothing at all when no providers are configured (no cursor row, no commands); `chainFromEnv` builds one- or two-provider verifiers and refuses a contract that is not a TRON address.

Recorded testnet smoke tests are **not** included: this environment has no chain access. The provider is verified against recorded TronGrid-shaped payloads instead, and **TD-07** carries the live-endpoint smoke test as a blocker before real USDT.

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
| `pnpm versions:check` | version matrix OK (21 manifests); PostgreSQL 18.6 enforced by CI |
| `pnpm secret-scan` | 531 files clean (the TRC20 `Transfer` topic is marked as the published constant it is) |
| `pnpm lint` | clean (scanner added to the ARCHITECTURE §3 boundary map and the no-float-money rule set) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | 208 tests, 12 files (was 197/11) |
| `pnpm test:integration` | 502 tests, 19 files (was 484/18); PostgreSQL 18.4 locally, CI runs 18.6 |
| `pnpm --filter @inrp2p/web build` | succeeds |

## 10. Open items carried forward

- **TD-05 is closed**: the port has real implementations and the scanner exists. What remains is deployment configuration — endpoints, keys, the USDT contract address — and the launch checklist still carries "TRON dual provider configured; scanner lag alert tested".
- **TD-06** (backfill tooling) and **TD-07** (testnet smoke test) are new and both operational; TD-07 blocks real USDT.
- **TD-03** (KMS keys) and **TD-04** (email provider) are unchanged; **D-02** (custody capability for unique deposit addresses) is still the gate on SELL acceptance.
- Phase 6 owns the desk screens over all of this, including the USDT panel and deposit-pool status, plus attachments and receipts.
