# INRP2P Exchange — State Machines

Status: Phase 0 draft, for review.

Rules for every machine below:
- A transition happens only inside a named domain command (`ARCHITECTURE.md §4`). No UI, API, script or admin tool may write a status column directly. The app DB role has no UPDATE privilege on status columns except through the command's stored transition function (`SECURITY.md §6`).
- Every transition: locks the aggregate, validates `(from → to)` against the whitelist, writes a `*_transition` / `audit_event` row, and (if listed) a ledger journal and outbox events — in one transaction.
- **Idempotency**: every command carries an idempotency key. Replaying a completed command returns the original result. Additionally, every command is *state-idempotent*: if the aggregate is already in the target state because of the same logical event (same posting key), it returns success without side effects.
- **Failure path**: any failed precondition returns a typed domain error (`QUOTE_EXPIRED`, `INVALID_TRANSITION`, `CAPACITY_INSUFFICIENT`, …) and the transaction rolls back. Nothing partial is ever committed.
- "Perm" = required permission (`SECURITY.md §3`). "Step-up" = MFA verified within the last 10 minutes.

---

## 1. TradeRequest

```
OPEN ──quote.send──▶ QUOTED ──quote.accept──▶ ACCEPTED (terminal)
 │                    │  ▲
 │                    │  └── quote expired/rejected/cancelled → back to OPEN (desk may re-quote)
 ├─request.decline──▶ DECLINED (terminal)
 ├─request.withdraw─▶ WITHDRAWN (terminal)
 └─(no activity TTL)▶ EXPIRED (terminal, job)
```

| Transition | Who / Perm | Preconditions | Effects |
|---|---|---|---|
| create → OPEN | Client user (own client) · operator `request:create` | Client ACTIVE; destination bank/wallet ACTIVE & owned by client; amount > 0 and ≤ configured max; direction/asset/network enabled | audit `request.created`; outbox `desk.new_request` |
| OPEN → QUOTED | side effect of `quote.send` | — | — |
| QUOTED → OPEN | side effect of quote EXPIRED/REJECTED/CANCELLED(not superseded) | no other SENT quote | outbox `desk.request_needs_action` |
| OPEN/QUOTED → DECLINED | Dealer `request:decline` | not ACCEPTED | cancels SENT quote (reason `DECLINED_BY_DESK`); audit; notify client |
| OPEN/QUOTED → WITHDRAWN | Client user or operator `request:withdraw` | not ACCEPTED | cancels SENT quote; audit |
| QUOTED → ACCEPTED | side effect of `quote.accept` | — | — |
| OPEN → EXPIRED | Job | no activity for request TTL (default 24h) | audit |

Ledger: none.

---

## 2. Quote

```
DRAFT ──send──▶ SENT ──accept──▶ ACCEPTED (terminal)
  │               ├──reject───▶ REJECTED (terminal)
  │               ├──expire───▶ EXPIRED  (terminal)
  │               └──cancel───▶ CANCELLED (terminal; reasons SUPERSEDED | DECLINED_BY_DESK | WITHDRAWN | OPERATOR)
  └──discard──▶ CANCELLED
```

