# INRP2P Exchange — Traders

Status: implemented (migration `0022_traders.sql`, packages `trader-core` and `traders`), 2026-09-27. Self-onboarding
and trader-submitted settlement details: migration `0023_trader_self_onboarding.sql`, 2026-09-28.

A **trader** is an onboarded client that provides INR or USDT capacity. INRP2P sends it matching client orders,
privately, one order to one trader, and the trader earns a configured reward on each completed order. It is not a
public order board, not a market, and not a matching engine: a trader never sees another trader, never sees the
client on the other side, and never chooses an order it was not offered.

The feature reuses the existing machinery rather than adding a parallel one. A trader is a `client`; each side a
trader offers is a `liquidity_route` in `TO_EXCHANGE` mode owned by that trader; an order that starts is an
ordinary client trade on that route, with an ordinary `route_obligation`, settled by ordinary movements and route
settlements. What is new is the programme around it: application and approval, capacity blocks, private
assignment, the Security Reserve, rewards, and the trader's own screens.

## 1. Terms

| Term | Meaning |
|---|---|
| Buy USDT (trader side) | The trader has INR and buys USDT. It fills a **client selling USDT** (`SELL_USDT` request). The trader pays INR to INRP2P's collection account; INRP2P sends USDT to the trader's registered wallet. |
| Sell USDT (trader side) | The trader has USDT and sells it for INR. It fills a **client buying USDT** (`BUY_USDT` request). The trader sends USDT to the order's own deposit address; INRP2P pays INR to the trader's registered bank account. |
| Block | One side's terms: capacity (INR for Buy USDT, USDT for Sell USDT), rate, minimum and maximum per order, status. |
| Order | One offer of one client request to one trader (`trader_order`, ref `TO-YYMMDD-NNNN`). |
| Security Reserve | USDT the trader deposits with INRP2P, held separately from capacity, locked while it provides liquidity or has open orders. |
| Reward | INRP2P's payment to the trader on a completed order: `reward_bps` of the order's INR value, rounded down to the paisa. |

## 2. Data model

| Table | Purpose |
|---|---|
| `trader_program` | Singleton programme configuration: default required reserve (null until set — never invented), reward bps (null = no reward), offer TTL (30–900 s, default 120), hold TTL (60–900 s, default 900), `auto_assign` (default off), the INR collection account traders pay into. |
| `trader_profile` | One per client: status, sides offered, typical amounts, registered bank account and wallet, required reserve, reward override, operator ceilings (`max_order_*`, `max_capacity_*`), `available` (the trader's switch), `assignments_enabled` (the desk's switch), `control_note`, review fields. |
| `trader_block` | One per side, bound to the trader's route: capacity, `reserved_minor` (held by accepted/started orders), rate, min/max, status. |
| `trader_order` | Offered → accepted → started → completed (or closed). Frozen at offer: base, INR, rate, capacity amount. Frozen at start: trade, route obligation, quote, reward. |
| `trader_reserve_withdrawal` | REQUESTED → SENT → COMPLETED, or REJECTED / CANCELLED. At most one open per trader. |
| `trader_reward_payout` | RECORDED → CONFIRMED / FAILED, with a `capacity_reservation` (`TRADER_REWARD_PAYOUT`) on the paying INR account. |

Extensions to existing tables: `liquidity_route.trader_id` (trader routes are `TO_EXCHANGE`, one direction);
`rate_snapshot` source `TRADER` (owner-checked); `deposit_assignment` subject may be a trade, a trader's reserve, or
a route obligation (exactly one); crypto payer/payee and fiat payee `TRADER`; client notification kinds `TRADER_*`.

Migration 0023: `client.exchange_access` (IX080 on `trade_request`); `PENDING_REVIEW` / `REJECTED` destination states
with `reviewed_by`, `reviewed_at`, `review_note`; on `trader_profile` the application's own details (`p2p_experience`,
`profile_link`, `telegram_handle`, sealed `phone_enc` + `phone_last4`, `daily_capacity_*`, `ownership_confirmed_at`)
and a proposed replacement (`proposed_bank_account_id`, `proposed_wallet_id`, same-client guard IX070).

