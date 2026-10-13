# INRP2P Exchange — Financial Invariants

Status: Phase 0, revision 3 (`DECISIONS.md` Revision 3).
Every invariant has an ID, a statement, and the mechanism that enforces it. "Enforced by app" alone is never sufficient for money: each invariant names at least one database-level or structural guarantee, plus the test that proves it.

## 1. Numbers

### 1.1 Representation
| Quantity | Unit stored | DB type | Precision |
|---|---|---|---|
| USDT amount | micro-USDT (10⁻⁶) — equals TRC20 USDT on-chain decimals | `BIGINT` | 6 dp |
| INR amount | paise (10⁻²) | `BIGINT` | 2 dp |
| Rate (INR per 1 USDT) | micro-rupees per USDT (10⁻⁶ INR) | `BIGINT` | 6 dp (UI quotes to 2 dp by default; up to 4 dp allowed) |

Currency precision is defined once in `packages/kernel/currency.ts` and mirrored in the `currency` table (`code`, `minor_unit_exponent`). Every amount column is paired with a currency column, or the column name fixes the currency (`*_usdt_minor`, `*_inr_minor`) and a CHECK constraint validates it.

- `bigint` in TypeScript, `BIGINT` in Postgres. `number` is forbidden for money/rates by lint rule (`no-restricted-syntax` on arithmetic over branded `Money`/`Rate` types; `Money` has no `valueOf`).
- Parsing from user input: string → decimal parser that rejects more fractional digits than the currency allows (no silent rounding of what a human typed).
- JSON: amounts serialize as decimal strings (`"10200000.00"`), never JSON numbers, never with grouping separators.
- Display: one locale-independent formatter; INR with international three-digit grouping `₹10,200,000.00` in client and operator UI (`DECISIONS.md D-11`). Formatting never feeds back into computation.

### 1.2 Conversion and rounding
`inr_minor = round( usdt_minor × rate_micro / 10¹⁰ , mode )` — exact integer arithmetic, then one rounding step.
`usdt_minor = round( inr_minor × 10¹⁰ / rate_micro , mode )`.

Rounding mode is chosen by **who pays**, so rounding never works against the exchange's stated obligation and is always ≤ 1 minor unit:

| Computed value | Mode |
|---|---|
| Amount the exchange pays/delivers to client | `DOWN` |
| Amount the client pays/sends to exchange | `UP` |
| Route economic value (SELL: proceeds; BUY: cost) | SELL `DOWN`, BUY `UP` (conservative) |

The computed values are **stored** on the Quote and copied into the Trade. Nothing downstream recomputes them.

### 1.3 Direction formulas

`fixed_side` ∈ {`BASE` (USDT amount fixed), `QUOTE` (INR amount fixed)}.

**SELL_USDT** (client sends USDT, receives INR; expected `client_rate ≤ route_rate`)
- fixed BASE: `client_inr = conv(base, client_rate, DOWN)`
- fixed QUOTE: `base = conv⁻¹(client_inr, client_rate, UP)`; `client_inr` as requested
- `route_inr = conv(base, route_rate, DOWN)`
- `gross_margin_inr = route_inr − client_inr`

**BUY_USDT** (client pays INR, receives USDT; expected `client_rate ≥ route_rate`)
- fixed BASE: `client_inr = conv(base, client_rate, UP)`
- fixed QUOTE: `base = conv⁻¹(client_inr, client_rate, DOWN)`; `client_inr` as requested
- `route_inr = conv(base, route_rate, UP)`
- `gross_margin_inr = client_inr − route_inr`

Margin is denominated in INR in V1 (both route rates are INR/USDT).

Negative margin is allowed only with permission `quote:send_negative_margin` (OWNER) and a mandatory reason; it is audited and flagged in the queue.

### 1.4 Canonical check
SELL, base 100,000.000000 USDT, client ₹102.00, route ₹104.20:
- `client_inr = 100000000000 × 102000000 / 10¹⁰ = 1020000000` paise = **₹10,200,000.00**
- `route_inr = 100000000000 × 104200000 / 10¹⁰ = 1042000000` paise = **₹10,420,000.00**
- `margin = 22000000` paise = **₹220,000.00**

## 2. Invariants