| Transition | Who / Perm | Preconditions | Financial side effects | Ledger | Audit | Idempotency / races | Failure path |
|---|---|---|---|---|---|---|---|
| create → DRAFT | Dealer `quote:create` | Request OPEN/QUOTED; current route snapshot exists for route+direction; route ACTIVE | System computes `quote_inr`, `route_value`, `gross_margin` from inputs (`FINANCIAL_INVARIANTS §1.3`). Dealer inputs only amount, fixed side, client rate, validity | — | `quote.created` (includes route snapshot id, margin) | key per create | `ROUTE_RATE_MISSING`, `ROUTE_INACTIVE` |
| DRAFT → SENT | Dealer `quote:send`; negative margin also `quote:send_negative_margin` + reason | DRAFT; route snapshot age ≤ max (default 15 min) else must refresh; validity within [30s, 30min]; if another SENT quote exists for request it is cancelled `SUPERSEDED` in same txn; if client rate ≠ target → `is_counter = true` | Sets `sent_at = now()`, `expires_at = now() + validity`. Economic columns become immutable (FI-03). Optionally creates `quote_link` | — | `quote.sent`, plus `quote.cancelled` for superseded | Partial unique index "one SENT per request" (FI-06) serialises concurrent sends: loser gets `CONCURRENT_QUOTE` | `ROUTE_RATE_STALE`, `NEGATIVE_MARGIN_NOT_PERMITTED` |
| SENT → ACCEPTED | Client user of the quote's client (app), or link holder passing acceptance verification (`DECISIONS D-01`) | Lock request → quote. `status = SENT`; `statement_timestamp() < expires_at`; client ACTIVE; destination bank/wallet still ACTIVE and unchanged; request not ACCEPTED | Creates Trade (§3) + `trade_economics` copied from quote; request → ACCEPTED; for SELL assigns deposit address (D-02); for BUY reserves treasury USDT (FI-33) | `trade:{t}:accept` journal | `quote.accepted`, `trade.opened` | Idempotency key from client (link page generates one per page load). FI-05 unique indexes: second accept → returns existing trade if same user+key, else `QUOTE_ALREADY_ACCEPTED`. Expiry race: both paths take `FOR UPDATE` on the quote; whichever commits first wins; expiry job requires `expires_at <= now()`, accept requires `statement_timestamp() < expires_at` — mutually exclusive by construction | `QUOTE_EXPIRED`, `DESTINATION_CHANGED` (opens nothing; client gets "Get new quote"), `DEPOSIT_ADDRESS_UNAVAILABLE`, `TREASURY_INSUFFICIENT` → acceptance fails cleanly, desk notified |
| SENT → REJECTED | Client user / link holder | SENT, not expired | request → OPEN | — | `quote.rejected` | state-idempotent | — |
| SENT → EXPIRED | Job `quote.expire` (scheduled at `expires_at` + sweeper) | Lock; `status = SENT` and `expires_at <= now()` | request → OPEN; link becomes read-only "expired" | — | `quote.expired` (actor SYSTEM) | No-op if already terminal | job retried with backoff |
| SENT → CANCELLED | Dealer `quote:cancel`; system (superseded/declined/withdrawn) | SENT | request → OPEN (unless superseded/declined) | — | `quote.cancelled` with reason | state-idempotent | — |

**Timing semantics for "accepted 1 ms before expiry":** acceptance is judged at `statement_timestamp()` of the accept transaction (the time the DB began executing the request), not when the lock was obtained. A request that reaches the database before `expires_at` and waits on a lock held by the expiry job will find the quote already EXPIRED only if the job committed first — which it cannot, because the job itself checks `expires_at <= now()`. Clock source is the DB only. The UI countdown hides the Accept button at 0 but the server decides.

---

## 3. Trade

States are direction-neutral. "First leg" = client → exchange (USDT for SELL, INR for BUY). "Payout" = exchange → client (INR for SELL, USDT for BUY).

```
                    ┌──────────── cancel (no confirmed client funds, no payout sent) ───────────┐
                    │                                                                             ▼
AWAITING_FIRST_LEG ─detect─▶ FIRST_LEG_DETECTED ─confirm─▶ FIRST_LEG_CONFIRMED ─payout sent─▶ SETTLING
        ▲                         │                                                               │
        └──── detected tx failed ─┘                                          first payout leg confirmed
                                                                                                  ▼
                                                     COMPLETED ◀── Σconfirmed = obligation ── PARTIALLY_SETTLED
                                                                                                  
Overlay: hold = true while any BLOCKING ExceptionCase is OPEN (displayed as "Exception").
CANCELLED is terminal and reachable only from AWAITING_FIRST_LEG / FIRST_LEG_DETECTED (unconfirmed) or via refund_and_cancel resolution.
```

