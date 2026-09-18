# INRP2P Exchange — Phase 4 Report (Trade state machine & settlement legs)

Status: implemented, awaiting review. Phase 5 not started.
Base: `b601a6d` (Phase 3 — requests, quotes, acceptance). Scope: `IMPLEMENTATION_PLAN.md` Phase 4 only — trade transitions T2–T10 with the hold overlay, settlement legs with both payer types, movements and their single journals, allocations, direct route payouts, `TO_EXCHANGE` route settlements, capacity consume/release, completion and margin realization, cancellation and refunds, two-person financial adjustments, exception cases and their resolutions. No TRON scanner (Phase 5) and no UI (Phase 6).

## 1. The shape of the phase in one paragraph

A **movement** is one real transfer — a `fiat_transfer` (unique UTR per rail) or a `crypto_transfer` (unique network/tx/log index) — and it posts **exactly one journal**, keyed by its own id. Legs, route settlements and allocations are readings of what that movement satisfied; none of them posts anything (FI-27). That is what makes a direct route payout safe: one payment to the client reduces the client payable and the route receivable in the same two entries, counted once in each dimension, and it cannot be recorded a second time as a "route settlement" because the movement already carries both of its allowed allocations (FI-28).

## 2. What exists

```
packages/settlement  legs (create/send/evidence/confirm/fail/cancel), the direct-payout confirm, first legs in and out,
                     route settlements (record/confirm/fail) with obligation allocation, cancellation and refunds,
                     financial adjustments, exception cases and resolutions, client/desk projections, P&L,
                     reconciliation and SLA jobs
packages/trades      + lifecycle: lockTrade, transitionTrade (T2–T10 whitelist), effective obligations, leg totals
packages/ledger      + movement journals by (payer → payee) and the `adj:{id}` compensating journal
packages/adapters    + ChainVerifier port, UnconfiguredChainVerifier; testing: FakeChainVerifier
packages/inr-accounts + refundConsumedCapacity (a failed payout returns the day's used capacity)
packages/treasury    + consumeTreasuryReservation
packages/kernel      + Phase 4 error codes
apps/worker          + settlement_sla (15 min) and settlement_reconcile (nightly) jobs
```

## 3. Migration 0015

| Area | Contents |
|---|---|
| Effective obligations | `inrp2p_trade_payout_obligation`, `inrp2p_trade_receivable_obligation`, `inrp2p_route_obligation_side` — frozen economics ⊕ posted adjustments (FI-12). The rows never change; these functions are what FI-20, FI-21, FI-61 and FI-64 measure against |
| `exception_case` | 21 types, BLOCKING/WARNING, one open case per (type, subject), append-only history; deferred trigger keeps `trade.hold` exactly equal to "has an open blocking case" (H1/H2) |
| `settlement_leg` | sides, payers, capacity/treasury/route links, `IX-…-L{n}` refs; insert guard: asset follows direction and side, a route-paid leg needs a `DIRECT_TO_CLIENT` trade on its own route (FI-65), a payout needs a confirmed client leg (D-12); deferred trigger: committed payout legs ≤ effective obligation (FI-20) |
| `fiat_transfer` / `crypto_transfer` | evidence rows; unique `(rail, upper(utr))` (FI-22) and `(network, tx_hash, log_index)` (FI-23); a crypto row may be CONFIRMED only with a `SUCCESS` receipt in a solidified block recorded by named verifiers (FI-24) |
| `route_settlement` | one movement each, bound to one obligation side at record time; `DIRECT_TO_CLIENT` can only be created confirmed and only over a route→client movement |
| `transfer_allocation` | at most one CLIENT and one ROUTE link per movement, one evidence per leg, whole-movement amounts, both dimensions only for route→client (FI-28); a mis-entered reference is voided (audited) and replaced, never edited |
| `route_settlement_allocation` | per-side allocations with a deferred total check (FI-61) and flow/side/mode rules (FI-65) |
| `financial_adjustment` | signed deltas with the margin delta derived per direction, two-person approval enforced by CHECK, posted journal id |
| Lifecycle | the Phase 3 placeholder whitelist is replaced by T2–T10; a trade may only become COMPLETED when both sides are fully confirmed and no blocking case is open (FI-21) |