### Pricing & quotes
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-01 | Client rate, route rate, reference rate are distinct fields; no code path assigns one from another without an explicit operator command | Separate columns + separate `Rate` brands (`ClientRate`, `RouteRate`, `ReferenceRate`) in kernel types | type tests; review |
| FI-02 | `gross_margin` is derived, never input | No margin field in any command schema; DB CHECK `gross_margin_inr_minor = (route_inr − client_inr)` for SELL and `(client_inr − route_inr)` for BUY on `quote` and `trade` | canonical 100k test; reverse test |
| FI-03 | A Quote's economic fields never change after `SENT` | Trigger rejects UPDATE of economic columns when status ≠ DRAFT; only `status`, `status_changed_at` mutable | mutation test |
| FI-04 | A quote can be accepted only if `status = SENT` and `statement_timestamp() < expires_at` | Checked under `FOR UPDATE` lock in accept command; expiry job requires `expires_at <= now()` under same lock | accept at T−1ms; accept at T+1ms |
| FI-07 | A link acceptance **or rejection** requires a `PENDING`, unexpired, matching acceptance challenge for that quote and an authorized client user; the challenge is consumed in the same transaction and decides at most one quote. No unauthenticated request changes quote state; link "Not now" is client-side only | `quote.accept_via_link` / `quote.reject_via_link` are the only LINK paths; CHECK `(accepted_via <> 'LINK' AND rejected_via <> 'LINK') OR acceptance_challenge_id IS NOT NULL`; link quotes: CHECK validity ≥ 120 s at link creation; unique `quote.acceptance_challenge_id`; link GET handlers are read-only (no write grants used) | view doesn't accept or reject; local decline leaves quote SENT; wrong/expired/reused OTP; OTP verified after quote expiry rejected |
| FI-05 | At most one accepted quote per TradeRequest; at most one Trade per Quote | Partial unique index `quote(trade_request_id) WHERE status='ACCEPTED'`; unique `trade(quote_id)` | double accept; two concurrent accepts |
| FI-06 | At most one live (`SENT`) quote per TradeRequest | Partial unique index `WHERE status='SENT'`; sending a counter cancels the previous SENT quote in the same txn | counter race |

### Trades & history
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-10 | Trade economics are frozen at acceptance | `trade_economics` row inserted once; table has no UPDATE grant for app role + trigger | rate change after accept doesn't alter trade |
| FI-11 | Rate changes never recalculate existing quotes/trades | Rate snapshots are append-only rows; quotes reference snapshot id and copy values | same |
| FI-12 | Any correction is a new `financial_adjustment` with compensating ledger journal; original rows untouched | No UPDATE on economics/ledger; adjustment command posts reversal + new entries; "effective terms" = original ⊕ adjustments | adjustment preserves history |
| FI-13 | Status changes only via state machine transitions | Transition table in code + DB CHECK on allowed `(from,to)` pairs via trigger consulting `trade_transition` whitelist | property test: random command sequences never reach invalid state |

### Settlement
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-20 | Σ(non-failed, non-cancelled payout legs) ≤ payout obligation (after adjustments) | Leg create/amount commands lock the trade row and check; deferred constraint trigger recomputes on commit | over-allocation attempt; concurrent leg creation |
| FI-21 | Trade is COMPLETED iff Σ(confirmed payout legs, any payer) = obligation AND Σ(confirmed client legs) − Σ(confirmed `EXCESS` refunds) = client obligation (after adjustments). An excess still owed to the client keeps the trade open | Completion command asserts both (`advanceTrade`, `payout_leg.confirm`, `refund_leg.confirm` of an excess); trigger rejects `status=COMPLETED` otherwise (restated in 0028) | partial settlement; multi-leg completion; excess refund (paid in full, open until the excess is back) |
| FI-22 | A UTR/reference identifies at most one fiat transfer per rail | Unique index `fiat_transfer(rail, utr_normalized)` (uppercased, trimmed) | duplicate UTR |
| FI-23 | A blockchain transfer (network, tx_hash, log_index) exists once and is linked to at most one client-side target (settlement leg or exception) and at most one route settlement | Unique `crypto_transfer(network, tx_hash, log_index)`; `transfer_allocation` unique on `(transfer, dimension)` | same tx on two trades; duplicate webhook |
| FI-27 | One real movement = one evidence row = one journal. Legs, route settlements and allocations never post journals | Posting keys exist only as `fiat:{f}:confirm` / `crypto:{x}:confirm` for movements; posting rule table has no leg- or route-settlement-keyed rules; unique `ledger_journal(posting_key)` | direct payout posts exactly one journal; retry posts none |
| FI-28 | A movement may satisfy at most one client settlement leg and at most one route settlement, each for the full movement amount (no splitting one UTR/tx across legs of the same dimension). It may satisfy both only when `payer = ROUTE` and `payee = CLIENT` (`DIRECT_TO_CLIENT`) | `transfer_allocation(transfer_kind, transfer_id, dimension)` unique where dimension ∈ {CLIENT, ROUTE}; CHECK `amount = transfer.amount`; trigger rejects ROUTE+CLIENT pair unless payer/payee is route→client | same UTR linked to two legs rejected; exchange-account payout cannot reduce route obligation; direct payout counted once per dimension |
| FI-24 | USDT is CONFIRMED only when in a solidified block, receipt `SUCCESS`, contract = configured USDT contract, `to` = the expected destination (trade's assigned deposit address; for route settlements the route's registered address or our treasury wallet) | Confirmation job checks all four; state machine forbids DETECTED→CONFIRMED otherwise | seen-not-final; wrong contract; wrong destination |
| FI-26 | Client USDT is attributed to a trade only through that trade's open deposit assignment; each SELL trade has exactly one assignment and each address at most one open assignment | Unique `deposit_assignment(trade_id)`; partial unique on open assignment per address; no allocation API accepts (amount, sender) as matching input | two open trades never share an address; funds to cooled-down / unassigned address go to suspense |
| FI-25 | Client never double-paid: a payout leg can reach CONFIRMED once; failed legs can't be re-confirmed; retry = new leg; a trade never pays out and unwinds at once; refunds planned, in flight or done never exceed the confirmed client funds; excess refunds planned, in flight or done never exceed what arrived beyond the receivable, and none is planned on top of an unwind; a USDT payout the chain already made final cannot be failed | Leg state machine; unique confirmation per leg; unwind/payout exclusivity checked under the trade lock; deferred triggers `settlement_leg_refunds_within_received` (IX025) and `settlement_leg_excess_within_overpayment` (IX093) | failed leg then retry; refund refused while a payout is in flight; payout refused once a refund is planned; excess over the overpayment refused (command and raw insert) |
| FI-80 | A client payout goes to the destination in force: the one accepted, or the latest change approved by a second person, which is the same client's and ACTIVE. A change waits for a payout already sent to the old destination; one only planned there is cancelled on the record | `trade.approve_destination_change` (⧗✱); `trade_destination_change` append-only; IX092 on the change and on every payout leg insert | destination-change suite (other client, archived, requester, in flight, raw inserts) |