### Deviation from the prompt's list (for review)
- `OPEN` is dropped as a persisted state: a trade is created by acceptance and is immediately awaiting the client's leg. Keeping a transient OPEN adds a transition with no business meaning.
- `EXCEPTION` is modelled as a **hold overlay** (`hold` flag + ExceptionCase records), not as a lifecycle state. Reason: a trade in exception must remember *where* it was (e.g. PARTIALLY_SETTLED with ₹4.5M paid), and several exceptions can be open at once. The UI still shows "Exception" as the primary status when `hold = true`. If you prefer a literal `EXCEPTION` state, it requires a `resume_to` column and loses parallel exceptions — see `DECISIONS.md D-04`.

### Transitions

| # | Transition | Command / Who / Perm | Preconditions | Side effects | Ledger | Audit | Idempotency | Failure |
|---|---|---|---|---|---|---|---|---|
| T1 | ∅ → AWAITING_FIRST_LEG | `quote.accept` | see Quote | trade + economics; SELL: deposit assignment; BUY: treasury reservation; outbox: client instructions, desk queue | `trade:{t}:accept` | `trade.opened` | posting key unique | whole accept rolls back |
| T2 | AWAITING_FIRST_LEG → FIRST_LEG_DETECTED | SELL: job `tron.scan` allocates a DETECTED transfer to the trade's deposit assignment. BUY: `fiat_in.record` by client (UTR submit) or SETTLEMENT_OPERATOR `settlement:record_incoming` | SELL: to = assigned address, contract = USDT. BUY: UTR unique | leg (side CLIENT_TO_EXCHANGE) PROCESSING; if amount ≠ expected → opens `USDT_WRONG_AMOUNT`/`USDT_OVERPAYMENT` (blocking); unexpected sender → `USDT_UNEXPECTED_SENDER` | none (not final) | `trade.first_leg_detected` | unique `(network, tx_hash, log_index)`; replayed events no-op | duplicate tx on another trade → `DUPLICATE_TX_HASH` exception, not allocation |
| T3 | FIRST_LEG_DETECTED → AWAITING_FIRST_LEG | job: transfer receipt FAILED / orphaned | — | leg FAILED | none | `trade.first_leg_reverted` | state-guarded | — |
| T4 | FIRST_LEG_DETECTED → FIRST_LEG_CONFIRMED | SELL: job `tron.confirm_transfer` (SYSTEM). BUY: SETTLEMENT_OPERATOR `settlement:confirm_incoming` + step-up | SELL: FI-24 all four checks; confirmed sum = client obligation (effective terms). BUY: bank credit matched, amount = obligation. No blocking exception on the first leg | leg COMPLETED; SELL: treasury observed/incoming updated. Payout becomes actionable → desk queue "Create INR payout" | SELL `crypto:{x}:confirm`; BUY `fiat_in:{f}:confirm` | `trade.first_leg_confirmed` (+ `usdt.confirmed`) | posting key; state-guarded | amount mismatch keeps state + exception |
| T5 | FIRST_LEG_CONFIRMED → SETTLING | `payout_leg.mark_sent` (first payout leg to PROCESSING) — SETTLEMENT_OPERATOR `settlement:send_payout` | First leg confirmed; not on hold; leg amount ≤ remaining unallocated obligation (FI-20); INR: reservation ACTIVE on ACTIVE account with enough reserved; BUY: treasury reservation | reservation partially consumed (used += amount at send) | none (until confirmed) | `trade.settling`, `leg.sent` | leg idempotency key | `CAPACITY_INSUFFICIENT`, `TRADE_ON_HOLD`, `OVER_ALLOCATION` |
| T6 | SETTLING → PARTIALLY_SETTLED | `payout_leg.confirm` — SETTLEMENT_OPERATOR `settlement:confirm_payout` + step-up; INR requires UTR present | Leg PROCESSING with UTR (INR) / confirmed tx (USDT, verified on-chain by job); Σconfirmed < obligation | client progress updates (`₹x / ₹y received`) | `leg:{l}:confirm` | `leg.confirmed` | posting key | `UTR_REQUIRED`, `DUPLICATE_UTR` |
| T7 | SETTLING/PARTIALLY_SETTLED → COMPLETED | Same `payout_leg.confirm` when Σconfirmed = obligation (automatic within the same command) | FI-21; no OPEN blocking exceptions | remaining reservations released; deposit assignment released (→ COOLDOWN); outbox `receipt.generate`, notify | `leg:{l}:confirm` + `trade:{t}:complete` (margin realized) | `trade.completed` | posting keys | if blocking exception open, leg confirms but trade stays PARTIALLY_SETTLED/SETTLING with hold |
| T8 | PARTIALLY_SETTLED → PARTIALLY_SETTLED | leg confirm/fail that doesn't complete | — | — | per leg | per leg | — | — |
| T9 | AWAITING_FIRST_LEG / FIRST_LEG_DETECTED(unconfirmed) → CANCELLED | `trade.cancel` — DEALER `trade:cancel` + step-up + reason; client may *request* cancellation (opens `TRADE_CANCELLATION`) | No confirmed client funds; no payout leg PROCESSING/COMPLETED | release reservations, deposit assignment, treasury reservation; detected-but-unconfirmed funds (if they later confirm) → `QUOTE_EXPIRED_WITH_FUNDS`/refund | `trade:{t}:cancel` (exact reversal of accept) | `trade.cancelled` | posting key | `FUNDS_ALREADY_RECEIVED` → must use `refund_and_cancel` |
| T10 | any non-terminal with confirmed funds → CANCELLED | `exception.resolve(refund_and_cancel)` — DEALER initiates, FINANCE approves (two-person) | Refund leg(s) COMPLETED for all confirmed client funds; no payout COMPLETED (else adjustment path) | releases all reservations | reversal of accept + refund leg journals | `trade.cancelled` | posting keys | stays in state until refunds confirm |
| H1 | hold false → true | ExceptionCase opened BLOCKING (system or operator `exception:open`) | — | queue priority "Exception" | none | `exception.opened` | unique open case per subject | — |
| H2 | hold true → false | last BLOCKING case RESOLVED/VOID via resolution command | resolution preconditions | resumes queue grouping by lifecycle state | per resolution | `exception.resolved` | state-guarded | — |