Grants keep the pattern: SELECT/INSERT plus column-level UPDATE on lifecycle columns, no DELETE anywhere.

## 4. Commands

| Command | Authority | Notes |
|---|---|---|
| `fiat_in.record` / `crypto.submit_tx_for_verification` | `settlement:record_utr` / `crypto:submit_tx_for_verification` | T2. USDT is attributed **only** through the trade's open deposit assignment (D-02, FI-26); a wrong amount or an unregistered sender opens a case instead of adjusting anything |
| `settlement.confirm_incoming` | `settlement:confirm_incoming` ⧗ | T4. INR: the recorded UTR; USDT: the chain (FI-24). Confirms the leg, posts the movement journal, moves the trade to FIRST_LEG_CONFIRMED when the received total equals the effective obligation |
| `payout_leg.create` | `settlement:create_payout` | FI-20 and FI-30 checked under the trade lock; exchange INR reserves capacity; route-paid legs only in `DIRECT_TO_CLIENT` |
| `payout_leg.send` | `settlement:send_payout`, or `settlement:record_route_payout_sent` for a route-paid leg | T5; exchange INR consumes its reservation (reserved → used) |
| `payout_leg.record_evidence` | `settlement:record_utr` (+ `settlement:change_utr` ⧗ to replace) | Creates the movement and links it to the leg; a replacement voids the old link and fails the mis-entered movement |
| `payout_leg.confirm` | `settlement:confirm_payout` ⧗ | T6/T7 — §5 below |
| `payout_leg.fail` / `cancel` | `settlement:fail_payout` ⧗ / `settlement:cancel_payout` ⧗ | Failure returns the day's used capacity and opens `BANK_TRANSFER_FAILED`; cancel releases the reservation |
| `route_settlement.record` / `confirm` / `fail` | `route_settlement:record` / `route_settlement:confirm` ⧗ | Confirm posts the movement journal with the obligation dimension and allocates the side in the same transaction (FI-64); outgoing INR reserves and consumes capacity |
| `trade.cancel` | `trade:cancel` ⧗ | T9; releases capacity, treasury and the deposit address, cancels the obligation and reverses the accept journal exactly |
| `refund_leg.create` / `refund_leg.confirm` | `settlement:create_payout` / `refund:approve` ⧗✱ | Two people: the approver is never the creator |
| `exception.refund_and_cancel` | `trade:cancel` ⧗ + `exception:resolve` | T10; only when every confirmed client rupee or USDT is back and no payout completed |
| `adjustment.request` / `approve` / `reject` | `adjustment:request` / `adjustment:approve` ⧗✱ | The margin delta is derived, never supplied; approval posts `adj:{id}` and from then on the effective obligations include it |
| `exception.open` / `take` / `resolve` / `void` | `exception:open` / `exception:resolve` | Blocking cases hold the trade; resolutions that move money run their own command and pass their id to the resolution |

## 5. The direct payout, step by step

`payout_leg.confirm` on a route-paid leg, in one transaction, locking trade → route obligation → leg → movement:

1. The trade is not on hold; the leg is PROCESSING and has evidence.
2. FI-20: confirmed payouts + this amount ≤ effective payout obligation.
3. FI-61: the amount fits the obligation's route-delivers side. **This is checked before anything is written**, so a mismatch leaves nothing to undo — the command rolls back and `confirmPayout` opens `ROUTE_DIRECT_PAYOUT_MISMATCH` for FINANCE in its own transaction.
4. The movement is confirmed (INR: the UTR; USDT: the chain) and posts its single journal: Dr `CLIENT_PAYABLE` / Cr `ROUTE_RECEIVABLE`, carrying the obligation dimension.
5. The leg completes; the system creates the `DIRECT_TO_CLIENT` route settlement over the same movement, its ROUTE-dimension allocation and the obligation allocation.
6. If both sides of the client's trade are now settled, the trade completes: reservations released, deposit address to cooldown, `trade:{t}:complete` moving the **effective** margin (frozen ⊕ posted adjustments) from deferred to realized.

