# INRP2P Exchange — State Machines

Status: Phase 0, revision 3 (`DECISIONS.md` Revision 3).

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
| QUOTED → ACCEPTED | side effect of `quote.accept` or `quote.accept_via_link` | — | — |
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
| DRAFT → SENT | Dealer `quote:send`; negative margin also `quote:send_negative_margin` + reason | DRAFT; route snapshot age ≤ max (default 15 min) else must refresh; validity within [30s, 30min] for in-app quotes; quotes with a shareable link default to 180s and require ≥ 120s (a link can be attached later only while ≥ 120s remain); OTP never extends expiry (D-01); if another SENT quote exists for request it is cancelled `SUPERSEDED` in same txn; if client rate ≠ target → `is_counter = true` | Sets `sent_at = now()`, `expires_at = now() + validity`. Economic columns become immutable (FI-03). Optionally creates `quote_link` | — | `quote.sent`, plus `quote.cancelled` for superseded | Partial unique index "one SENT per request" (FI-06) serialises concurrent sends: loser gets `CONCURRENT_QUOTE` | `ROUTE_RATE_STALE`, `NEGATIVE_MARGIN_NOT_PERMITTED` |
| SENT → ACCEPTED | `quote.accept` (in-app): authenticated client user of the quote's client with `can_accept_quotes` | Lock request → quote. `status = SENT`; client `kyc_status` permits trading (when policy enabled); `statement_timestamp() < expires_at`; client ACTIVE; destination bank/wallet still ACTIVE and unchanged; request not ACCEPTED | Creates Trade (§3) + `trade_economics` copied from quote; request → ACCEPTED; creates `route_obligation` (OPEN) with frozen route economics and execution mode (D-03, D-14); for SELL allocates a unique deposit address via `CustodyAdapter` and creates the deposit assignment (D-02); for BUY in `TO_EXCHANGE` mode reserves treasury USDT (FI-33; none in `DIRECT_TO_CLIENT`, where the route delivers USDT to the client) | `trade:{t}:accept` journal | `quote.accepted`, `trade.opened` | Idempotency key per accept intent. FI-05 unique indexes: second accept → returns existing trade if same user+key, else `QUOTE_ALREADY_ACCEPTED`. Expiry race: both paths take `FOR UPDATE` on the quote; whichever commits first wins; expiry job requires `expires_at <= now()`, accept requires `statement_timestamp() < expires_at` — mutually exclusive by construction | `QUOTE_EXPIRED`, `DESTINATION_CHANGED` (opens nothing; client gets "Get new quote"), `DEPOSIT_ADDRESS_UNAVAILABLE`, `TREASURY_INSUFFICIENT` → acceptance fails cleanly, desk notified |
| SENT → ACCEPTED (link) | `quote.accept_via_link`: link holder submitting a valid OTP for a `PENDING` acceptance challenge of this quote (D-01). Viewing the link alone can never reach this row | Lock request → quote → challenge. Everything required for in-app acceptance, plus: challenge `PENDING`, bound to this quote, `statement_timestamp() < challenge.expires_at`, attempts < 5, code hash matches, challenge's client user still ACTIVE with `can_accept_quotes` and verified email | Same as in-app acceptance; challenge → CONSUMED; quote records `accepted_via = LINK`, `accepted_by_user_id`, `acceptance_challenge_id` | `trade:{t}:accept` journal | `acceptance_otp.verified`, `quote.accepted`, `trade.opened` | Unique `quote.acceptance_challenge_id`; consumed challenge cannot be replayed; idempotency key per accept intent. Wrong code increments attempts in a separate committed step (the accept itself rolls back) | `OTP_INVALID` / `OTP_EXPIRED` / `OTP_ATTEMPTS_EXCEEDED` (uniform message), `QUOTE_EXPIRED` (OTP time never extends quote validity), plus all in-app failures |
| SENT → REJECTED | `quote.reject` by an authenticated client user with `can_accept_quotes` (app), or `quote.reject_via_link` with a valid OTP challenge (consumed). The unauthenticated "Decline" on a link page is a local UI dismissal and **never** reaches this row | SENT, not expired; same actor checks as acceptance | request → OPEN | — | `quote.rejected` | state-idempotent; challenge single-use | `OTP_INVALID` etc. |
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
"Payout" legs may be paid by an exchange account or, in DIRECT_TO_CLIENT mode, by the route (§4).
```

### Resolved deviations from the prompt's list (`DECISIONS.md D-04`, `D-13`)
- `OPEN` is dropped as a persisted state: a trade is created by acceptance and is immediately awaiting the client's leg. Approved.
- `EXCEPTION` is modelled as a **hold overlay** (`hold` flag + ExceptionCase records), not as a lifecycle state. Reason: a trade in exception must remember *where* it was (e.g. PARTIALLY_SETTLED with ₹4.5M paid), and several exceptions can be open at once. The UI still shows "Exception" as the primary status when `hold = true`. Approved.

### Transitions

| # | Transition | Command / Who / Perm | Preconditions | Side effects | Ledger | Audit | Idempotency | Failure |
|---|---|---|---|---|---|---|---|---|
| T1 | ∅ → AWAITING_FIRST_LEG | `quote.accept` | see Quote | trade + economics (incl. frozen `route_execution_mode`); route obligation `OPEN`; SELL: unique deposit address assignment (acceptance fails with `DEPOSIT_ADDRESS_UNAVAILABLE` if none); BUY: treasury reservation only in `TO_EXCHANGE` mode; outbox: client instructions, desk queue | `trade:{t}:accept` | `trade.opened` | posting key unique | whole accept rolls back |
| T2 | AWAITING_FIRST_LEG → FIRST_LEG_DETECTED | SELL: job `tron.scan` allocates a DETECTED transfer to the trade's deposit assignment. BUY: `fiat_in.record` by client (UTR submit) or SETTLEMENT_OPERATOR `settlement:record_incoming` | SELL: to = assigned address, contract = USDT. BUY: UTR unique | leg (side CLIENT_TO_EXCHANGE) PROCESSING; if amount ≠ expected → opens `USDT_WRONG_AMOUNT`/`USDT_OVERPAYMENT` (blocking); unexpected sender → `USDT_UNEXPECTED_SENDER` | none (not final) | `trade.first_leg_detected` | unique `(network, tx_hash, log_index)`; replayed events no-op | duplicate tx on another trade → `DUPLICATE_TX_HASH` exception, not allocation |
| T3 | FIRST_LEG_DETECTED → AWAITING_FIRST_LEG | job: transfer receipt FAILED / orphaned | — | leg FAILED | none | `trade.first_leg_reverted` | state-guarded | — |
| T4 | FIRST_LEG_DETECTED → FIRST_LEG_CONFIRMED | SELL: job `tron.confirm_transfer` (SYSTEM). BUY: SETTLEMENT_OPERATOR `settlement:confirm_incoming` + step-up | SELL: FI-24 all four checks; confirmed sum = client obligation (effective terms). BUY: bank credit matched, amount = obligation. No blocking exception on the first leg | leg COMPLETED; SELL: treasury observed/incoming updated. Payout becomes actionable → desk queue "Create INR payout" | SELL `crypto:{x}:confirm`; BUY `fiat:{f}:confirm` | `trade.first_leg_confirmed` (+ `usdt.confirmed`) | posting key; state-guarded | amount mismatch keeps state + exception; while another part of the client's funds is still detected-not-confirmed the total is not judged yet (a client may pay in several transfers) |
| T5 | FIRST_LEG_CONFIRMED → SETTLING | first payout leg → PROCESSING (§4), any payer | First leg confirmed; not on hold; leg amount ≤ remaining unallocated obligation (FI-20); `EXCHANGE_ACCOUNT` INR: reservation ACTIVE on ACTIVE account; `EXCHANGE_ACCOUNT` USDT: treasury reservation; `ROUTE`: mode `DIRECT_TO_CLIENT` | `EXCHANGE_ACCOUNT` INR: reservation consumed | none (until confirmed) | `trade.settling`, `leg.sent` | leg idempotency key | `CAPACITY_INSUFFICIENT`, `TRADE_ON_HOLD`, `OVER_ALLOCATION` |
| T6 | SETTLING → PARTIALLY_SETTLED | `payout_leg.confirm` (§4) — SETTLEMENT_OPERATOR `settlement:confirm_payout` + step-up | Leg PROCESSING with evidence; Σconfirmed < obligation | client progress updates (`₹x / ₹y received`); direct legs also allocate to the route obligation in the same txn | one movement journal (`fiat:{f}:confirm` / `crypto:{x}:confirm`) | `leg.confirmed` | movement posting key | `UTR_REQUIRED`, `DUPLICATE_UTR` |
| T7 | SETTLING/PARTIALLY_SETTLED → COMPLETED | Same `payout_leg.confirm` when Σconfirmed = obligation (automatic within the same command) | FI-21; no OPEN blocking exceptions | remaining reservations released; deposit assignment released (address → COOLDOWN); outbox `receipt.generate`, notify. Completion never depends on route obligation state (a residual such as ₹220,000 may remain open) | movement journal + `trade:{t}:complete` (Dr DEFERRED_MARGIN / Cr GROSS_MARGIN) | `trade.completed` | posting keys | if blocking exception open, leg confirms but trade stays PARTIALLY_SETTLED/SETTLING with hold |
| T8 | PARTIALLY_SETTLED → PARTIALLY_SETTLED | leg confirm/fail that doesn't complete | — | — | per leg | per leg | — | — |
| T9 | AWAITING_FIRST_LEG / FIRST_LEG_DETECTED(unconfirmed) → CANCELLED | `trade.cancel` — DEALER `trade:cancel` + step-up + reason; client may *request* cancellation (opens `TRADE_CANCELLATION`) | No confirmed client funds; no payout leg PROCESSING/COMPLETED; no recorded client INR payment still unconfirmed (`INCOMING_FIAT_UNCONFIRMED`: the desk confirms it or marks it not received — `revertFirstLeg`, which closes the transfer FAILED — first) | release reservations, deposit assignment (address → COOLDOWN), treasury reservation; route obligation → CANCELLED; a detected-but-unconfirmed client transfer is detached (leg FAILED, allocation voided) and becomes `FUNDS_AFTER_TRADE_CLOSED` at once, and parks in suspense if it later confirms; funds that later arrive at that address → `FUNDS_AFTER_TRADE_CLOSED` | `trade:{t}:cancel` (exact reversal of accept) + `adj:{id}:cancel` (exact reversal of each posted adjustment) | `trade.cancelled` | posting key | `FUNDS_ALREADY_RECEIVED` → must use `refund_and_cancel` |
| T10 | any non-terminal with confirmed funds → CANCELLED | `exception.resolve(refund_and_cancel)` — DEALER initiates, FINANCE approves (two-person) | Refund leg(s) COMPLETED for all confirmed client funds; no payout PROCESSING or COMPLETED (else adjustment path); no recorded client INR payment still unconfirmed | releases all reservations; PENDING legs cancelled | refund movement journals + `trade:{t}:cancel` + `adj:{id}:cancel` | `trade.cancelled` | posting keys | stays in state until refunds confirm |
| H1 | hold false → true | ExceptionCase opened BLOCKING (system or operator `exception:open`) | — | queue priority "Exception" | none | `exception.opened` | unique open case per subject | — |
| H2 | hold true → false | last BLOCKING case RESOLVED/VOID via resolution command | resolution preconditions | resumes queue grouping by lifecycle state | per resolution | `exception.resolved` | state-guarded | — |

Payouts never start before first leg is FIRST_LEG_CONFIRMED (no credit extension in V1; changing this is a product decision, not a flag).

### Advancing without a movement (`advanceTrade`)
Movements advance a trade inside the command that confirms them. A trade can also become settled with no new movement, and then it advances in the command that made it so, under the same predicates (FI-21):
- the last BLOCKING case is resolved or voided (H2) — e.g. `await_top_up` after the top-up already confirmed: FIRST_LEG_DETECTED → FIRST_LEG_CONFIRMED when no client leg is still PROCESSING and the confirmed total equals the effective receivable;
- an adjustment is approved (§8) that brings the effective terms to what was already received or paid — `adjust_trade_to_received`, or a write-off of an unpaid remainder: → FIRST_LEG_CONFIRMED, or SETTLING/PARTIALLY_SETTLED → COMPLETED (T7, with its `trade:{t}:complete` journal and receipt).

A client deposit is judged against what is still **outstanding** (effective receivable − client legs already detected or confirmed), so a top-up of exactly the shortfall is not itself a wrong amount, and a repeat of a completed deposit is an overpayment. A deposit that confirms after the first leg was decided posts its movement journal and opens the case; it never moves the trade.

Refund legs that are planned, in flight or done together never exceed the confirmed client funds (FI-25; a second refund is refused while one is planned, and the database re-checks it at commit, IX025). A trade pays out **or** refunds, never both at once (FI-25): a planned or completed refund stops payout creation, sending and confirmation; a payout that is PROCESSING or COMPLETED stops refund creation, confirmation and `refund_and_cancel`.

---

## 4. SettlementLeg

```
PENDING ──mark_sent (evidence optional)──▶ PROCESSING ──confirm (evidence required)──▶ COMPLETED (terminal)
   │                                          │
   └──cancel──▶ CANCELLED (terminal)          └──mark_failed──▶ FAILED (terminal) ──▶ replacement = new leg