## 3. Onboarding, access and trader states

### 3.1 Becoming a trader (self-onboarding)

Anyone may apply; nobody is provisioned by hand, allow-listed or seeded.

```
public site "Become a trader" ─▶ app host /become-a-trader ─▶ email ─▶ code ─▶ /traders/apply ─▶ submit
   ─▶ UNDER_REVIEW ─▶ desk verifies the bank account and the wallet ─▶ desk approves ─▶ trader workspace
```

1. **Identity.** `/become-a-trader` (app host, no session) calls `startTraderAccessAction`, which makes sure the
   address has a CLIENT sign-in identity (`ensureClientIdentity`): an address that already has one keeps it (an
   existing client applies as itself — never a duplicate); a new one gets a bare identity with **no client, no role
   and no permission**. Rate-limited per caller and per address; the answer never says which addresses exist. The
   code is Better Auth's own email OTP, exactly as for the workspace sign-in — which since D-17 makes the same bare
   identity for a new address, whose holder then opens a client account themselves (`/open-account`) or applies here.
2. **Application** (`trader.apply`): full name, Individual/Company, Telegram and/or phone (sealed), P2P experience
   (Binance/Bybit/Other/No) and an optional profile link, what the trader provides (INR/USDT/both), typical order
   and daily capacity per side, and settlement details — account holder, bank, account number (sealed, fingerprinted),
   IFSC, IMPS/NEFT/RTGS, a TRC20 wallet and optional label — with the confirmation *"I confirm this bank account and
   wallet belong to me or my company."* No rate is asked for; rates belong to an approved trader.
   - A person with no client: the application creates their client **without Exchange access**
     (`client.exchange_access = false`) and makes them its `CLIENT_ADMIN` **without** `can_accept_quotes`.
   - A client's `CLIENT_ADMIN`: the application is that client's, under its name and type with the desk; it may use
     bank accounts and wallets the desk already verified, or submit new ones.
3. **Review.** Submitted details are `PENDING_REVIEW` and unusable (everything that settles asks for ACTIVE). The
   desk verifies or rejects each (`trader.review_destination`, `traders:configure` ⧗) without retyping anything,
   seeing the full address, the account number on request (`bank_account:reveal` ⧗) and any other client that has
   the same account or wallet on file. A rejected detail can be replaced by the applicant while the application is
   under review (`trader.propose_settlement_change`).
4. **Approval** (`trader.approve` ⧗) is refused until both details are verified. It sets the reserve and the
   ceilings as before, and — for a client without Exchange access only — grants the applicant `can_accept_quotes`,
   the authority every trader action that binds money checks. Available is never switched on for the trader.

Destination states (`bank_account.status`, `crypto_wallet.status`): `PENDING_REVIEW` (pending review) ─▶ `ACTIVE`
(verified) ─▶ `ARCHIVED`; `PENDING_REVIEW` ─▶ `REJECTED`; `PENDING_REVIEW` ─▶ `ARCHIVED` when withdrawn or replaced.

### 3.2 Access: one sign-in, routed by what the account is

| Account | Exchange / History / Destinations | Traders | Notifications |
|---|---|---|---|
| Client with the Exchange (`exchange_access`) — opened by the desk, or by the client itself (D-17, `client.open_account`) | ✔ | ✔ (apply, or trader screens) | ✔ |
| Client that applied as a trader only | — (redirected to Traders) | ✔ | ✔ |
| Verified email, no account yet | — (redirected to `/open-account`) | apply | — |

