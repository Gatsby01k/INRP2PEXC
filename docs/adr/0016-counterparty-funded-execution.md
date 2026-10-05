# ADR 0016 — Counterparty-funded `PER_TRADE` execution (trader liquidity, no platform advance)

Status: **Accepted** — owner decision of 2026-10-04 (production task, §1.1). Decision record `DECISIONS.md D-16`.
Supersedes the part of D-14/FI-33 that made the exchange's own treasury the default source of a `TO_EXCHANGE`
payout. Does **not** change `PER_TRADE` (D-03), the two execution modes (D-14), attribution by address (D-02) or the
one-movement-one-journal rule (FI-27).

## 1. Context

The owner's business model: clients sell USDT for INR or buy USDT with INR; **traders fund the counter-side of every
client exchange** (INR for a client selling USDT, USDT for a client buying it); the client's own funds pay for what
the client receives; the desk operates, verifies, resolves exceptions and reconciles. The platform's own working
USDT/INR may be zero when a trade is created and accepted.

The code at `d0cc778` advances platform money in three places:

| # | Where | What happens today | Why it is own-capital |
|---|---|---|---|
| P1 | `quotes/acceptance.ts` → `treasury/reservations.ts reserveTreasuryUsdt` | BUY on a `TO_EXCHANGE` route reserves treasury USDT **at acceptance**, before the trader delivered anything; with no treasury USDT acceptance fails `TREASURY_INSUFFICIENT` | The client's USDT is promised out of the exchange's own wallet |
| P2 | `settlement/legs.ts createPayoutLeg` / `sendPayoutLeg` / `confirm.ts` (+ DB IX048) | A client payout needs only the client's first leg confirmed (D-12); nothing checks that the counterparty delivered | The exchange pays the client from its own INR account / HOT wallet and waits for the trader afterwards |
| P3 | `settlement/routesettlements.ts recordRouteSettlementInTx` (`TO_ROUTE`) | The exchange's delivery to the route/trader is checked only against the obligation remaining | The exchange can pay the trader before the client funded the trade, or from another trade's funds |

In addition, nothing in production ever writes `treasury_wallet.observed_balance_minor` (only fixtures do), so
FI-33's `reserved ≤ observed` compares against a number nobody observes, and a sent payout that only lowered
`reserved` looks available again (B2).

## 2. Decision

1. **Funding is a fact of the trade, not of the route.** Every trade carries an insert-once funding model in
   `trade_funding`: `COUNTERPARTY_FUNDED` for every trade accepted from migration 0025 on; `LEGACY_EXCHANGE_FUNDED`
   only for trades accepted before it (backfilled by the migration, never creatable afterwards). The model is
   orthogonal to the execution mode: `TO_EXCHANGE` says *where* money travels (through the exchange's accounts),
   `COUNTERPARTY_FUNDED` says *whose* money it is (the client's and the counterparty's of this trade).
2. **The counterparty is the trade's route.** A trader is a route owner (`TRADERS.md`); a desk route is an external
   provider. The same rules apply to both, so there is no second, weaker path for desk routes.
3. **Acceptance binds commitments, not money.** For a counterparty-funded trade acceptance atomically creates the
   trade, its frozen economics, the route obligation, the deposit/delivery attribution and (on a trader route) starts
   the trader order with its capacity hold — and never reserves treasury funds. The database refuses a
   `treasury_reservation` for a counterparty-funded trade (IX083). Capacity is a commitment, not evidence of money.
4. **Money moves out only against money that came in, for this trade, at this place.** A *funding source* is a
   confirmed incoming movement of the trade: the client's completed first leg (*client funds*) or a confirmed
   `FROM_ROUTE_TO_EXCHANGE` route settlement (*counterparty funds*). A *funding allocation* earmarks part of one source
   for one outgoing use, in the same asset, at the same physical location:

   | Outgoing use (exchange pays) | Must be covered by | Physical location must match |
   |---|---|---|
   | Client payout leg, payer `EXCHANGE_ACCOUNT` | counterparty funds of the same trade | INR account / USDT address it is sent from |
   | `TO_ROUTE` route settlement (exchange → trader/route) | client funds of the same trade | same |
   | Refund leg (`REFUND_TO_CLIENT`) | client funds of the same trade | same |
   | Route-paid payout (`DIRECT_TO_CLIENT`, payer `ROUTE`) | nothing — it is the route's own movement | — |

   Allocations are `ACTIVE` while the use is planned or in flight, `CONSUMED` when the use is confirmed, `RELEASED`
   only when the use is cancelled or failed **and the money provably did not leave**. An ambiguous outgoing
   movement keeps its allocation `ACTIVE`; a second use cannot take the same money (FI-75).
5. **Delivery versus payment.** The exchange hands the client's funds to the counterparty (`TO_ROUTE`) only after the
   counterparty delivered: on a `TO_EXCHANGE` obligation the route-delivers side must be fully settled; on a
   `DIRECT_TO_CLIENT` obligation the route must have covered the client's payout (D-14's canonical walkthrough —
   the margin residual stays receivable). A client payout uses only counterparty funds already confirmed, so a
   partial delivery funds a partial payout and never the whole of it.
