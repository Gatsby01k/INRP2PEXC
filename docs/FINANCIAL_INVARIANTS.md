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
| FI-21 | Trade is COMPLETED iff Σ(confirmed payout legs, any payer) = obligation AND client leg confirmed = client obligation (after adjustments) | Completion command asserts both; trigger rejects `status=COMPLETED` otherwise | partial settlement; multi-leg completion |
| FI-22 | A UTR/reference identifies at most one fiat transfer per rail | Unique index `fiat_transfer(rail, utr_normalized)` (uppercased, trimmed) | duplicate UTR |
| FI-23 | A blockchain transfer (network, tx_hash, log_index) exists once and is linked to at most one client-side target (settlement leg or exception) and at most one route settlement | Unique `crypto_transfer(network, tx_hash, log_index)`; `transfer_allocation` unique on `(transfer, dimension)` | same tx on two trades; duplicate webhook |
| FI-27 | One real movement = one evidence row = one journal. Legs, route settlements and allocations never post journals | Posting keys exist only as `fiat:{f}:confirm` / `crypto:{x}:confirm` for movements; posting rule table has no leg- or route-settlement-keyed rules; unique `ledger_journal(posting_key)` | direct payout posts exactly one journal; retry posts none |
| FI-28 | A movement may satisfy at most one client settlement leg and at most one route settlement, each for the full movement amount (no splitting one UTR/tx across legs of the same dimension). It may satisfy both only when `payer = ROUTE` and `payee = CLIENT` (`DIRECT_TO_CLIENT`) | `transfer_allocation(transfer_kind, transfer_id, dimension)` unique where dimension ∈ {CLIENT, ROUTE}; CHECK `amount = transfer.amount`; trigger rejects ROUTE+CLIENT pair unless payer/payee is route→client | same UTR linked to two legs rejected; exchange-account payout cannot reduce route obligation; direct payout counted once per dimension |
| FI-24 | USDT is CONFIRMED only when in a solidified block, receipt `SUCCESS`, contract = configured USDT contract, `to` = the expected destination (trade's assigned deposit address; for route settlements the route's registered address or our treasury wallet) | Confirmation job checks all four; state machine forbids DETECTED→CONFIRMED otherwise | seen-not-final; wrong contract; wrong destination |
| FI-26 | Client USDT is attributed to a trade only through that trade's open deposit assignment; each SELL trade has exactly one assignment and each address at most one open assignment | Unique `deposit_assignment(trade_id)`; partial unique on open assignment per address; no allocation API accepts (amount, sender) as matching input | two open trades never share an address; funds to cooled-down / unassigned address go to suspense |
| FI-25 | Client never double-paid: a payout leg can reach CONFIRMED once; failed legs can't be re-confirmed; retry = new leg; a trade never pays out and refunds at once; a USDT payout the chain already made final cannot be failed | Leg state machine; unique confirmation per leg; refund/payout exclusivity checked under the trade lock | failed leg then retry; refund refused while a payout is in flight; payout refused once a refund is planned |

### Capacity
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-30 | For each INR account and IST day, no reservation or unreserved payout may make `used + reserved > working_capacity` | Row `inr_account_day(account_id, day)` locked `FOR UPDATE` for every reserve/consume/release; the check runs under that lock. Capacity may be *lowered* below current commitments by an audited command — that never cancels anything silently; it sets remaining < 0, blocks new reservations and opens a `ROUTE_CAPACITY_CHANGED` exception | two operators reserving last capacity concurrently; capacity lowered mid-day |
| FI-31 | Reservations are released exactly once on cancellation/expiry/leg failure | Reservation state machine (`ACTIVE→CONSUMED|RELEASED`); release is state-guarded | cancel releases capacity; double release |
| FI-32 | PAUSED/UNAVAILABLE accounts accept no new reservations | Checked under lock | reserve on paused account |
| FI-33 | Treasury: `reserved ≤ observed` per wallet at reservation time; over-commit is an exception, not silent | Lock wallet row; CHECK | BUY reservation race |

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

### Idempotency & audit
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-50 | Every financial mutation requires an idempotency key; replay returns original result; same key with different payload is rejected | `idempotency_key(scope, key)` unique with `request_hash` | double submit |
| FI-51 | Audit events are append-only and tamper-evident | INSERT-only grant, reject triggers, periodic hash-chain sealing (`audit_seal`) | attempted update; seal verification detects edit |
| FI-52 | Every state change commits with its audit event (and journal, when financial) or not at all | Single-transaction command pipeline; integration test asserts audit row exists for every transition | fault injection mid-command |

## 3. Ledger (V1)

### 3.1 Posting principle: one movement, one journal
Every **real value movement** is exactly one evidence row — a `fiat_transfer` (unique `(rail, utr_normalized)`) or a `crypto_transfer` (unique `(network, tx_hash, log_index)`) — and posts **exactly one journal**, keyed by that evidence: `fiat:{f}:confirm` or `crypto:{x}:confirm`. Settlement legs, route settlements and allocations are *views of what a movement satisfied*; they never post journals of their own. The debit and credit accounts are chosen from the movement's `(payer, payee)` pair, so a direct route-to-client payout debits the client payable and credits the route receivable in the same two entries — it cannot be posted twice as a "client payout" and a "route settlement".

Non-movement business events post their own keyed journals: `trade:{t}:accept`, `trade:{t}:complete`, `trade:{t}:cancel`, `adj:{id}`, `adj:{id}:cancel`.

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
| `SUSPENSE:UNALLOCATED` | suspense | Funds at an address without an open deposit assignment, or directly at a treasury wallet |

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
| Refund of received client funds | fiat/crypto | Dr CLIENT_RECEIVABLE / Cr TREASURY_USDT or INR_SETTLEMENT | refund leg (`REFUND_TO_CLIENT`), exception resolution |

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

## 5. What is deliberately not an invariant in V1

- `PREFUNDED` and `NET_SETTLED` route settlement models are not implemented; FI-63 prevents their use.
- Client pays the route directly (client → route) is not a V1 execution mode.
- Fees default to zero; the schema supports explicit fee lines.