### Capacity
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-30 | For each INR account and IST day, no reservation or unreserved payout may make `used + reserved > working_capacity` | Row `inr_account_day(account_id, day)` locked `FOR UPDATE` for every reserve/consume/release; the check runs under that lock. Capacity may be *lowered* below current commitments by an audited command — that never cancels anything silently; it sets remaining < 0, blocks new reservations and opens a `ROUTE_CAPACITY_CHANGED` exception | two operators reserving last capacity concurrently; capacity lowered mid-day |
| FI-31 | Reservations are released exactly once on cancellation/expiry/leg failure | Reservation state machine (`ACTIVE→CONSUMED|RELEASED`); release is state-guarded | cancel releases capacity; double release |
| FI-32 | PAUSED/UNAVAILABLE accounts accept no new reservations | Checked under lock | reserve on paused account |
| FI-33 | Treasury: `reserved ≤ observed` per wallet at reservation time; over-commit is an exception, not silent. **Legacy only since D-16**: no trade accepted after migration 0025 reserves treasury USDT (FI-71), and a wallet's `observed` is now only ever its latest recorded reading (FI-78) | Lock wallet row; CHECK; IX089 | BUY reservation race (legacy) |

### Ledger
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-40 | Every journal balances per currency: Σdebits = Σcredits | Deferred constraint trigger on `ledger_entry` at commit; journal insert API only accepts balanced sets | unbalanced post rejected |
| FI-41 | Ledger entries are append-only | App DB role: INSERT+SELECT only; triggers reject UPDATE/DELETE | attempted update |
| FI-42 | A business event or movement posts at most once | Unique `ledger_journal(posting_key)` e.g. `trade:{id}:accept`, `fiat:{id}:confirm`, `crypto:{id}:confirm` | retry posts once |
| FI-43 | Realized gross margin = Σ credits to `REVENUE:GROSS_MARGIN`; posted only at trade completion (from `DEFERRED_MARGIN`), independent of route settlement status | Only `trade.complete` and approved adjustments post to that account | P&L counts realized only; residual route receivable does not delay realization |
| FI-44 | Global check: Σ all balances per currency = 0 | Scheduled check + alert | nightly check test |

### Routes (`DECISIONS.md D-03`)
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-60 | Route obligation amounts and execution mode equal the trade's frozen route economics and never change; the obligation is recognized in the ledger at acceptance | Copied in the acceptance txn together with `trade:{t}:accept`; insert-once columns (trigger) | rate change / adjustment doesn't mutate obligation (adjustments post `adj:{id}`) |
| FI-61 | Σ allocations per route settlement ≤ settlement amount; Σ allocations per obligation side ≤ obligation side amount — including direct-to-client movements | Lock obligation → settlement rows (lock order); deferred check trigger | over-allocation; concurrent allocation; direct payout larger than route remaining rejected |
| FI-62 | Client trade state depends only on client obligations. A direct payout advances the trade through its client-leg link; the route allocation of the same movement never gates completion | Trade transitions read client legs only; direct confirm command updates both in one txn but completion predicate (FI-21) uses client legs | trade COMPLETED while route obligation PARTIALLY_SETTLED with ₹220,000 remaining |
| FI-63 | V1 routes use `settlement_model = PER_TRADE` with `execution_mode ∈ {DIRECT_TO_CLIENT, TO_EXCHANGE}` | Validation on `liquidity_route`; quote creation rejects other models | configure PREFUNDED rejected |
| FI-64 | For each route obligation and side: obligation remaining = ledger balance of the route account lines carrying that `route_obligation_id` | Reconciliation job + integration assertion after every route-affecting command in tests | walkthrough §3.5 at every step |
| FI-65 | `TO_EXCHANGE` obligations accept only route→exchange and exchange→route movements; `DIRECT_TO_CLIENT` obligations additionally accept route→client movements; route→client payouts require a client payout leg with `payer = ROUTE` | Command validation + trigger on `transfer_allocation` | direct payout on TO_EXCHANGE route rejected |