6. **Physical availability is checked separately from economic availability.** An outgoing USDT movement also needs
   a fresh (default ≤ 5 min), consistent on-chain observation of its source address showing the amount after every
   pending outflow from that address not yet reflected in the observation. Unknown, stale, inconsistent or
   disagreeing observations block; they never default to "available" (B2). INR has no bank feed in V1 (TD-14): the
   evidence of an INR credit is the desk's ⧗ confirmation against the bank, and capacity (FI-30) remains a
   throughput limit, never a balance.
7. **Places are explicit.** V1 pays *through* the address/account where the funding arrived (pass-through). A deposit
   address holding the trader's or client's USDT is a valid payout source when the custody provider can send from it
   (TRX/energy on that address is an operating cost, §6). Consolidation to a HOT wallet is a custody transfer the
   scanner recognises as internal (`CUSTODY_TRANSFER`, Dr `TREASURY_USDT:{to}` / Cr `TREASURY_USDT:{from}`), never as
   unallocated money; moving a trade's coverage with it is an explicit, audited relocation (§5.4), never implied.
8. **What this is not.** It is not `PREFUNDED` or `NET_SETTLED` (FI-63 still refuses them), not credit (D-12 still
   holds: no payout before the client's leg), not a promise that a Security Reserve can fund any payout (TD-21 /
   D3), and not a direct trader→client path (B4 — out of V1; the existing `DIRECT_TO_CLIENT` desk-route path is kept
   and verified, not offered for trader routes).

## 3. Money flows — before and after

Canonical amounts: 100,000 USDT, client ₹102.00, counterparty ₹104.20 (SELL) / ₹100.00 (BUY).
Journals are unchanged in shape: every movement posts exactly one `fiat:{id}:confirm` / `crypto:{id}:confirm`
journal chosen by `(payer, payee)` (FINANCIAL_INVARIANTS §3.4); funding allocations post **nothing** — they are
earmarks over already-posted money, so FI-27 and FI-42 are untouched.

### 3.1 Client sells USDT (trader *Buy USDT* side provides INR), `TO_EXCHANGE`

