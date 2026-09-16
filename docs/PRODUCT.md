# INRP2P Exchange — Product

Status: Phase 0, revision 3 (`DECISIONS.md` Revision 3). No production code until Phase 0 is accepted.
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
| How much is still owed? | Settlement progress: obligation − confirmed payout legs (paid by the exchange or directly by the route) |
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
A **Client** is an organization (or individual professional) with one or more **client users** (`CLIENT_ADMIN`, `CLIENT_TRADER`). Only client users with `can_accept_quotes` and a verified login email may accept quotes. Clients hold saved INR bank accounts and saved crypto wallets. Operator-maintained CRM contacts (Telegram, WhatsApp, notes) are not authentication channels.

### Operator-side (RBAC)
| Role | Purpose |
|---|---|
| OWNER | Everything, including users/roles, capacity limits, adjustments approval |
| DEALER | Rates, quotes, counters, declines, client pricing |
| SETTLEMENT_OPERATOR | Capacity reservations, payout legs (exchange-paid and route-direct), UTRs, crypto confirmation linking |
| FINANCE | Ledger, P&L, reconciliation, adjustments, receipts, exports, route positions and route settlements |
| SUPPORT | Clients, contacts, read trades (no economics), open exceptions |
| READ_ONLY | Read operational views; no margin/route rate unless explicitly granted |

Full permission matrix: `SECURITY.md §3`.

## 7. Surfaces

### 7.1 Client app (mobile-first quality)
Navigation: **Exchange** (default home) · **Trades** · **History** · **Bank & Wallets** · **Account**.
No dashboard before Exchange.

### 7.2 Quote Link — `inrp2p.com/q/{token}`
Single clean page opened from a messenger. Shows branding, direction, amount, rate, expected settlement amount, network, bank/wallet target (masked), expiry, Accept / Reject. Nothing else.

Viewing the link never changes the quote. **Accept** — and formal **Reject** — require a short-lived one-time code sent to the verified email of an authorized client user; verification and the state change happen in one atomic step before quote expiry. An unverified "Not now" only dismisses the page locally; the quote stays live until authenticated rejection, desk cancellation, supersession or expiry. Link quotes default to 180 s validity (minimum 120 s); the code never extends expiry (`DECISIONS.md D-01`, `D-15`).

### 7.3 Operator app (desktop-first)
Navigation: **Desk** · **Orders** · **Rates** · **INR** · **USDT** · **Clients** · **P&L** · **Settings**.
The Desk answers *what needs action right now?* — it is not an analytics dashboard.

### 7.4 Public site / SEO
Routes: `/`, `/usdt-to-inr`, `/inr-to-usdt`, `/sell-usdt-in-india`, `/buy-usdt-in-india`, `/usdt-otc-india`.
Hero: **Buy & Sell USDT in India.** Large trades. Locked rates. INR settlement. Actions: Sell USDT · Buy USDT · Request OTC Quote.
No fake reviews, volume, rates, settlement times. No regulatory claims of any kind until confirmed by India counsel (`DECISIONS.md D-07`). Not positioned as "High Risk Exchange" (high-risk businesses are an ICP, not the category).

## 8. Lifecycle in one paragraph

A client (or the operator on their behalf) creates a **TradeRequest** (direction, amount, fixed side, optional target rate, destination bank/wallet). A dealer answers with a firm **Quote** (quote, counter = quote at a rate different from the target, or decline). A Quote may be delivered in-app and/or via a **QuoteLink**. The client accepts before expiry; acceptance atomically creates an immutable **Trade** with frozen economics and posts the obligation to the **Ledger**. On acceptance the trade also receives a **unique TRC20 deposit address** from the custody adapter (SELL) and a separate **route obligation** frozen from the route economics. The client funds their leg (USDT on TRC20 to that address for SELL; INR bank transfer for BUY). The system confirms the client leg (TRON finality for USDT; operator-confirmed UTR for INR). The client is paid through one or more **SettlementLegs**: paid by the exchange (INR legs drawing on reserved **INR settlement account capacity**, or USDT from treasury wallets) or, on `DIRECT_TO_CLIENT` routes, paid **directly by the liquidity route** to the client's saved bank account/wallet. A direct payout is one real transfer with one UTR: it completes the client leg and reduces the route obligation in the same step, recorded and posted once. When confirmed payouts equal the obligation, the Trade completes, margin is realized in the ledger, and an immutable **Receipt** (PDF + CSV + JSON) is generated. Anything off-path opens an **ExceptionCase** (a hold overlay — the trade keeps its lifecycle state) resolved only by explicit audited commands. Settlement with the liquidity route is tracked separately through **route settlements** allocated to route obligations; the client trade never waits for it. Example: route pays the client ₹10,200,000 directly → trade completes, ₹220,000 margin is realized, and ₹220,000 remains receivable from the route until settled.

## 9. Feature scope V1

In: everything in the Master Prompt V1 scope — both directions, quotes + counters + links (OTP-verified acceptance), unique deposit address per SELL trade via custody adapter, route obligations + manually recorded route settlements (`PER_TRADE` model; execution modes `DIRECT_TO_CLIENT` and `TO_EXCHANGE`), trade/leg state machines, TRON monitoring, INR settlement accounts with capacity reservation, USDT treasury (watch-only), operator desk, rates desk, clients, exceptions, double-entry ledger, audit, RBAC + MFA, P&L, receipts, notifications (in-app + email), public SEO site.

Explicitly out: `PREFUNDED` / `NET_SETTLED` route settlement models (schema-ready, not implemented), in-house KYC workflow (hooks only), order book, charts, AI assistant, news, staking, cards, rewards, referrals, escrow, P2P marketplace, additional assets/chains, private-key custody, automated bank payouts (rail adapter boundary exists, V1 is operator-recorded), Telegram/WhatsApp/SMS notification delivery (abstraction exists).

## 10. Non-negotiables

1. Exact fixed-point money everywhere. No floats. (`FINANCIAL_INVARIANTS.md`)
2. Client never sees route rate, provider identity, margin, internal capacity, treasury.
3. Quotes immutable; accepted terms frozen into Trade; corrections only as audited FinancialAdjustments.
4. Status changes only through domain commands validated by state machines. (`STATE_MACHINES.md`)
5. Append-only ledger and audit.
6. Idempotency key on every financial mutation.
7. No regulatory claims anywhere in the product until confirmed by India counsel.
7a. One real transfer (one UTR / one on-chain transfer) is recorded once and posted once, whatever it satisfies.
7b. No unauthenticated quote state change from a link.
8. INR displayed with international grouping (`₹10,200,000`); stored and exchanged locale-free.
9. USDT attribution only by unique per-trade deposit address — never by amount or sender matching.
10. The system is an operational record of legitimate settlement. It is not, and must not be designed as, a mechanism for splitting payments to evade banking controls or reporting thresholds.