### Counterparty funding (`DECISIONS.md D-16`, ADR 0016)
The platform never advances its own USDT or INR: a client is paid with the counterparty's money and the
counterparty with the client's, each from the place it arrived (pass-through). Trades accepted before migration 0025
keep `LEGACY_EXCHANGE_FUNDED` and the rules they were accepted under.

| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-70 | Every trade has exactly one insert-once funding model; trades created after 0025 are `COUNTERPARTY_FUNDED` | `trade_funding` PK; AFTER INSERT trigger on `trade`; IX082 refuses anything else; append-only | properties, acceptance |
| FI-71 | A counterparty-funded trade never holds a treasury reservation | IX083 on `treasury_reservation`; acceptance does not reserve | acceptance (IX083), counterparty-funding (zero treasury) |
| FI-72 | An exchange-paid client payout of a counterparty-funded trade is covered by earmarks on the same trade's counterparty funds, same asset and location | `allocateFunding` in `payout_leg.create`; deferred IX086 | payout before delivery refused (command + raw insert) |
| FI-73 | A `TO_ROUTE` payment of a counterparty-funded trade is covered by earmarks on the same trade's client funds, same asset and location | allocation in `route_settlement.record`; IX086 | counterparty-funding (both directions) |
| FI-74 | A refund of a counterparty-funded trade is covered by earmarks on its client funds | `refund_leg.create`; IX086 | refunds never exceed client funds |
| FI-75 | A source is never earmarked beyond its amount; an earmark stays ACTIVE while its movement could still land | deferred IX085 under the source lock; IX086 releases only cancelled/failed uses | racing payouts / refund vs trader payment |
| FI-76 | Earmarks never cross trades and never draw on suspense, reserves or legacy reservations. A reserve reaches a trade only as its own trader's delivery, applied by two people (FI-81) | `funding_source` is trade-scoped confirmed movements only; IX084 | another trade's money and a Security Reserve never fund a trade |
| FI-77 | Delivery versus payment: nothing is paid to the counterparty before it delivered | `COUNTERPARTY_NOT_DELIVERED` under the trade lock; IX087 before insert | command and raw insert refused |
| FI-78 | A USDT outflow (payout, refund) needs a usable reading of its source address under the age limit — one source only below the D-05 threshold — showing it free after every outflow that reading does not reflect | `assertPhysicallyAvailable` in `payout_leg.send` / `refund_leg.create`; readings append-only; IX089 | availability suite (stale, contradicted, single source, subtracted once, outside movement) |
| FI-79 | Capacity holds, funding earmarks and the Security Reserve are separate quantities; none is read as another | separate tables and accounts | capacity is a commitment, not money |
| FI-81 | A route's delivery is the route's own money: the exchange's USDT or INR is never booked as a counterparty's delivery. The one exception is a trader's Security Reserve applied by two people to USDT one of its own orders still owes — never more than owed or than the reserve holds free, to the order's own address, from the trader's reserve address or a treasury wallet, posted once (Dr TRADER_RESERVE / Cr ROUTE_RECEIVABLE) | `trader_reserve.*` commands; IX094 (application), IX095 (route settlement insert; application ↔ settlement status at commit) | reserve-application suite (two people, amounts, wrong sender/amount, scanner path, raw inserts) |
| FI-82 | A trader reward is paid only out of realized margin free at the paying account — the leftovers of trades finished on both sides, less rewards paid or being paid there, and never beyond what the account holds past open trades' money. Principal, another trade's money and reserves never pay a reward | `trader_reward.record_payout` (`TRADER_REWARD_NOT_COVERED`); IX096 on insert, serialized per account | lifecycle suite (refused before the client is paid, at an account the trade never touched, one paisa over at commit) |
| FI-83 | A deposit into the shared Security Reserve address (D-17) is the reserve of exactly one trader — the one whose registered wallet (verified or under review) sent it and was on file before the transfer — or of nobody until the desk resolves it; never the trader who asked for it, and credited once, on finality | `inrp2p_reserve_sender_trader` in the scanner's detection and in `trader_reserve.claim_deposit` (block time from the chain); IX102 on every `crypto_transfer` insert into the shared address (the credited trader's registered wallet is the sender — the part of the rule time cannot change, so a later registration never blocks the scanner); one row per transfer (FI-23), one journal per movement | `self-service.int.test.ts` (attribution, a hash handed in twice and found by the scanner, another trader's hash, a wallet registered after the transfer, two traders with one wallet, raw inserts) |

### The exchange's own rails (ADR 0017)
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-90 | A quote leaves at least the policy's minimum net margin after the trader's reward and the network fee of its transfer; the fee (TRX at the chain's prices with buffers, valued at the quote's own rate and the published TRX price, rounded up) and the reward are inside the client rate, never added on top, and frozen with the quote — the reward with its order and basis points, which is exactly what the order starts with, the ledger accrues and the desk reports, whatever the programme says by acceptance | `quote.create` (`QUOTE_UNPROFITABLE` with the break-even rate; `NETWORK_FEES_UNKNOWN` on stale fees or price); `quote_network_fee` insert-once with IX103 (net = gross − reward − fee, quote still DRAFT) and IX113 (the reward is its order's; a trader's route names its order); `startOrderForTrade` takes the frozen terms and IX113 refuses an order started with others; `quote.send` refuses a quote without them | `rails.int.test.ts` (unprofitable quote never created, frozen fee, programme changed between quote and acceptance: order, accrual and desk agree; raw inserts), `requests-quotes.int.test.ts` (break-even) |
| FI-91 | No transfer is signed that nobody prefunded: a trade's acceptance holds the worst case of its transfers from its funder (a trader's network deposit, or the platform budget for a desk route), and a funder never commits more TRX than it has free. The TRX budget is its own book — never trading money, never the Security Reserve, never another funder's — and a deposit is the funder's whose registered wallet sent it, credited once | `network.hold` in acceptance under the funder's advisory lock; IX108 (deferred, same lock) on holds — and on a hold a person raises — top-ups and withdrawals; IX107 deposit attribution; IX109 funder of a send = funder of its trade's hold; routing excludes `NETWORK_DEPOSIT_SHORT` | `rails.int.test.ts` (racing acceptances, thin deposit excluded, budget wallet drained → BLOCKED) |
| FI-95 | Each USDT send of a trade has a fixed TRX cap — the fee its quote priced for a transfer the client's price pays for, one held transfer's cost for a refund — and the caps of a trade's open sends (with what finished ones drew) fit in its hold, so the return it may still need keeps its share. Its top-ups, retries and failed ones included, never draw past its cap: gas that rose or attempts that burned it block the send (`NETWORK_BUDGET_SHORT`) and never reach the funder's other TRX. A cap and a hold only rise, by a person with `network:manage`, with the reason | `planChainSend` (`networkCapFor`, `NETWORK_BUDGET_INSUFFICIENT`); the sender's fuelling step; IX114 (a top-up past its send's cap), IX115 (caps past the hold, a cap or hold that falls); `chain_send.raise_network_cap` (⧗) | `rails.int.test.ts` (dearer gas blocked then raised, retries stop at the cap with the deposit untouched, caps fit with the return's share, raw inserts and updates) |
| FI-92 | A signer's transfer is sent at most once: its signed bytes and txid are committed before broadcast; one live attempt per send; a new one only after the chain proves the old one failed or can never land (every provider NOT_FOUND past its expiration on the solidified head); an outcome nobody can prove keeps the send blocked, never cancelled. After the database changed underneath (FI-54) nothing is planned, approved, signed or broadcast — TRX top-ups and withdrawals no more than USDT — until the fence is lifted; a transaction signed before the change is then broadcast as the same bytes | unique live-attempt index, IX104 (attempt insert), IX105 (send transitions), `CHAIN_SEND_IN_FLIGHT`; `CHAIN_SEND_UNRESOLVED` case after 30 min; IX100 on attempt and send inserts, approvals and cap raises; `PAYOUTS_HELD` in the sender, the broadcast, the monitor's rebroadcast, `chain_send.approve` and `network_withdrawal.decide` | `rails.int.test.ts` (timeout, crash between sign and broadcast, swallowed transaction, lying provider, OUT_OF_ENERGY, concurrent signers, raw insert; a signed TRX top-up held through a restore fence and broadcast once after it) |
| FI-93 | A signer's payout, refund or route payment settles only through the confirmations an operator's evidence would go through — this trade's funding coverage, DVP, physical availability, the two-person threshold — and only on the chain's final success; no manual evidence is recorded for it | `settleSignedSendInTx`; IX106 (send insert: signable path, DVP for a route payment), IX110, IX111, IX112 (the send's movement is its confirmed attempt) | `rails.int.test.ts` (BUY and SELL end to end, refund) |
| FI-94 | A refund's network fee is never the client's: the second person who approves it says whether the trader whose side failed bears it or the platform does; what a funder spends for transfers it does not bear is paid back in INR at the trade's quoted TRX price, rounded down, with the trader's rewards and only from realized margin | `refund_leg.approve_send` (bearer TRADER/PLATFORM); `closeNetworkHold` posts `network_fee:{trade}:reimburse` (Dr EXPENSE:NETWORK_FEES / Cr LIAB:TRADER_REWARD_PAYABLE); FI-82 for its payment | `rails.int.test.ts` (refund borne by the trader: no reimbursement) |

### Traders (`TRADERS.md` §10)
A trader's order settles through an ordinary `TO_EXCHANGE` route obligation, so FI-60…FI-65 apply to it unchanged. The programme's own invariants (TR-01…TR-11: registered destinations only, held capacity = open orders, one order per request, quote = accepted order, trader-set rates, one subject per delivery address, reserve and rewards in the ledger, locked reserve never withdrawable, trader projections private, business-clock expiry) and their enforcement are listed there.

### Idempotency, audit & recovery
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-50 | Every financial mutation requires an idempotency key; replay returns original result; same key with different payload is rejected | `idempotency_key(scope, key)` unique with `request_hash` | double submit |
| FI-51 | Audit events are append-only and tamper-evident | INSERT-only grant, reject triggers, periodic hash-chain sealing (`audit_seal`) | attempted update; seal verification detects edit |
| FI-52 | Every state change commits with its audit event (and journal, when financial) or not at all | Single-transaction command pipeline; integration test asserts audit row exists for every transition | fault injection mid-command |
| FI-53 | The audit trail is provable against an archive the database cannot rewrite: every seal is exported, in contiguous ranges, to write-once storage, and the trail is verified against the archived seals — including re-hashing the events | `audit_seal_export` (IX099: contiguous, matching the seals), daily `audit_seal_export` job under Object Lock, `verifyAuditArchive` (`audit_archive_failures`) | audit-archive suite (gap, changed seal, events rewritten and re-sealed, a range written but not recorded) |
| FI-54 | A database that is not the one the workers last wrote to (recovered, failed over, moved) authorises no money out — no exchange-paid payout or refund marked sent, no reserve application approved, no transfer of the exchange's signer planned, approved, signed or broadcast (USDT or TRX, FI-92) — until one person has recorded the reconciliation with the bank and the chain and a second has approved it. Evidence of a payment already made is always recorded | `inrp2p_payouts_held()` (cluster and timeline vs the last heartbeat; a raised `restore_fence`); `PAYOUTS_HELD` in the commands, IX100 in the database; lift IX101 | restore-fence suite (held before any worker, raised once, two people, evidence recorded); `scripts/pitr-drill.ts` |

## 3. Ledger (V1)

### 3.1 Posting principle: one movement, one journal
Every **real value movement** is exactly one evidence row — a `fiat_transfer` (unique `(rail, utr_normalized)`) or a `crypto_transfer` (unique `(network, tx_hash, log_index)`) — and posts **exactly one journal**, keyed by that evidence: `fiat:{f}:confirm` or `crypto:{x}:confirm`. Settlement legs, route settlements and allocations are *views of what a movement satisfied*; they never post journals of their own. The debit and credit accounts are chosen from the movement's `(payer, payee)` pair, so a direct route-to-client payout debits the client payable and credits the route receivable in the same two entries — it cannot be posted twice as a "client payout" and a "route settlement".

Non-movement business events post their own keyed journals: `trade:{t}:accept`, `trade:{t}:complete`, `trade:{t}:cancel`, `adj:{id}`, `adj:{id}:cancel`, and `trader_reward:{order}:accrue` (Dr `EXPENSE:TRADER_REWARDS` / Cr `LIAB:TRADER_REWARD_PAYABLE`, no trade dimension), and `network_fee:{trade}:reimburse` (Dr `EXPENSE:NETWORK_FEES` / Cr `LIAB:TRADER_REWARD_PAYABLE`, no trade dimension, ADR 0017).

All entries carry dimensions `trade_id` and, for route accounts, `route_obligation_id`, so balances can be read per trade and per obligation.

### 3.2 Chart of accounts
`{c}` client · `{a}` INR settlement account · `{w}` treasury wallet · `{r}` liquidity route. All accounts are per currency.

| Account | Type | Meaning |
|---|---|---|
| `ASSET:INR_SETTLEMENT:{a}` (INR) | asset | Movements through the exchange's INR settlement accounts |
| `ASSET:TREASURY_USDT:{w}` (USDT) | asset | USDT in treasury wallets and deposit addresses |
| `ASSET:CLIENT_RECEIVABLE:{c}` | asset | What the client owes on accepted trades |
| `LIAB:CLIENT_PAYABLE:{c}` | liability | What is owed to the client on accepted trades |
| `ASSET:ROUTE_RECEIVABLE:{r}` | asset | What the route owes (recognized at acceptance) |
| `LIAB:ROUTE_PAYABLE:{r}` | liability | What the exchange owes the route (recognized at acceptance) |
| `LIAB:DEFERRED_MARGIN` (INR) | liability | Gross margin of accepted, not yet completed trades |
| `REVENUE:GROSS_MARGIN` (INR) | revenue | Realized gross margin |
| `ASSET:ROUTE_PREFUND:{r}` | asset | Reserved for `PREFUNDED`; unused in V1 |
| `EXPENSE:FEES` | expense | Explicit fee lines (V1: zero) |
| `EXPENSE:NETWORK_FEES` (INR) | expense | TRON network fees the exchange's signer burned for trades, paid back to the trader that prefunded them (ADR 0017); TRX itself is kept in `network_budget_entry`, not the ledger |
| `SUSPENSE:UNALLOCATED` | suspense | Funds at an address without an open deposit assignment, or directly at a treasury wallet |
| `LIAB:TRADER_RESERVE:{t}` (USDT) | liability | A trader's Security Reserve held by the exchange (`TRADERS.md` §8) |
| `LIAB:TRADER_REWARD_PAYABLE:{t}` (INR) | liability | Rewards accrued on a trader's completed orders, not yet paid |
| `EXPENSE:TRADER_REWARDS` (INR) | expense | Rewards the exchange pays traders |

### 3.3 Business-event journals
| posting_key | SELL_USDT (100,000 @ client 102.00, route 104.20) | BUY_USDT (100,000 @ client 102.00, route 100.00) |
|---|---|---|
| `trade:{t}:accept` | USDT: Dr CLIENT_RECEIVABLE 100,000 / Cr ROUTE_PAYABLE 100,000 · INR: Dr ROUTE_RECEIVABLE ₹10,420,000 / Cr CLIENT_PAYABLE ₹10,200,000 / Cr DEFERRED_MARGIN ₹220,000 | INR: Dr CLIENT_RECEIVABLE ₹10,200,000 / Cr ROUTE_PAYABLE ₹10,000,000 / Cr DEFERRED_MARGIN ₹200,000 · USDT: Dr ROUTE_RECEIVABLE 100,000 / Cr CLIENT_PAYABLE 100,000 |
| `trade:{t}:complete` | Dr DEFERRED_MARGIN ₹220,000 / Cr GROSS_MARGIN ₹220,000 | Dr DEFERRED_MARGIN ₹200,000 / Cr GROSS_MARGIN ₹200,000 |
| `trade:{t}:cancel` | Exact reversal of `accept`; allowed only when the trade and its route obligation carry no net confirmed movements (none, or fully refunded/returned) | same |
| `adj:{id}:cancel` | Exact reversal of a posted adjustment, posted with `trade:{t}:cancel` so a cancelled trade leaves every client, route and margin account at zero | same |
| `adj:{id}` | Reversal of affected lines + re-posting of corrected lines | same |

### 3.4 Movement journals (by payer → payee)
| Movement | Evidence | Journal | Satisfies |
|---|---|---|---|
| Client USDT → deposit address | crypto | Dr TREASURY_USDT / Cr CLIENT_RECEIVABLE | client first leg |
| Client INR → exchange account | fiat | Dr INR_SETTLEMENT / Cr CLIENT_RECEIVABLE | client first leg |
| Exchange account INR → client bank | fiat | Dr CLIENT_PAYABLE / Cr INR_SETTLEMENT | client payout leg |
| Treasury USDT → client wallet | crypto | Dr CLIENT_PAYABLE / Cr TREASURY_USDT | client payout leg |
| **Route INR → client bank (`DIRECT_TO_CLIENT`)** | fiat | **Dr CLIENT_PAYABLE / Cr ROUTE_RECEIVABLE** | client payout leg **and** route obligation (route side), in one command |
| **Route USDT → client wallet (`DIRECT_TO_CLIENT`)** | crypto | **Dr CLIENT_PAYABLE / Cr ROUTE_RECEIVABLE** | client payout leg **and** route obligation |
| Route INR → exchange account (`TO_EXCHANGE`) | fiat | Dr INR_SETTLEMENT / Cr ROUTE_RECEIVABLE | route obligation |
| Route USDT → treasury (`TO_EXCHANGE`) | crypto | Dr TREASURY_USDT / Cr ROUTE_RECEIVABLE | route obligation |
| Treasury USDT → route | crypto | Dr ROUTE_PAYABLE / Cr TREASURY_USDT | route obligation (exchange side) |
| Exchange account INR → route | fiat | Dr ROUTE_PAYABLE / Cr INR_SETTLEMENT | route obligation (exchange side) |
| Refund of received client funds | fiat/crypto | Dr CLIENT_RECEIVABLE / Cr TREASURY_USDT or INR_SETTLEMENT | refund leg (`REFUND_TO_CLIENT`, `UNWIND`), exception resolution |
| Return of an overpayment | fiat/crypto | Dr CLIENT_RECEIVABLE / Cr TREASURY_USDT or INR_SETTLEMENT — the same rule: the first-leg journal credited the receivable with everything that arrived, and this clears the credit the excess left; nothing earlier is rewritten | refund leg (`EXCESS`) to a destination named when it was planned |
| Trader USDT → its reserve address | crypto | Dr TREASURY_USDT / Cr TRADER_RESERVE | Security Reserve deposit (registered wallet only) |
| Treasury USDT → trader's registered wallet (reserve withdrawal) | crypto | Dr TRADER_RESERVE / Cr TREASURY_USDT | reserve withdrawal |
| Trader's reserve → its order's delivery address (applied, TD-21) | crypto | Dr TRADER_RESERVE / Cr ROUTE_RECEIVABLE (+ Dr TREASURY_USDT:{to} / Cr TREASURY_USDT:{from} when custody moved it between two wallets) | route obligation (route delivers), as the trader's delivery |
| Exchange account INR → trader's registered bank (reward) | fiat | Dr TRADER_REWARD_PAYABLE / Cr INR_SETTLEMENT | reward payout |

### 3.5 Canonical direct-settlement walkthrough (SELL, `DIRECT_TO_CLIENT`)
| Step | Journal | ROUTE_RECEIVABLE (INR) | CLIENT_PAYABLE (INR) | DEFERRED / REVENUE | Trade | Route obligation |
|---|---|---|---|---|---|---|
| Accept | `trade:accept` | ₹10,420,000 | ₹10,200,000 | ₹220,000 / 0 | AWAITING_FIRST_LEG | OPEN |
| 100,000 USDT confirmed | `crypto:{x}:confirm` | ₹10,420,000 | ₹10,200,000 | ₹220,000 / 0 | FIRST_LEG_CONFIRMED | OPEN |
| Route pays ₹10,200,000 to client, one UTR | `fiat:{f}:confirm` (only journal) | ₹220,000 | 0 | ₹220,000 / 0 | → COMPLETED (same command) | PARTIALLY_SETTLED (INR remaining ₹220,000; USDT side 100,000 open) |
| Completion | `trade:complete` | ₹220,000 | 0 | 0 / ₹220,000 | COMPLETED | PARTIALLY_SETTLED |
| Treasury sends 100,000 USDT to route | `crypto:{y}:confirm` | ₹220,000 | 0 | 0 / ₹220,000 | — | PARTIALLY_SETTLED (only INR ₹220,000 remaining) |
| Route pays residual ₹220,000 to exchange account (or audited adjustment) | `fiat:{g}:confirm` | 0 | 0 | 0 / ₹220,000 | — | SETTLED |

Invariant check at every row: `ledger balance of ROUTE_RECEIVABLE/ROUTE_PAYABLE for the obligation = obligation remaining per side` (FI-64).

## 4. P&L definitions

| Metric | Source | Includes |
|---|---|---|
| Realized gross margin (period) | Ledger credits to `REVENUE:GROSS_MARGIN` with `posted_at` in period (IST) | COMPLETED trades, net of margin adjustments |
| Completed volume (period) | `trade_economics.base_usdt` of trades completed in period (+ adjustments) | COMPLETED only |
| Average margin / USDT | realized margin ÷ completed USDT volume (displayed to 4 dp; computed in `bigint`, rounded HALF_EVEN for display only) | COMPLETED only |
| Open expected margin | Σ `gross_margin` snapshot of non-terminal trades | Never merged with realized |
| Trader rewards (period) | Ledger debits to `EXPENSE:TRADER_REWARDS` with `posted_at` in period (accrued when a trader order completes) | Every completed trader order |
| Recorded fees (period) | Ledger debits to `EXPENSE:FEES` (INR) in period | Bank charges once reconciliation records them; none in V1 so far |
| Net after rewards and recorded fees | realized gross margin − trader rewards − recorded fees | May be negative and is then shown negative; never hidden by a positive gross |
| Rewards owed / free margin (now) | `LIAB:TRADER_REWARD_PAYABLE` balance / Σ `inrp2p_inr_account_free_margin` over active accounts | An owed reward stays visible; a payout beyond free margin is refused (FI-82) |
| Not in the ledger, listed as not deducted | TRX/energy for transfers and the custody provider's fees (platform operating budget); bank charges until recorded | Never paid with client or trader money (ADR 0016 §6) |

## 5. What is deliberately not an invariant in V1

- `PREFUNDED` and `NET_SETTLED` route settlement models are not implemented; FI-63 prevents their use.
- Client pays the route directly (client → route) is not a V1 execution mode.
- Fees default to zero; the schema supports explicit fee lines.