| Step | Before (`LEGACY_EXCHANGE_FUNDED`) | After (`COUNTERPARTY_FUNDED`) | Journal |
|---|---|---|---|
| 1 Accept | trade, obligation, deposit address D, order IN_PROGRESS | same — plus `trade_funding = COUNTERPARTY_FUNDED` | `trade:{t}:accept` (USDT Dr CLIENT_RECEIVABLE / Cr ROUTE_PAYABLE; INR Dr ROUTE_RECEIVABLE ₹10,420,000 / Cr CLIENT_PAYABLE ₹10,200,000 / Cr DEFERRED_MARGIN ₹220,000) |
| 2 Client USDT → D, final | first leg COMPLETED → **payout allowed** | first leg COMPLETED → becomes **client funds** at `TRON:D`; payout still refused (`FUNDING_NOT_CONFIRMED`) | `crypto:{x}:confirm` Dr TREASURY_USDT:{pool} / Cr CLIENT_RECEIVABLE |
| 3 Trader INR → collection account C, desk ⧗ confirms UTR | trader paid *after* the exchange may already have paid the client | trader paid → **counterparty funds** ₹10,420,000 at `INR:C` | `fiat:{f}:confirm` Dr INR_SETTLEMENT:C / Cr ROUTE_RECEIVABLE |
| 4 Client payout ₹10,200,000 | from any exchange account, own money | from **C** only, allocated from step 3 (₹220,000 stays unallocated = margin) | `fiat:{g}:confirm` Dr CLIENT_PAYABLE / Cr INR_SETTLEMENT:C |
| 5 USDT → trader wallet | from any treasury wallet, any time | from **D** (pass-through) only, allocated from step 2, only after step 3 settled the trader's side (DVP) | `crypto:{y}:confirm` Dr ROUTE_PAYABLE / Cr TREASURY_USDT:{pool} |
| 6 Complete | margin realized | same; order completes on SETTLED, reward accrues | `trade:{t}:complete`, `trader_reward:{o}:accrue` |

Platform own funds used: **0 USDT, ₹0** (C ends +₹220,000 = realized margin; D ends 0).

### 3.2 Client buys USDT (trader *Sell USDT* side provides USDT), `TO_EXCHANGE`

| Step | Before | After | Journal |
|---|---|---|---|
| 1 Accept | **treasury USDT reserved** (fails at zero treasury) | no reservation; trader order IN_PROGRESS; acceptance works at zero treasury | `trade:{t}:accept` |
| 2 Client INR → account A, desk ⧗ confirms | first leg COMPLETED → payout allowed from HOT | **client funds** ₹10,200,000 at `INR:A`; payout refused until step 3 | `fiat:{f}:confirm` Dr INR_SETTLEMENT:A / Cr CLIENT_RECEIVABLE |
| 3 Trader USDT → its order's delivery address E, final | settles the obligation side | **counterparty funds** 100,000 USDT at `TRON:E` | `crypto:{x}:confirm` Dr TREASURY_USDT:{pool} / Cr ROUTE_RECEIVABLE |
| 4 Client payout 100,000 USDT | from HOT, consuming the treasury reservation | from **E** (pass-through), allocated from step 3; fresh observation of E required | `crypto:{y}:confirm` Dr CLIENT_PAYABLE / Cr TREASURY_USDT:{pool} |
| 5 INR → trader bank ₹10,000,000 | from any account | from **A**, allocated from step 2, after step 3 (DVP); ₹200,000 stays = margin | `fiat:{g}:confirm` Dr ROUTE_PAYABLE / Cr INR_SETTLEMENT:A |

### 3.3 `DIRECT_TO_CLIENT` desk route (D-14 canonical)

Route pays ₹10,200,000 to the client directly (payer `ROUTE`, one UTR, one journal Dr CLIENT_PAYABLE / Cr
ROUTE_RECEIVABLE, trade COMPLETED, ₹220,000 residual receivable) — **unchanged**, no allocation needed. The exchange's
100,000 USDT to the route is a `TO_ROUTE` settlement allocated from the client's USDT at D and allowed because the
route covered the client payout (DVP rule for direct obligations). An exchange-paid top-up on a direct trade needs
counterparty funds the route delivered to the exchange, like any other exchange-paid payout.

### 3.4 Failure paths