The canonical case in the tests is FINANCIAL_INVARIANTS §3.5 to the rupee: SELL 100,000 USDT at client ₹102.00 / route ₹104.20, one payout of ₹10,200,000 with one UTR → one movement, one journal, trade COMPLETED, ₹220,000 realized, obligation PARTIALLY_SETTLED with ₹220,000 remaining and the ledger route receivable for that obligation at exactly ₹220,000.

## 6. Interpretations and deviations for review

1. **`route_settlement.allocate` is not a separate command.** V1 obligations are PER_TRADE (D-03), so a settlement is bound to one obligation side when it is recorded and allocated by its confirm, in the same transaction that posts the journal. That is what keeps FI-64 true at every step — a journal posted without the obligation dimension would make the ledger and the obligation disagree until someone allocated it. The `route_settlement:allocate` permission stays in the matrix, unused for now; if a settlement ever needs to serve two obligations, that command is where it goes.
2. **Effective obligation sides.** FI-60 says obligation amounts never change and FI-64 says remaining equals the ledger. An approved adjustment changes the route value in the ledger, so "remaining" is computed as frozen side ⊕ posted adjustment deltas (`inrp2p_route_obligation_side`). The stored row is untouched.
3. **`fiat_in.record` uses `settlement:record_utr`.** STATE_MACHINES §3 T2 names a `settlement:record_incoming` permission that is not in the SECURITY §3 matrix; rather than invent a permission, recording a client's incoming INR reference uses `settlement:record_utr` (same operators, same risk). Flagged for review: if you want a distinct permission, it is a one-line matrix change.
4. **A failed payout returns capacity by lowering the day's `used`**, leaving its reservation CONSUMED. The money never left the account, so the day regains headroom; the reservation stays as the record of what was committed (FI-31 is about releasing the *unconsumed* remainder, which is a different path).
5. **Attachments are not implemented.** `financial_adjustment` carries `evidence_note` text instead of `evidence_attachment_ids`; the `attachment` table belongs with the operator UI (Phase 6) that uploads them.
6. **`crypto_transfer` confirmation needs a provider** (TD-05): Phase 4 implements FI-24 against the `ChainVerifier` port and ships only the unconfigured implementation plus a test fake. INR settlement is fully usable; USDT settlement waits for Phase 5.
7. **Exception severity is derived from the type** (DOMAIN_MODEL §3's "Blocking" column), not chosen by the caller, so the same situation always holds or does not hold a trade.

## 7. Exit criteria — the twelve direct-payout cases

| # | Exit test | Where | Result |
|---|---|---|---|
| 1 | Canonical: one payout, one UTR, one `fiat_transfer`, one journal (Dr CLIENT_PAYABLE / Cr ROUTE_RECEIVABLE), leg COMPLETED, trade COMPLETED, ₹220,000 realized, obligation PARTIALLY_SETTLED with ₹220,000 remaining and the same in the ledger (FI-64) | `direct-payout.int.test.ts` exit 1 | pass |
| 2 | Replaying the confirm posts and allocates nothing (same key returns the stored result; a new key is refused) | exit 2 | pass |
| 3 | The same UTR as another leg, another trade or a route settlement is rejected (FI-22) | exit 3 | pass |
| 4 | A movement cannot be allocated to a second leg or a second route settlement (FI-28) | exit 4 | pass |
| 5 | An exchange-paid movement never reduces the route obligation; a route-paid leg is refused on a `TO_EXCHANGE` trade (FI-65) | exit 5 | pass |
| 6 | A direct payout larger than the route remaining rolls back entirely and opens `ROUTE_DIRECT_PAYOUT_MISMATCH` — no leg, allocation or journal | exit 6 | pass |
| 7 | Two concurrent direct confirms exceeding the route remaining: exactly one succeeds | exit 7 | pass |
| 8 | Mixed payers (route ₹10,000,000 + exchange ₹200,000): trade COMPLETED, route remaining ₹420,000, client payable zero, ledger balanced per currency | exit 8 | pass |
| 9 | A failed direct leg posts no journal, makes no route allocation and leaves the obligation unchanged | exit 9 | pass |
| 10 | The residual is settled later by `FROM_ROUTE_TO_EXCHANGE`; the obligation is SETTLED once the USDT side is settled too, and the route balances are zero | exit 10 | pass |
| 11 | The client's view of a direct payout shows the payment and never the route | exit 11 | pass |
| 12 | Property test over random movement sequences: Σ client payable reductions = Σ CLIENT allocations, Σ route receivable reductions = Σ ROUTE allocations, every movement in exactly one journal | `properties.int.test.ts` | pass |

## 8. Exit criteria — the rest

| Exit test | Where | Result |
|---|---|---|
| Multiple INR legs and partial settlement | `settlement.int.test.ts` "settles in three legs" | pass |
| Failed leg + replacement (capacity returned and re-reserved) | "a failed leg returns its capacity…" | pass |
| Duplicate UTR | direct-payout exit 3 | pass |
| Over-allocation blocked, including concurrently | "over-allocation is blocked…" | pass |
| A cancelled trade releases capacity, the deposit address and the obligation, and reverses the accept journal | "cancelling releases capacity…" | pass |
| An adjustment preserves the original economics and posts a compensating journal | "an adjustment leaves the original economics untouched…" | pass |
| P&L counts only completed trades | "P&L counts realized margin of completed trades only" | pass |
| A trade completes while the route obligation stays OPEN (FI-62) | "FI-62 — a trade completes while its route obligation is still OPEN" | pass |
| Property test: random command sequences never violate FI-20/21/30/40 | `properties.int.test.ts` (plus FI-27, FI-28, FI-64) | pass |
| A transfer that is not solidified never confirms a payout (FI-24) | "an unsolidified or failed transfer never confirms a payout" | pass |
| Refund and cancel with a second approver (T10) | "a trade with confirmed client funds cannot be cancelled…" | pass |
| The ledger is append-only and globally balanced (FI-40, FI-41, FI-44) | "the ledger is append-only…" | pass |

## 9. Gates run locally

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | lockfile up to date, supply-chain policies pass |
| `pnpm workspace:graph` | acyclic, 20 packages |
| `pnpm versions:check` | version matrix OK; PostgreSQL 18.6 enforced by CI |
| `pnpm secret-scan` | 515 files clean |
| `pnpm lint` | clean (settlement added to the ARCHITECTURE §3 boundary map and the no-float-money rule set) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | 197 tests, 11 files |
| `pnpm test:integration` | 483 tests, 18 files (PostgreSQL 18.4 locally; CI runs 18.6) |
| `pnpm --filter @inrp2p/web build` | succeeds |

## 10. Open items carried forward

- **D-02** is still open: SELL acceptance needs a recorded custody capability, and Phase 4 changes nothing about that.
- **TD-03** (KMS keys), **TD-04** (email provider) and the new **TD-05** (TRON provider) all block a real deployment; TD-05 specifically blocks USDT settlement, while INR settlement is complete.
- Phase 5 owns: the TRON scanner and cursors, automatic detection and confirmation, suspense handling for unattributable deposits, and BUY outbound verification. The domain rules those jobs must obey are already here — they call `recordClientDeposit` and the confirm commands rather than writing rows themselves.
- Phase 6 owns: attachments, receipts, the operator queues and the client-facing screens over these projections.