```

Every payout leg has a **payer**:
- `EXCHANGE_ACCOUNT` — INR from an exchange INR settlement account (capacity reservation required) or USDT from a treasury wallet.
- `ROUTE` — the liquidity route pays the client directly (`DIRECT_TO_CLIENT`). No exchange INR capacity is reserved or consumed. Allowed only when the trade's frozen `route_execution_mode = DIRECT_TO_CLIENT` (FI-65). A trade may mix both payer types (e.g. route pays ₹10,000,000 directly, exchange account tops up ₹200,000).

Evidence is one `fiat_transfer` (INR, unique UTR) or one confirmed `crypto_transfer` (USDT), linked through `transfer_allocation` (dimension `CLIENT`). The leg amount equals the evidence amount.

| Transition | Who / Perm | Preconditions | Side effects | Ledger | Audit |
|---|---|---|---|---|---|
| create → PENDING | SETTLEMENT_OPERATOR `settlement:create_payout` | Trade FIRST_LEG_CONFIRMED+ (D-12 applies to both payer types); amount > 0; Σ(PENDING+PROCESSING+COMPLETED) + amount ≤ client obligation (FI-20). `EXCHANGE_ACCOUNT` INR: capacity reservation on chosen account (FI-30). `ROUTE`: trade route mode `DIRECT_TO_CLIENT`; route ACTIVE | `EXCHANGE_ACCOUNT` INR: reservation ACTIVE | none | `leg.created` (+ `capacity.reserved`) |
| PENDING → PROCESSING | `settlement:send_payout` (`EXCHANGE_ACCOUNT`) · `settlement:record_route_payout_sent` (`ROUTE`, when route reports sent) | `EXCHANGE_ACCOUNT`: account ACTIVE | `EXCHANGE_ACCOUNT` INR: `used += amount`, `reserved −= amount` | none | `leg.sent` |
| add/change UTR / tx hash | `settlement:record_utr`; change needs step-up + reason | UTR unique across **all** fiat transfers (FI-22), so the same UTR cannot also be recorded as a route settlement or another leg | creates/updates `fiat_transfer` (status RECORDED) with payer/payee | none | `utr.entered` / `utr.changed` |
| PROCESSING → COMPLETED (`EXCHANGE_ACCOUNT`) | `payout_leg.confirm` — `settlement:confirm_payout` + step-up | INR: UTR present; USDT: crypto transfer CONFIRMED on-chain | movement CONFIRMED; trade progress; maybe trade COMPLETED (T7) | `fiat:{f}:confirm` or `crypto:{x}:confirm` — Dr CLIENT_PAYABLE / Cr INR_SETTLEMENT or TREASURY_USDT | `leg.confirmed` |
| PROCESSING → COMPLETED (`ROUTE`, direct) | `payout_leg.confirm` — `settlement:confirm_payout` + step-up. The operator needs no route permission: the route allocation is system-computed | Lock order trade → route_obligation → leg → movement. UTR/tx present; movement amount ≤ client remaining (FI-20) **and** ≤ route obligation remaining on the route-delivers side (FI-61); movement not already linked in either dimension (FI-28) | **In one transaction:** movement CONFIRMED; leg COMPLETED (`transfer_allocation` dimension CLIENT); system creates `route_settlement` (flow `DIRECT_TO_CLIENT`, CONFIRMED, same movement) + `transfer_allocation` dimension ROUTE + `route_settlement_allocation` to the trade's obligation; obligation → PARTIALLY_SETTLED/SETTLED; maybe trade COMPLETED (T7) | **exactly one** journal `fiat:{f}:confirm` (or `crypto:{x}:confirm`) — Dr CLIENT_PAYABLE / Cr ROUTE_RECEIVABLE | `leg.confirmed`, `route_settlement.confirmed` (actor SYSTEM, same correlation id) |
| PROCESSING → FAILED | `settlement:fail_payout` + reason | not COMPLETED | movement FAILED; `EXCHANGE_ACCOUNT` INR: `used −= amount`; opens `BANK_TRANSFER_FAILED` | none | `leg.failed` |
| PENDING → CANCELLED | `settlement:cancel_payout` | PENDING only | reservation released (`EXCHANGE_ACCOUNT`) | none | `leg.cancelled` |

Failure of the direct confirm (route remaining too small, route mismatch) rolls back everything — no leg completion without the route allocation, and no route allocation without the leg — and opens `ROUTE_DIRECT_PAYOUT_MISMATCH` for FINANCE.

A leg confirmed with a different actual amount than planned is not allowed: fail/cancel and record a leg of the actual amount (keeps UTR ↔ amount exact).

---

## 5. CryptoTransfer (TRON TRC20)

```
(observed in block) DETECTED ──solidified & SUCCESS & contract ok──▶ CONFIRMED
        │                      └──receipt FAILED / not found after reorg window──▶ FAILED / ORPHANED