| Situation | Outcome |
|---|---|
| Trader never delivers (offer accepted, trade IN_PROGRESS, client funded) | No payout is possible (no counterparty funds). Client funds stay earmarked; the desk refunds them (`refund` allocated from client funds, two-person) and cancels (`refund_and_cancel`), or waits. No automatic reassignment after IN_PROGRESS. Reserve recovery only through D3's approved path. |
| Trader delivers part | Payouts up to the delivered amount (partial legs); the rest waits. Unwinding a partial fill is an approved adjustment plus refund of the unfunded part — never a platform top-up. |
| Other trades or the insurance/Security Reserve hold money at the same account/wallet | Irrelevant: allocations draw only on this trade's sources (FI-76); the reserve is a trader-subject liability, never a source. |
| Payout sent, outcome ambiguous | Allocation stays ACTIVE; no replacement leg can take the same money (FI-25, FI-75). |
| Client already paid, route residual open | Trade stays COMPLETED (FI-62); the residual stays a visible receivable/payable on the obligation; unallocated counterparty funds are not "free" until the obligation settles. |

## 4. Invariants (new)

| ID | Invariant | Enforcement |
|---|---|---|
| FI-70 | Every trade has exactly one insert-once funding model; trades created after 0025 are `COUNTERPARTY_FUNDED`; `LEGACY_EXCHANGE_FUNDED` cannot be created | `trade_funding` PK; AFTER INSERT trigger on `trade`; BEFORE INSERT guard refusing anything else (IX082); append-only |
| FI-71 | A counterparty-funded trade never holds a treasury reservation | IX083 on `treasury_reservation` insert; acceptance does not call `reserveTreasuryUsdt` (no production caller remains) |
| FI-72 | An exchange-paid client payout leg of a counterparty-funded trade is fully covered by ACTIVE/CONSUMED allocations from counterparty funds of the same trade, asset and location | `allocateFunding` in `createPayoutLeg`; deferred coverage trigger IX086 |
| FI-73 | A `TO_ROUTE` route settlement of a counterparty-funded trade is fully covered by allocations from client funds of the same trade, asset and location | allocation in `recordRouteSettlementInTx`; IX086 |
| FI-74 | A refund leg of a counterparty-funded trade is fully covered by client-funds allocations | `createRefundLeg`; IX086 |
| FI-75 | A funding source is never allocated beyond its amount; ACTIVE allocations stay ACTIVE while their movement could still land | deferred IX085 under the source lock; IX086 releases only for CANCELLED/FAILED uses |
| FI-76 | Allocations never cross trades and never draw on suspense, reserves or legacy reservations | source view is trade-scoped confirmed client legs / route settlements only; IX084 on insert |
| FI-77 | DVP: `TO_ROUTE` only after the counterparty delivered (TO_EXCHANGE: route side fully settled; DIRECT_TO_CLIENT: client payout covered) | command check in `recordRouteSettlementInTx` (`COUNTERPARTY_NOT_DELIVERED`) under the trade lock; BEFORE INSERT trigger IX087 |
| FI-78 | An outgoing USDT movement needs a fresh, consistent observation of its source address covering it after unreflected pending outflows | `assertPhysicallyAvailable` in `payout_leg.send` and `refund_leg.create` (USDT); readings append-only, a wallet's observed balance only ever its latest reading (IX089, 0026) |
| FI-79 | Capacity holds, funding allocations and the Security Reserve are separate quantities; none is read as another in eligibility, availability, UI or journal | separate tables/accounts; projections tested |

## 5. Implementation notes

### 5.1 Tables (migrations `0025_counterparty_funding.sql`, `0026_custody_observation.sql`)
- `trade_funding(trade_id PK, model, created_at)` — insert-once; backfill `LEGACY_EXCHANGE_FUNDED` for every
  existing trade inside the migration; trigger creates `COUNTERPARTY_FUNDED` for every new trade.
- `funding_allocation(id, trade_id, source_leg_id | source_route_settlement_id, use_leg_id | use_route_settlement_id,
  asset, amount_minor, location, status, created_by/at, closed_by/at, close_reason)`.
- `funding_source` — a **view** over confirmed client legs and confirmed `FROM_ROUTE_TO_EXCHANGE` route settlements
  with their location derived from the movement (fiat payee account / crypto `to_address`). A view rather than a
  table removes the dual-write gap during a mixed-version rollout: a source exists exactly when its movement is
  confirmed, whichever app version confirmed it.
- `settlement_leg.source_deposit_address_id` / route settlement USDT source address: a USDT outflow names the address
  it leaves from, so verification holds the chain to it (FI-24) and the allocation's location to it (FI-72/73).