Payouts never start before first leg is FIRST_LEG_CONFIRMED (no credit extension in V1; changing this is a product decision, not a flag).

---

## 4. SettlementLeg

```
PENDING ──mark_sent (UTR optional)──▶ PROCESSING ──confirm (UTR required for INR)──▶ COMPLETED (terminal)
   │                                     │
   └──cancel──▶ CANCELLED (terminal)     └──mark_failed──▶ FAILED (terminal) ──▶ replacement = new leg
```

| Transition | Who / Perm | Preconditions | Side effects | Ledger | Audit |
|---|---|---|---|---|---|
| create → PENDING | SETTLEMENT_OPERATOR `settlement:create_payout` | Trade FIRST_LEG_CONFIRMED+ ; amount > 0; Σ(PENDING+PROCESSING+COMPLETED) + amount ≤ obligation; INR: capacity reservation exists on chosen account (created in same command if needed, FI-30) | reservation ACTIVE (reserved += amount) | none | `leg.created`, `capacity.reserved` |
| PENDING → PROCESSING | `settlement:send_payout` | account ACTIVE | `inr_account_day.used += amount`, `reserved −= amount` (consume) | none | `leg.sent` |
| add/change UTR | `settlement:record_utr`; changing an existing UTR needs step-up + reason | UTR unique (FI-22); leg PROCESSING | — | none | `utr.entered` / `utr.changed` (before/after masked) |
| PROCESSING → COMPLETED | `settlement:confirm_payout` + step-up | INR: UTR present, proof attachment recommended (configurable required above threshold); USDT: allocated crypto transfer CONFIRMED on-chain | trade progress; maybe trade COMPLETED | `leg:{l}:confirm` | `leg.confirmed` |
| PROCESSING → FAILED | `settlement:fail_payout` + reason | not COMPLETED | `used −= amount` (capacity returned for the day), opens `BANK_TRANSFER_FAILED` if trade not otherwise covered | none (nothing was posted) | `leg.failed`, `capacity.released` |
| PENDING → CANCELLED | `settlement:cancel_payout` | PENDING only | reservation released | none | `leg.cancelled` |

