# INRP2P Exchange — Product

Status: Phase 0 draft, for review. No production code may be written against this document until it is accepted.
Sources of truth: `docs/source/MASTER_PROMPT.md` (business/financial), `docs/source/DESIGN_SYSTEM_BRIEF.md` (visual/interaction).

## 1. What it is

**INRP2P Exchange — USDT ↔ INR OTC Exchange for India.**

An operational exchange product for professional counterparties who regularly move meaningful INR ↔ USDT volume: businesses, OTC operators, payment operators, brokers, gaming/forex/payment-industry clients.

It replaces: *Telegram / WhatsApp + calculator + spreadsheets + blockchain explorer + bank apps + manual trade tracking.*

It is **not**: an order book, a trading terminal, a P2P marketplace, an escrow product, a wallet, a consumer app, or an AI assistant.

## 2. The standard

The product is finished only when an operator can always answer, without reconstructing events by hand:

| Question | Where it is answered |
|---|---|
| What is the agreed rate? | Trade header (frozen from accepted Quote) |
| How much has arrived? | Client-leg progress (CryptoTransfer / FiatTransfer, confirmed only) |
| How much is still owed? | Settlement progress: obligation − confirmed payout legs |
| Which INR payouts were sent? | Settlement legs list |
| Which UTR belongs to which amount? | Each SettlementLeg row |
| What is the margin? | Trade economics snapshot (operator only) |
| What needs action now? | Operator Desk queue |

And a client arriving from a Telegram/WhatsApp link can understand and accept a 100,000 USDT quote in seconds.

## 3. Corridor (V1)

| Dimension | V1 value | Extensible? |
|---|---|---|
| Crypto asset | USDT | Yes — `asset` table, not an enum in code paths |
| Network | TRON / TRC20 (contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) | Yes — `network` table + adapter |
| Fiat | INR | Yes — currency precision table |
| Directions | `SELL_USDT` (client sells USDT, receives INR) and `BUY_USDT` (client pays INR, receives USDT) | Both fully modeled in V1 |

Launch UI may visually prioritize SELL_USDT. Database, state machines, ledger and pricing support both from day one.

## 4. Three price concepts (never mixed)

| Concept | Owner | Visible to client | Stored where |
|---|---|---|---|
| **Market reference rate** | External feed (optional) | Never as executable; may be shown only as clearly-labelled indicative context if the business decides to (default: not shown) | `rate_snapshot(kind=REFERENCE)` |
| **Route rate** | Operator (dealer), per route, per direction | **Never** | `rate_snapshot(kind=ROUTE)`; snapshotted into Quote |
| **Client quote rate** | Operator, per quote | Yes — it is the executable price | Quote (immutable), frozen into Trade |

Gross margin is always computed by the system from snapshots. It is never typed by a human.

## 5. Core business example (acceptance scenario)

Client sells 100,000 USDT. Route offers ₹104.20. Exchange quotes ₹102.00.

| | Value |
|---|---|
| Client amount | 100,000.000000 USDT |
| Client rate | ₹102.00 |
| Route rate | ₹104.20 |
| Client payout obligation | ₹10,200,000.00 |
| Route economic value | ₹10,420,000.00 |
| Gross margin | ₹220,000.00 |

Client sees only: 100,000 USDT → ₹10,200,000 at ₹102.00, TRC20, expiry.

## 6. Users

### Client-side
A **Client** is an organization (or individual professional) with one or more **client users**. Clients hold saved INR bank accounts and saved crypto wallets.

### Operator-side (RBAC)
| Role | Purpose |
|---|---|
| OWNER | Everything, including users/roles, capacity limits, adjustments approval |
| DEALER | Rates, quotes, counters, declines, client pricing |
| SETTLEMENT_OPERATOR | Capacity reservations, payout legs, UTRs, crypto confirmation linking |
| FINANCE | Ledger, P&L, reconciliation, adjustments, receipts, exports |
| SUPPORT | Clients, contacts, read trades (no economics), open exceptions |
| READ_ONLY | Read operational views; no margin/route rate unless explicitly granted |

Full permission matrix: `SECURITY.md §3`.

## 7. Surfaces

### 7.1 Client app (mobile-first quality)
Navigation: **Exchange** (default home) · **Trades** · **History** · **Bank & Wallets** · **Account**.
No dashboard before Exchange.

### 7.2 Quote Link — `inrp2p.com/q/{token}`
Single clean page opened from a messenger. Shows branding, direction, amount, rate, expected settlement amount, network, bank/wallet target (masked), expiry, Accept / Reject. Nothing else. See `DECISIONS.md D-01` for acceptance authentication.

### 7.3 Operator app (desktop-first)
Navigation: **Desk** · **Orders** · **Rates** · **INR** · **USDT** · **Clients** · **P&L** · **Settings**.
The Desk answers *what needs action right now?* — it is not an analytics dashboard.

### 7.4 Public site / SEO
Routes: `/`, `/usdt-to-inr`, `/inr-to-usdt`, `/sell-usdt-in-india`, `/buy-usdt-in-india`, `/usdt-otc-india`.
Hero: **Buy & Sell USDT in India.** Large trades. Locked rates. INR settlement. Actions: Sell USDT · Buy USDT · Request OTC Quote.
No fake reviews, volume, rates, settlement times, or regulatory claims. Not positioned as "High Risk Exchange" (high-risk businesses are an ICP, not the category).

## 8. Lifecycle in one paragraph

A client (or the operator on their behalf) creates a **TradeRequest** (direction, amount, fixed side, optional target rate, destination bank/wallet). A dealer answers with a firm **Quote** (quote, counter = quote at a rate different from the target, or decline). A Quote may be delivered in-app and/or via a **QuoteLink**. The client accepts before expiry; acceptance atomically creates an immutable **Trade** with frozen economics and posts the obligation to the **Ledger**. The client funds their leg (USDT on TRC20 for SELL; INR bank transfer for BUY). The system confirms the client leg (TRON finality for USDT; operator-confirmed UTR for INR). The exchange pays out through one or more **SettlementLegs** (INR legs drawing on reserved **INR settlement account capacity**, or USDT transfers from treasury wallets). When confirmed payouts equal the obligation, the Trade completes, margin is realized in the ledger, and an immutable **Receipt** (PDF + CSV + JSON) is generated. Anything off-path opens an **ExceptionCase** resolved only by explicit audited commands.

## 9. Feature scope V1

In: everything in the Master Prompt V1 scope — both directions, quotes + counters + links, trade/leg state machines, TRON monitoring, INR settlement accounts with capacity reservation, USDT treasury (watch-only), operator desk, rates desk, clients, exceptions, double-entry ledger, audit, RBAC + MFA, P&L, receipts, notifications (in-app + email), public SEO site.

Explicitly out: order book, charts, AI assistant, news, staking, cards, rewards, referrals, escrow, P2P marketplace, additional assets/chains, private-key custody, automated bank payouts (rail adapter boundary exists, V1 is operator-recorded), Telegram/WhatsApp/SMS notification delivery (abstraction exists).

## 10. Non-negotiables

1. Exact fixed-point money everywhere. No floats. (`FINANCIAL_INVARIANTS.md`)
2. Client never sees route rate, provider identity, margin, internal capacity, treasury.
3. Quotes immutable; accepted terms frozen into Trade; corrections only as audited FinancialAdjustments.
4. Status changes only through domain commands validated by state machines. (`STATE_MACHINES.md`)
5. Append-only ledger and audit.
6. Idempotency key on every financial mutation.
7. The system is an operational record of legitimate settlement. It is not, and must not be designed as, a mechanism for splitting payments to evade banking controls or reporting thresholds.