- `custody_balance_observation` (append-only, 0026) + `treasury_wallet.observed_*` kept current for wallets (B2). A
  deposit address holding unspent funding stays out of the pool until the outflow is confirmed (IX088; 0026 counts a
  planned outflow as still there).

### 5.2 Commands
`createPayoutLeg`, `recordRouteSettlementInTx` (`TO_ROUTE`), `createRefundLeg` allocate; `cancelPayoutLeg`,
`failPayoutLeg`, `failRouteSettlement`, refund failure release; `confirmPayoutLeg`, `confirmRouteSettlementInTx`,
`confirmRefundLeg` consume. Every allocation and release is audited; nothing is posted to the ledger.

### 5.3 Legacy trades
Trades accepted before 0025 keep `LEGACY_EXCHANGE_FUNDED`: their treasury reservations (FI-33) and the D-12-only
payout gate stay as they were, so nothing in flight changes underneath an operator — except that a USDT payout of a
legacy trade now also needs B2's fresh reading of the wallet it leaves (stricter, never looser). The migration moves no
funds and rewrites no economics; if the owner wants a legacy trade re-funded by a trader that is a separate,
audited decision, not a migration.

### 5.4 Relocation (consolidation)
A swept deposit address leaves its trade's coverage at the address. `funding.relocate` (⧗, `treasury:manage_wallets`)
moves part of one trade's unallocated funding to another location, citing a confirmed `CUSTODY_TRANSFER` movement
whose amount bounds every relocation that cites it. Until a relocation is recorded the money is spent from where it
arrived. *(Status: specified; the pass-through path is the V1 implementation — see PRODUCTION_HARDENING.md.)*

## 6. Costs and who covers them (no "zero-cost" promise)

| Cost | Paid in | Covered by | Visible as |
|---|---|---|---|
| TRX / energy for pass-through payouts and sweeps | TRX on the sending address | Platform operating budget (TRX is never client or trader principal) | TRX balance on each observation; low-TRX health warning on addresses with pending outflows |
| Custody provider fees | provider invoice | Platform operating budget | outside the trade ledger |
| Bank transfer charges | INR, deducted by the bank | Realized margin (statement reconciliation records them as explicit fee lines, `EXPENSE:FEES`) | reconciliation case until recorded |
| Trader rewards | INR | Realized margin only; a payout needs free margin at the paying account (no principal, no other trade's funds, no reserve) | `LIAB:TRADER_REWARD_PAYABLE` stays open and the payout is refused when uncovered |

Net economics are shown after rewards and recorded fees; a positive gross margin never hides a negative net.

## 7. Migration and rollout

1. `0025` and `0026` are additive (new tables, a view, one nullable column per outgoing row, triggers). It edits no applied
   migration, rewrites no economics and backfills only `trade_funding` facts (`LEGACY_EXCHANGE_FUNDED`).
2. **Mixed versions fail closed.** An old app instance after 0025: its acceptance creates a counterparty-funded trade
   (trigger) and then calls `reserveTreasuryUsdt` for a BUY — refused (IX083), the acceptance rolls back and can be
   retried on a new instance; its payout/route-payment commands do not allocate — refused at commit (IX086). No old
   path can move platform money for a new trade.
3. Order: deploy migration → roll web + worker → verify `trade_funding` counts (all pre-0025 trades LEGACY, all new
   COUNTERPARTY_FUNDED) → enable acceptance. Rollback of the app version is safe (fails closed as above); rolling
   back the schema is not supported once counterparty-funded trades exist (their earmarks would be lost) — roll
   forward.

## 8. Open owner questions (do not block this ADR)
- Fee collection mechanism beyond margin (explicit client fee lines) — V1 keeps fees at zero (FINANCIAL_INVARIANTS §5).
- Default recovery terms for traders (TD-21/D3): what the reserve may cover and at what agreed valuation for INR.
- Whether a direct trader→client path (B4) is wanted; until chosen it is not offered.