A leg confirmed with a different actual amount than planned is not allowed: the operator fails/cancels and records a leg of the actual amount (keeps UTR ↔ amount exact).

---

## 5. CryptoTransfer (TRON TRC20)

```
(observed in block) DETECTED ──solidified & SUCCESS & contract ok──▶ CONFIRMED
        │                      └──receipt FAILED / not found after reorg window──▶ FAILED / ORPHANED
```

Finality semantics (TRON): a block is irreversible once it is **solidified** (confirmed by ≥ 2/3 of the 27 Super Representatives; typically ~19 blocks / ~1 minute). CONFIRMED requires: block number ≤ latest solidified block (from the solidity API), `receipt.result = SUCCESS`, TRC20 `Transfer` log from the configured USDT contract, `to` = our assigned address, amount decoded from the log (not from tx input). Two independent providers must agree before CONFIRMED when amount ≥ configurable threshold (`DECISIONS D-05`).

Allocation (`crypto_transfer_allocation`) is a separate step, unique per transfer. Unallocatable transfers → `SUSPENSE:UNALLOCATED` on confirmation + exception.

---

## 6. CapacityReservation

`ACTIVE ──consume(partial)──▶ ACTIVE … ──consume(rest)──▶ CONSUMED`
`ACTIVE ──release(trade cancelled | leg cancelled | trade completed with remainder | day rollover policy)──▶ RELEASED`

All operations lock `inr_account_day` then the reservation. Day rollover: reservations are for a specific IST day; unconsumed ACTIVE reservations at day end are released by job and re-reserved for the next day only by explicit operator action (so yesterday's capacity never silently appears as today's).

---

## 7. ExceptionCase

`OPEN ──take──▶ IN_PROGRESS ──resolve(command)──▶ RESOLVED`
`OPEN/IN_PROGRESS ──void(reason: false positive / idempotent replay)──▶ VOID`

Resolution is always a named command from `DOMAIN_MODEL.md §3`; the case stores which command resolved it and links the resulting journal/adjustment ids.

---

## 8. FinancialAdjustment

`REQUESTED ──approve (different user, perm adjustment:approve, step-up)──▶ POSTED` · `REQUESTED ──reject──▶ REJECTED`

POSTED writes the compensating journal `adj:{id}`; the original `trade_economics` row is never changed. Effective obligation used by FI-20/21 = original ⊕ posted adjustments.

---

## 9. Matrix summary

| Machine | States | Terminal | Driven by system | Driven by humans |
|---|---|---|---|---|
| TradeRequest | OPEN, QUOTED, ACCEPTED, DECLINED, WITHDRAWN, EXPIRED | 4 | expiry | create, decline, withdraw |
| Quote | DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED, CANCELLED | 4 | expiry, supersede | create, send, accept, reject, cancel |
| Trade | AWAITING_FIRST_LEG, FIRST_LEG_DETECTED, FIRST_LEG_CONFIRMED, SETTLING, PARTIALLY_SETTLED, COMPLETED, CANCELLED (+hold) | 2 | USDT detect/confirm, completion | INR confirm, payouts, cancel, exceptions |
| SettlementLeg | PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED | 3 | USDT on-chain verification | create, send, UTR, confirm, fail, cancel |
| CryptoTransfer | DETECTED, CONFIRMED, FAILED, ORPHANED | 3 | all | submit tx hash for lookup |
| CapacityReservation | ACTIVE, CONSUMED, RELEASED | 2 | release on cancel/complete/day end | reserve |
| ExceptionCase | OPEN, IN_PROGRESS, RESOLVED, VOID | 2 | detection | take, resolve, void |
| FinancialAdjustment | REQUESTED, POSTED, REJECTED | 2 | — | request, approve, reject |