```

Finality semantics (TRON): a block is irreversible once it is **solidified** (confirmed by ≥ 2/3 of the 27 Super Representatives; typically ~19 blocks / ~1 minute). CONFIRMED requires: block number ≤ latest solidified block (from the solidity API), `receipt.result = SUCCESS`, TRC20 `Transfer` log from the configured USDT contract, `to` = the expected destination (assigned deposit address, treasury wallet, route address, or client wallet for USDT payouts), amount decoded from the log (not from tx input). Two independent providers must agree before CONFIRMED when amount ≥ configurable threshold (`DECISIONS D-05`).

Allocation (`transfer_allocation`) is a separate step: at most one CLIENT-dimension and one ROUTE-dimension link per transfer (FI-28). Client deposits are allocated **only** via the open deposit assignment of the destination address (D-02); there is no amount- or sender-based matching. Transfers to an address in COOLDOWN → `FUNDS_AFTER_TRADE_CLOSED`; to a never-assigned address or treasury wallet directly → `UNALLOCATED_DEPOSIT`. Both post to `SUSPENSE:UNALLOCATED` on confirmation. Route settlement USDT transfers are linked to a `route_settlement` (§10); a route→client USDT transfer is linked to both a payout leg and a `DIRECT_TO_CLIENT` route settlement by the direct confirm command (§4).

### Who drives it (Phase 5 scanner)

| Job | Reads | Writes |
|---|---|---|
| `tron_scan` | TRC20 transfers into **every** watched address (assigned **and** cooled-down deposit addresses, active treasury wallets) on every run — the cursor is global, so a run that read only some addresses would move it past blocks it never read for the others — from `chain_cursor.last_scanned_block` minus the rescan overlap | DETECTED transfers, their CLIENT allocation and client leg when an open deposit assignment claims them, the detection cases above, and the cursor |
| `tron_confirm` | every DETECTED transfer, through the `ChainVerifier` | CONFIRMED (T4 client leg completed with its one journal), FAILED (client leg reverted, trade back to `AWAITING_FIRST_LEG`), suspense posting for an unclaimed transfer, `RECONCILIATION_MISMATCH` for a transfer whose leg had been failed or cancelled, `TX_NOT_FINAL` once a transfer has been pending longer than the configured age |
| `tron_orphan_sweep` | DETECTED transfers the providers no longer report | ORPHANED, client leg FAILED, its allocation voided, trade back to `AWAITING_FIRST_LEG` (T3) |

Three rules bound what the scanner may do. Detection never confirms: only the verifier's answer moves a transfer to CONFIRMED, and above the D-05 threshold that answer must carry **two independent sources** — `TransferReceipt.agreedGroups`, the distinct independence groups among the providers that returned identical facts, not merely two provider names (`agreedBy` records those for the audit trail). A lagging or disagreeing second provider therefore blocks confirmation rather than being ignored, and two adapters pointed at the same vendor or node count once however they are named. A refusal is typed (`INSUFFICIENT_PROVIDER_QUORUM`, `NOT_SOLIDIFIED`, `RECEIPT_FAILED`, …), so the desk sees why rather than a generic failure. Detection never attributes by amount or sender: the destination's open deposit assignment is the only link, and a mismatch in amount or sender becomes a case beside the transfer, never a silent adjustment. The scanner never releases money to a client: a confirmed **outbound** payout transfer is only verified, and completing that leg stays a step-up operator command (§4).

A confirmed transfer sat in a solidified block, which is irreversible, so only DETECTED transfers are ever orphaned; a CONFIRMED one going missing is a reconciliation case for a human.

`chain_cursor` moves forward only (`IX066`). Each run reads a window that starts at the cursor minus the rescan overlap (reorg tolerance) and is at most `maxBlocksPerRun` wide, and the cursor is advanced **after** that window has been processed, only as far as was actually read: if a provider returned a full page for some address, the cursor stops below the truncation point. A worker that was offline for a week therefore walks the whole gap window by window — it never jumps to the head and leaves the blocks in between unscanned — and a failure part-way through leaves the cursor untouched, so the run simply repeats. Re-reading costs nothing: `(network, tx_hash, log_index)` makes re-detection idempotent (FI-23), and losing the cursor entirely costs a rescan. Reaching *back* beyond the cursor (a historical import, an address added with old funds) is deliberate backfill tooling, not a rewind (TECH_DEBT TD-06).

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

The deltas are checked at request (early answer) and again at approval, under the trade → route obligation locks, against the effective terms **including every adjustment already posted**: the trade is not CANCELLED; a COMPLETED trade may change only its route side and margin (its client terms are settled); the payout obligation stays positive and ≥ committed payout legs (FI-20); the receivable stays positive and ≥ confirmed client funds; each route side stays ≥ what was already allocated to it (FI-61), and a SETTLED obligation is not re-opened. After posting, an obligation whose sides now have nothing left becomes SETTLED, and the trade advances if it is now settled (§3 "Advancing without a movement"). Cancelling a trade reverses every posted adjustment (`adj:{id}:cancel`) together with the acceptance.

---

## 9. RouteObligation (`PER_TRADE` in V1, `DECISIONS.md D-03`)

`OPEN ──allocation (partial)──▶ PARTIALLY_SETTLED ──both sides fully allocated──▶ SETTLED`
`OPEN ──trade.cancel / refund_and_cancel (no net allocations)──▶ CANCELLED`

Created at acceptance with the trade's frozen route economics and execution mode, and recognized in the ledger by `trade:{t}:accept`. Two sides: *route delivers* (SELL: INR; BUY: USDT) and *exchange delivers* (SELL: USDT; BUY: INR).

| Transition | Who | Preconditions | Ledger | Audit |
|---|---|---|---|---|
| create → OPEN | `quote.accept` / `quote.accept_via_link` | route `PER_TRADE`, mode frozen from route | part of `trade:{t}:accept` | `route_obligation.created` |
| OPEN/PARTIALLY_SETTLED → PARTIALLY_SETTLED/SETTLED | (a) direct payout confirm (system, §4); (b) `route_settlement.confirm` — FINANCE/OWNER ⧗, which allocates the obligation side the settlement was recorded against, in the same transaction that posts the movement journal | allocation ≤ side remaining (FI-61); settlement CONFIRMED; movement allowed for mode (FI-65) | none here — the movement journal already posted once (FI-27) | `route_settlement.allocated` |

V1 has **no separate allocation step**: `PER_TRADE` settlements name their obligation side when recorded, and confirmation posts the journal (carrying the `route_obligation_id` dimension) and writes the allocation atomically. A post-confirm allocation would leave the journal undimensioned in between, so obligation remaining and ledger balance would disagree — a temporary FI-64 violation. If a later settlement model needs one settlement to serve several obligations, that command arrives with it.
| OPEN → CANCELLED | trade cancellation | trade CANCELLED; no net allocations | part of `trade:{t}:cancel` | `route_obligation.cancelled` |

Residuals (e.g. ₹220,000 after a ₹10,200,000 direct payout) stay OPEN/PARTIALLY_SETTLED until a `TO_EXCHANGE` route settlement or an approved financial adjustment covers them. The client trade never reads obligation state (FI-62).

## 10. RouteSettlement

`RECORDED ──confirm──▶ CONFIRMED` · `RECORDED ──fail──▶ FAILED`

Flows: `FROM_ROUTE_TO_EXCHANGE` (route → exchange account / treasury), `TO_ROUTE` (exchange → route), `DIRECT_TO_CLIENT` (route → client; **system-created only** by the direct payout confirm in §4 — it cannot be recorded independently). Each route settlement references exactly one movement; its amount is the movement amount.

| Transition | Who | Preconditions | Side effects | Ledger | Audit |
|---|---|---|---|---|---|
| create → RECORDED (`FROM_ROUTE_TO_EXCHANGE`, `TO_ROUTE`) | `route_settlement.record` — FINANCE/OWNER | route ACTIVE; **one route obligation and side named at record time** (V1 is `PER_TRADE`), amount ≤ that side's remaining; flow valid for mode; outgoing INR: capacity reservation (`purpose = ROUTE_SETTLEMENT`); movement evidence unique (FI-22/23) and not linked in ROUTE dimension (FI-28) | movement RECORDED | none | `route_settlement.recorded` |
| RECORDED → CONFIRMED | `route_settlement.confirm` — FINANCE/OWNER ⧗ | INR: UTR present; USDT: on-chain CONFIRMED (destination = route's registered address for `TO_ROUTE`, treasury wallet for `FROM_ROUTE_TO_EXCHANGE`) | movement CONFIRMED; capacity consumed (INR out); **the obligation side named at record time is allocated in the same transaction** | one movement journal (`fiat:{f}:confirm` / `crypto:{x}:confirm`, §3.4 of FINANCIAL_INVARIANTS), carrying the obligation dimension so FI-64 holds at every step | `route_settlement.confirmed`, `route_settlement.allocated` |
| create+confirm (`DIRECT_TO_CLIENT`) | system, inside `payout_leg.confirm` | §4 | — | the leg's single movement journal | `route_settlement.confirmed` |
| RECORDED → FAILED | `route_settlement.fail` ⧗ + reason | not CONFIRMED | movement FAILED; reservation released | none | `route_settlement.failed` |

## 11. DepositAddress (`DECISIONS.md D-02`)

`AVAILABLE ──assign (quote accept, SELL)──▶ ASSIGNED ──trade terminal──▶ COOLDOWN ──cooldown elapsed (POOL mode)──▶ AVAILABLE`
`COOLDOWN ──(DERIVED mode, default) / operator retire──▶ RETIRED`

- Assignment happens only through `CustodyAdapter.allocateDepositAddress` inside the acceptance transaction (DERIVED mode inserts a new address row; POOL mode locks an AVAILABLE row with `FOR UPDATE SKIP LOCKED`).
- Partial unique index: at most one open `deposit_assignment` per address; unique `deposit_assignment.trade_id`.
- If `custody_provider_config.deposit_address_capability = UNSUPPORTED`, SELL acceptance is disabled system-wide and the desk sees the limitation; no fallback attribution exists.

## 12. AcceptanceChallenge (`DECISIONS.md D-01`)

`PENDING ──correct code + quote accepted or rejected (same txn)──▶ CONSUMED`
`PENDING ──5 wrong attempts──▶ FAILED` · `PENDING ──time > expires_at──▶ EXPIRED` · `PENDING ──new code requested──▶ SUPERSEDED`

| Transition | Who | Preconditions | Effects | Audit |
|---|---|---|---|---|
| create → PENDING | link holder `quote_link.request_otp` (rate-limited) | quote SENT and not expired; recipient is an authorized client user of the quote's client with verified email; send limits (3 / quote / 10 min) | previous PENDING for same user → SUPERSEDED; `expires_at = least(now()+5 min, quote.expires_at)`; outbox `notification.send` (email OTP) | `acceptance_otp.sent` |
| PENDING → CONSUMED | `quote.accept_via_link` or `quote.reject_via_link` | see Quote §2 | quote ACCEPTED or REJECTED | `acceptance_otp.verified` |
| PENDING → FAILED | wrong code #5 | — | link shows "Request a new code" while quote still valid | `acceptance_otp.failed` |
| PENDING → EXPIRED | lazily on verify, or sweeper | — | — | — |

## 13. Matrix summary

| Machine | States | Terminal | Driven by system | Driven by humans |
|---|---|---|---|---|
| TradeRequest | OPEN, QUOTED, ACCEPTED, DECLINED, WITHDRAWN, EXPIRED | 4 | expiry | create, decline, withdraw |
| Quote | DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED, CANCELLED | 4 | expiry, supersede | create, send, accept / reject (authenticated app or OTP-verified link), cancel |
| AcceptanceChallenge | PENDING, CONSUMED, FAILED, EXPIRED, SUPERSEDED | 4 | expiry | request code, verify (accept or reject) |
| Trade | AWAITING_FIRST_LEG, FIRST_LEG_DETECTED, FIRST_LEG_CONFIRMED, SETTLING, PARTIALLY_SETTLED, COMPLETED, CANCELLED (+hold) | 2 | USDT detect/confirm, completion | INR confirm, payouts, cancel, exceptions |
| SettlementLeg (payer EXCHANGE_ACCOUNT or ROUTE) | PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED | 3 | USDT on-chain verification; route allocation on direct confirm | create, send, UTR, confirm, fail, cancel |
| CryptoTransfer | DETECTED, CONFIRMED, FAILED, ORPHANED | 3 | all | submit tx hash for lookup |
| CapacityReservation | ACTIVE, CONSUMED, RELEASED | 2 | release on cancel/complete/day end | reserve |
| ExceptionCase | OPEN, IN_PROGRESS, RESOLVED, VOID | 2 | detection | take, resolve, void |
| FinancialAdjustment | REQUESTED, POSTED, REJECTED | 2 | — | request, approve, reject |
| RouteObligation | OPEN, PARTIALLY_SETTLED, SETTLED, CANCELLED | 2 | create on accept, direct-payout allocation, cancel with trade | allocate |
| RouteSettlement (FROM_ROUTE_TO_EXCHANGE, TO_ROUTE, DIRECT_TO_CLIENT) | RECORDED, CONFIRMED, FAILED | 2 | DIRECT_TO_CLIENT created by leg confirm; on-chain verification | record, confirm, fail |
| DepositAddress | AVAILABLE, ASSIGNED, COOLDOWN, RETIRED | 1 | assign on accept, cooldown, release | retire |
