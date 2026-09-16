# INRP2P Exchange — Financial Invariants

Status: Phase 0 draft, for review.
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
- JSON: amounts serialize as decimal strings (`"10200000.00"`), never JSON numbers.

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
| FI-21 | Trade is COMPLETED iff Σ(confirmed payout legs) = obligation AND client leg confirmed = client obligation (after adjustments) | Completion command asserts both; trigger rejects `status=COMPLETED` otherwise | partial settlement; multi-leg completion |
| FI-22 | A UTR/reference identifies at most one fiat transfer per rail | Unique index `fiat_transfer(rail, utr_normalized)` (uppercased, trimmed) | duplicate UTR |
| FI-23 | A blockchain transfer (network, tx_hash, log_index) is attributed to at most one trade leg | Unique index on `crypto_transfer(network, tx_hash, log_index)`; allocation table unique on transfer | same tx on two trades; duplicate webhook |
| FI-24 | USDT is CONFIRMED only when in a solidified block, receipt `SUCCESS`, contract = configured USDT contract, `to` = assigned address | Confirmation job checks all four; state machine forbids DETECTED→CONFIRMED otherwise | seen-not-final; wrong contract; wrong destination |
| FI-25 | Client never double-paid: a payout leg can reach CONFIRMED once; failed legs can't be re-confirmed; retry = new leg | Leg state machine; unique confirmation per leg | failed leg then retry |

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
| FI-42 | A business event posts at most once | Unique `ledger_journal(posting_key)` e.g. `trade:{id}:accept`, `leg:{id}:confirm` | retry posts once |
| FI-43 | Realized gross margin = Σ credits to `REVENUE:GROSS_MARGIN_INR`; posted only at trade completion | Only `trade.complete` command posts to that account (posting rule table) | P&L counts realized only |
| FI-44 | Global check: Σ all balances per currency = 0 | Scheduled check + alert | nightly check test |

### Idempotency & audit
| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| FI-50 | Every financial mutation requires an idempotency key; replay returns original result; same key with different payload is rejected | `idempotency_key(scope, key)` unique with `request_hash` | double submit |
| FI-51 | Audit events are append-only and tamper-evident | INSERT-only grant, reject triggers, periodic hash-chain sealing (`audit_seal`) | attempted update; seal verification detects edit |
| FI-52 | Every state change commits with its audit event (and journal, when financial) or not at all | Single-transaction command pipeline; integration test asserts audit row exists for every transition | fault injection mid-command |

## 3. Ledger chart of accounts (V1)

All accounts are per currency. `{c}` = client id, `{t}` = trade id, `{a}` = INR settlement account id, `{w}` = treasury wallet id, `{r}` = liquidity route id.

| Account | Type | Meaning |
|---|---|---|
| `ASSET:INR_SETTLEMENT:{a}` (INR) | asset | Movements recorded through our INR settlement accounts |
| `ASSET:TREASURY_USDT:{w}` (USDT) | asset | USDT recorded in treasury wallets |
| `ASSET:CLIENT_RECEIVABLE:{c}` (USDT or INR) | asset | What the client owes us on accepted trades |
| `LIAB:CLIENT_PAYABLE:{c}` (INR or USDT) | liability | What we owe the client on accepted trades |
| `CLEARING:TRADE:{t}` (INR, USDT) | clearing | Trade-level clearing; zero at completion |
| `ASSET:ROUTE_RECEIVABLE:{r}` / `LIAB:ROUTE_PAYABLE:{r}` | asset/liability | Economic position against the liquidity route (see `DECISIONS.md D-03`) |
| `REVENUE:GROSS_MARGIN` (INR) | revenue | Realized gross margin |
| `EXPENSE:FEES` (INR/USDT) | expense | Fees, when recorded (V1: zero by default) |
| `SUSPENSE:UNALLOCATED` (INR/USDT) | suspense | Funds observed but not attributable (unexpected sender, no trade) |

### Posting rules — SELL_USDT (100k @ client 102.00, route 104.20)
| Event (posting_key) | Entries |
|---|---|
| `trade:{t}:accept` | Dr CLIENT_RECEIVABLE:{c} 100,000 USDT / Cr CLEARING:TRADE:{t} 100,000 USDT · Dr CLEARING:TRADE:{t} ₹10,200,000 / Cr CLIENT_PAYABLE:{c} ₹10,200,000 |
| `crypto:{x}:confirm` | Dr TREASURY_USDT:{w} amount / Cr CLIENT_RECEIVABLE:{c} amount |
| `leg:{l}:confirm` | Dr CLIENT_PAYABLE:{c} leg amount / Cr INR_SETTLEMENT:{a} leg amount |
| `trade:{t}:complete` | Dr ROUTE_RECEIVABLE:{r} ₹10,420,000 / Cr CLEARING:TRADE:{t} ₹10,200,000 / Cr REVENUE:GROSS_MARGIN ₹220,000 · Dr CLEARING:TRADE:{t} 100,000 USDT / Cr ROUTE_PAYABLE:{r} 100,000 USDT |

### Posting rules — BUY_USDT (100k @ client 102.00, route 100.00 → margin ₹200,000)
| Event | Entries |
|---|---|
| `trade:{t}:accept` | Dr CLIENT_RECEIVABLE:{c} ₹10,200,000 / Cr CLEARING:TRADE:{t} ₹10,200,000 · Dr CLEARING:TRADE:{t} 100,000 USDT / Cr CLIENT_PAYABLE:{c} 100,000 USDT |
| `fiat_in:{f}:confirm` | Dr INR_SETTLEMENT:{a} / Cr CLIENT_RECEIVABLE:{c} |
| `crypto_out:{x}:confirm` | Dr CLIENT_PAYABLE:{c} / Cr TREASURY_USDT:{w} |
| `trade:{t}:complete` | Dr CLEARING:TRADE:{t} ₹10,200,000 / Cr ROUTE_PAYABLE:{r} ₹10,000,000 / Cr REVENUE:GROSS_MARGIN ₹200,000 · Dr ROUTE_RECEIVABLE:{r} 100,000 USDT / Cr CLEARING:TRADE:{t} 100,000 USDT |

At completion `CLEARING:TRADE:{t}` is zero in both currencies, client receivable/payable for the trade are zero, and margin is realized. Cancellation before any confirmed funds posts `trade:{t}:cancel` = exact reversal of `accept`. Adjustments post `adj:{id}` with reversal of affected amounts and re-posting of new ones.

## 4. P&L definitions

| Metric | Source | Includes |
|---|---|---|
| Realized gross margin (period) | Ledger credits to `REVENUE:GROSS_MARGIN` with `posted_at` in period (IST) | COMPLETED trades, net of margin adjustments |
| Completed volume (period) | `trade_economics.base_usdt` of trades completed in period (+ adjustments) | COMPLETED only |
| Average margin / USDT | realized margin ÷ completed USDT volume (displayed to 4 dp; computed in `bigint`, rounded HALF_EVEN for display only) | COMPLETED only |
| Open expected margin | Σ `gross_margin` snapshot of non-terminal trades | Never merged with realized |

## 5. What is deliberately not an invariant in V1

- Route-side settlement (delivering USDT to / receiving INR from the route) is not operationally tracked beyond the economic position — see `DECISIONS.md D-03`.
- Fees default to zero; the schema supports explicit fee lines.