`portalAccess` (the Exchange's gate) refuses anything but a member of a client with Exchange access
(`EXCHANGE_NOT_ENABLED`, which the pages turn into a redirect to `/open-account` for someone with no account and to
`/traders` for a trader-only client), and the database refuses a trade
request for a client without it (IX080), so no quote, trade or payout can exist for one. The desk opens the
Exchange for a trader-only client with `client.set_exchange_access` (`client:manage`); the workspace sign-in has no
client/trader choice.

### 3.3 Settlement changes by an approved trader (TD-24, closed)

An approved trader's administrator submits a new bank account and/or wallet (`trader.propose_settlement_change`).
It waits `PENDING_REVIEW` beside the registered pair, which keeps settling every order. The desk approves
(`trader.review_settlement_change` ⧗: verifies it, registers it, moves the trader's routes) or rejects it with a
note the trader sees. Approval — and the desk's own `trader.set_settlement_details` — is refused while an order is
accepted or in progress (`TRADER_ORDERS_OPEN`): an order settles with the details it was accepted under.

### 3.4 Trader states (`trader_profile.status`)

```
(none) ──apply──▶ UNDER_REVIEW ──approve (⧗)──▶ APPROVED ◀──resume (⧗)── PAUSED
                       │                           │  └──pause (⧗)──────────▶ ▲
                       └──reject──▶ REJECTED ──apply again──▶ UNDER_REVIEW
```

- **Apply** (`trader.apply`, §3.1): a new applicant or a client's CLIENT_ADMIN; one bank account and one TRON wallet
  with purpose `BOTH`, of the trader's own client (IX070), verified before approval. Nothing is live.
- **Approve** (`trader.approve`, `traders:configure` ⧗): sets the required reserve (from the programme or
  per trader — never invented), creates one route and one block per side (routes named `Trader TR-xxxx · Buy USDT`).
- **Available** is the trader's own switch. Switching on requires approval, a set and funded reserve and active
  destinations (`switchOnIssues`). Switching off withdraws unanswered offers; accepted and started orders continue.
- **Pause** is the desk's hold: no new orders, offers withdrawn, `available` off, reason shown to the trader.
  Resume restores approval; the trader switches on again itself.
- **Assignments off** (`assignments_enabled = false`) stops new orders without pausing, reason shown.

A trader receives an order only when `standingIssues` is empty: approved, not paused, reserve set and funded,
destinations active, assignments enabled, available.

## 4. Order flow (`trader_order.status`)

```
OFFERED ──accept──▶ ACCEPTED ──client accepts the quote──▶ IN_PROGRESS ──both sides settled──▶ COMPLETED
   │                   │                                        │
   ├─decline──▶ DECLINED                                        └─trade cancelled──▶ CANCELLED
   ├─offer TTL──▶ EXPIRED   ACCEPTED ─hold TTL (no live quote)─▶ RELEASED
   └─switch off / pause / desk──▶ WITHDRAWN           ─desk release / request closed─▶ RELEASED
```

1. **Assign** (`trader_order.assign`, `traders:assign`): the desk routes an open request (or the worker does, when
   `auto_assign` is on). The best eligible trader (§5) gets one order for the whole request — no split fills.
   Notifications: `TRADER_ORDER_NEW`, sound on the trader's screen.
2. **Accept** (trader, `can_accept_quotes`): refused after the business-clock expiry. Capacity is reserved on the
   block at this moment (`reserved_minor += capacity_minor`, IX074 keeps them equal).
3. **Quote**: the desk can quote a trader route only on that trader's accepted order, for exactly its amounts
   (command check and IX075). The route rate snapshot frozen at accept is the one priced.
4. **Start**: when the client accepts the quote, the order moves to IN_PROGRESS in the acceptance transaction, with
   the trade, the route obligation and the reward frozen. A trade on a trader route without a started order is
   refused at commit (IX075).
5. **Settle** (per side, §7). The trader acts only once the client's funds are confirmed (`TRADER_ACTION_NOT_DUE`
   before). `TRADER_ACTION_REQUIRED` is sent when it is the trader's turn.
6. **Complete**: when the route obligation is SETTLED the reconciliation completes the order: block capacity is
   consumed, the hold released, the reward accrued in the ledger, the delivery address released. A cancelled trade
   cancels the order and releases its hold.

Declined, expired and withdrawn offers are re-routed to the next eligible trader (one step, keyed by the event).
A request closed by the client or desk closes its live order and releases held capacity. An ended hold releases
capacity only when no quote on it is still live.

**Stages** (`progress.ts`) are what the trader sees: `OFFER`, `HELD`, `AWAITING_FUNDING`, `YOUR_TURN`,
`CHECKING_YOURS`, `INRP2P_SENDING`, `CHECKING_INRP2P`, `REVIEW`, `COMPLETED`, `CLOSED`, derived from facts of record
(order status, first-leg confirmation, obligation allocations, pending settlements, exceptions). The trader acts
only in `OFFER` and `YOUR_TURN`.

## 5. Routing (V1, deterministic)

Eligibility first, then rank. A trader is **eligible** for a request when its standing is clear (§3), it has the
matching side, the block is active with a rate and limits, the order fits (`orderFit`: ≥ minimum, ≤ the lower of
its maximum and the desk's ceiling, ≤ free capacity after holds and outstanding offers), it has not been offered
this request before, and the request is not its own client's (IX072 also refuses self-dealing).

**Rank** (`rankCandidates`): best rate for the exchange (highest INR per USDT for a client selling, lowest for a
client buying) → most free capacity → fewest open orders → most completed orders → trader reference. The same
inputs always pick the same trader. When nobody is eligible the desk sees why each trader was excluded
(`TRADER_NONE_ELIGIBLE`).

**Sizing** (`sizeOrder`) uses the kernel's own `computeTradeEconomics`: a USDT-fixed request is priced at the
trader's rate; an INR-fixed request needs the client rate the desk intends to quote (`plannedClientRate`), because
the USDT follows from it, and the quote must use that same rate.

## 6. Pricing

The trader sets a **fixed rate** per side. Each change publishes a `rate_snapshot` with source `TRADER` on its
route; the desk cannot publish a rate on a trader route and a trader rate cannot land on a desk route (IX076).
Changing a rate withdraws unanswered offers made at the old rate. There is no reference-plus-adjustment pricing
and no market feed in V1. The client's rate and the exchange's margin are never shown to the trader.

## 7. Settlement per side

Both sides settle through the order's `route_obligation` (`TO_EXCHANGE`), and since D-16 (ADR 0016) both are paid
with the other party's money only — INRP2P advances nothing of its own:

| | Buy USDT trader (client sells USDT) | Sell USDT trader (client buys USDT) |
|---|---|---|
| Trader delivers | INR from its registered bank account to the programme's collection account (ACTIVE, and `BOTH`: the client is paid out of it), with the order ref as narration. The trader submits the UTR (`trader_order.submit_payment`), recorded as a `FROM_ROUTE_TO_EXCHANGE` route settlement; the desk confirms it against the bank (⧗). | USDT from its registered wallet to the order's own deposit address (`trader_order.delivery_address`, issued only when due). The scanner records and confirms it on finality as a route settlement. A transfer from another wallet is not counted (`REVIEW`, exception); over-delivery opens `ROUTE_SETTLEMENT_MISMATCH`. |
| The client is paid | INR from the collection account the trader's INR arrived in, earmarked against that delivery. | USDT from the order's deposit address the trader's USDT arrived at, earmarked against that delivery, once a fresh reading of that address shows it there (B2). |
| INRP2P delivers to the trader | The client's USDT, from the client's deposit address, only after the trader's INR is confirmed in full (delivery versus payment): desk records the tx (`TO_ROUTE`, the log found by its facts) and confirms on finality (⧗). | The client's INR, from the account the client paid into, only after the trader's USDT is confirmed: desk records the UTR (`TO_ROUTE`) and confirms (⧗). |

A trader that delivers part funds a partial payout only; one that delivers nothing leaves the client's funds
earmarked where they are — refundable to the client, never advanced against. Another trade's money and any trader's
Security Reserve never stand in (FI-76). A trader route is always `TO_EXCHANGE`: there is no trader → client path (B4).

## 8. Security Reserve

- **Deposit** (D-17, migration 0035): one TRC20 address for every trader — `TJNzB4sUGBo8fv7UdeeKQKQUffpfLSXbPP`, a
  watched exchange wallet (`treasury_wallet.role = 'TRADER_RESERVE'`, at most one active; no key in the application)
  — shown with its QR from the day a trader applies. The sender attributes it: USDT from the registered wallet of
  exactly one trader, on file before the transfer (verified or under review), is that trader's reserve, credited on
  finality: `crypto:{x}:confirm`, purpose `TRADER_RESERVE`, Dr `ASSET:TREASURY_USDT` / Cr `LIAB:TRADER_RESERVE:{trader}`.
  From any other wallet — or one two traders have on file — it is recorded with payer `UNKNOWN`, parked in suspense
  on confirmation and a `USDT_UNEXPECTED_SENDER` case opens (`RESERVE_SENDER_NOT_REGISTERED` / `_AMBIGUOUS`); the
  database refuses crediting a trader whose registered wallet did not send it (IX102, FI-83). A trader may hand in its transaction hash
  (`trader_reserve.claim_deposit`, any member, rate-limited): it is read from the providers and attributed by the same
  rule, so another trader's hash is refused and nothing is written; a transfer already recorded is never recorded
  again. Topping up is not admission: approval stays the desk's decision. Reserve addresses issued per trader before
  D-17 stay watched and credit as before.
- **Figures** (`reserveFigures`, all read from the ledger and open withdrawals — no frontend balances):
  `free = balance − pending withdrawals`; while the trader is *engaged* (available, or with accepted/started orders)
  `locked = min(free, required)`; `available for withdrawal = free − locked`; `pending release = open withdrawals`;
  `shortfall = required − free` when positive. A shortfall stops new orders (`RESERVE_SHORT`).
- **Withdrawal**: the account's administrator, or someone who can commit, requests up to the available amount (never
  the locked part), to the registered wallet once the desk has verified it; switching off keeps the
  reserve locked until the last open order finishes. The desk sends from custody, records the tx hash (read back
  from the chain), and confirms on finality (⧗), posting Dr `LIAB:TRADER_RESERVE` / Cr `ASSET:TREASURY_USDT` once.
  The desk may reject with a reason; the trader may cancel before it is sent.
- **Changing the requirement** (⧗) is audited and notified (`TRADER_RESERVE_ISSUE`); it never edits the trader's
  own terms, and nothing is taken from the reserve automatically.
- **Applying it to USDT the trader did not deliver** (TD-21, migration 0029): on a started Sell USDT order whose client
  side is funded, the desk may apply the trader's reserve to the USDT the order still owes — one person asks with the
  reason (`trader_reserve:apply` ⧗), another approves (`trader_reserve:approve` ⧗✱). Approval holds the amount (it
  leaves `available`; figure `applying`), issues the order's delivery address if needed and tells the trader
  (`TRADER_RESERVE_ISSUE`). Custody moves the USDT from the reserve address (or a treasury wallet) to the order's
  address; the desk records the hash or the scanner recognises it; on finality it is the order's delivery —
  `crypto:{x}:confirm`, purpose `TRADER_RESERVE_APPLIED`, Dr `LIAB:TRADER_RESERVE` / Cr `ASSET:ROUTE_RECEIVABLE` — and
  the order goes on (the client is paid from it, the trader is paid its INR). Never beyond the order's own USDT, never
  automatic. An approved application whose USDT has not moved can be ended with a reason; a recorded transfer that
  fails ends it.
- **Holding it against INR the trader did not pay** (same commands, `kind = HOLD`): on a started Buy USDT order the
  reserve is USDT and no conversion terms exist, so two people can only hold a named amount of it — out of `available`,
  nothing moved, nothing posted, the INR debt open — until it is released with a reason or the order completes or is
  cancelled (the sweep ends it). Converting it into an INR recovery is the owner's decision (TD-21).

## 8a. Network deposit (ADR 0017)

The exchange's signer pays USDT out of each deal's own address, and TRON charges TRX for it. For a trader's orders
that TRX comes from the trader's **network deposit** — never from its Security Reserve, its capacity or anyone else's
money:

- The trader sends TRX from its registered wallet to the budget wallet (Traders → Network deposit, address and QR) and
  hands in the hash; the sending wallet attributes it, credited once (FI-91).
- Each order holds the worst case of its transfers from acceptance until it finishes (one for a Buy, two for a Sell:
  paying the trader, or returning the client's USDT); an order is not offered while the free TRX cannot cover it
  (routing exclusion `NETWORK_DEPOSIT_SHORT`).
- What the order's transfers burn is spent from the deposit; what the client's price paid for (its payout or the
  trader's payment) — and a transfer the platform's mistake caused — is paid back in INR at the order's quoted TRX
  price, with the trader's rewards. A return of the client's USDT caused by the trader's side not being completed is
  the trader's.
- Free TRX can be withdrawn to the registered wallet (the desk approves; the withdrawal's own fee is the trader's).

## 9. Rewards

- Model: `reward_bps` of the order's INR value (programme default, optional per-trader override), 0–500 bps,
  rounded down to the paisa. Null means no reward and the UI says so. Frozen on the order when it starts.
- Accrual on completion: `trader_reward:{order}:accrue`, Dr `EXPENSE:TRADER_REWARDS` / Cr
  `LIAB:TRADER_REWARD_PAYABLE:{trader}` (no trade dimension).
- Payout: the desk records an INR payment from an exchange account to the trader's registered bank account
  (`trader_reward.record_payout`, capacity reserved; refused above the payable), then confirms it (⧗):
  `fiat:{f}:confirm`, purpose `TRADER_REWARD_PAYOUT`, Dr `LIAB:TRADER_REWARD_PAYABLE` / Cr `ASSET:INR_SETTLEMENT`.
  A failed payout releases the capacity (`TRADER_PAYOUT_FAILED`).
- **Paid only out of realized margin** (D4, migration 0030): a reward is the platform's own expense, and since D-16
  the platform's own money at an exchange account is only what its finished trades left there. A payout from an
  account is refused (`TRADER_REWARD_NOT_COVERED`; IX096 for any writer) beyond that account's free margin: the
  leftovers of trades completed on both sides (client paid, counterparty paid), less rewards already paid or being
  paid from it, and never more than the account holds beyond the money of trades still open. A client's or a
  trader's principal, another trade's money and a reserve never pay a reward; an uncovered reward stays payable.
  The desk sees each account's free margin where it chooses the paying account.
- Earnings shown to the trader: Today, Available (accrued, unpaid), Pending (frozen rewards on open orders),
  Being paid out, Total completed volume. No "profit" wording.

## 10. Invariants

| ID | Invariant | Enforcement |
|---|---|---|
| TR-01 | A trader settles only through its own client's registered bank account and a `BOTH` wallet | Commands + IX070 |
| TR-02 | A block's held capacity equals the capacity of its accepted and started orders | Deferred trigger IX074; capacity ≥ reserved CHECK |
| TR-03 | One live order per request; one order fills one request whole; never the trader's own request | Partial unique index; IX072 |
| TR-04 | A quote on a trader route prices exactly the trader's accepted order, at its frozen snapshot | `requireOrderForQuote`; IX075 on quote |
| TR-05 | A trade on a trader route has a started trader order | Deferred IX075 on `trade_economics` |
| TR-06 | Only the trader sets a trader route's rate; the desk's route commands refuse trader routes | `refuseTraderRoute`, `publishRouteRate`; IX076 |
| TR-07 | A delivery address belongs to exactly one subject; an obligation address only for USDT the trader route owes | IX077 |
| TR-08 | Reserve and reward balances are ledger balances; each movement posts once | Movement journals (FI-27, FI-42); accrual key unique |
| TR-09 | The locked reserve is never withdrawable; one open withdrawal per trader | Command under the trader lock; partial unique index |
| TR-10 | Nothing about the client, the desk's pricing or internals reaches a trader projection | `assertTraderSafe` on every trader view; integration test |
| TR-11 | Offer and hold expiry use the business clock | `inrp2p_now()` in commands and the sweep |
| TR-12 | A reserve is applied only to its own trader's undelivered USDT, by two people, within what the order owes and the reserve holds free; it reaches the order as one delivery with one journal. Against INR it is only held: nothing moves or posts, the debt stays open, and a hold never outlives its order | Commands under trader → order → obligation locks; IX094, IX095; posting key unique; sweep ends holds with their order |

Lock order: `trader_profile → trader_order → trader_block` after `acceptance_challenge` (ARCHITECTURE §4).

## 11. Operator controls and permissions

Desk page `/trader-desk` (the client owns `/traders`; the two products share one path space):
the programme, the review queue and every trader with reserve, open/unresolved/completed orders and issues; per
trader: approve, reject, pause, resume, stop/allow new assignments, per-trader ceilings, required reserve, reward
override, registered bank account and wallet (review of a change), reveal bank details, every order with its
settlements and the controls to record and confirm them, withdraw/release an order, reserve withdrawals, reward
payouts, and the decision log from the audit trail. The quote panel routes a request to a trader and shows why
traders were excluded.

| Permission | OWNER | DEALER | FINANCE | Used for |
|---|---|---|---|---|
| `traders:view` | ✔ | ✔ | ✔ | Desk pages |
| `traders:assign` | ✔ | ✔ | | Route a request, withdraw/release an order |
| `traders:pause` | ⧗ | ⧗ | ⧗ | Pause, resume, assignments on/off |
| `traders:configure` | ⧗ | | ⧗ | Programme, approve, reject, limits, reserve, reward, settlement details, verify/reject submitted details, approve/reject settlement changes, reveal an applicant's phone |
| `trader_payout:record` | ✔ | | ✔ | Record reserve withdrawal sent, reward payout |
| `trader_payout:confirm` | ⧗ | | ⧗ | Confirm/reject withdrawals, confirm/fail payouts |
| `trader_reserve:apply` | ⧗ | | ⧗ | Ask to apply the reserve to an order's undelivered USDT; withdraw the request (TD-21) |
| `trader_reserve:approve` | ⧗✱ | | ⧗✱ | Approve or decline it (never the requester); end an approved one before its USDT moves |

Every control is an audited command; nothing is punished automatically.

## 12. Notifications

Through the existing outbox and client inbox (and email, where a provider is bound — TD-04): `TRADER_APPROVED`,
`TRADER_REJECTED`, `TRADER_PAUSED`, `TRADER_RESUMED`, `TRADER_ORDER_NEW`, `TRADER_ORDER_ACCEPTED`,
`TRADER_ACTION_REQUIRED`, `TRADER_PAYMENT_CONFIRMED`, `TRADER_ORDER_COMPLETED`, `TRADER_ORDER_CLOSED`,
`TRADER_RESERVE_ISSUE`. There is no Telegram channel in the product, so none was added.

## 13. Client surfaces

`/become-a-trader` (public entry on the app host), `/traders` (onboarding, application status with each detail's
review state, or the working screen), `/traders/apply` (six steps), `/traders/settlement` (new bank account or wallet),
`/traders/orders` (Active / Completed), `/traders/orders/[ref]` (progress, what to do now, payment details or the
delivery address, evidence), `/traders/reserve` (the shared address with its QR, the transaction-hash hand-in, the
figures and history — for every trader from the day it applies). `/open-account` is where someone with no account
opens a client account (D-17). The workspace robot reports the trader's own projection in one
sentence (ready, focused for a new order, waiting, verifying, success, alert); no chat, no LLM, no voice. Sounds
play only for a new order, an accepted order, a completed order and an action required, and respect mute.

## 14. Jobs

- `trader_orders_sweep` (worker cron, every minute): expires offers, ends holds, reconciles started orders. Each
  order is its own step and transaction: one that fails rolls back alone, is logged with its code, and is retried
  next minute while the sweep goes on (D4). An order left undone ten minutes is the `trader_orders_overdue` signal.
- `traderRoutingHandler` (outbox): re-routes declined/expired/withdrawn offers, auto-assigns new requests when
  `auto_assign` is on, closes orders of cancelled trades.
- `traderNotificationHandler` (outbox): writes the `TRADER_*` notifications.

Open gaps are in `TECH_DEBT.md` (TD-21 onwards).
