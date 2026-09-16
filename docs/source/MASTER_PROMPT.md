# INRP2P Exchange — Master Prompt

## Source of truth

Build a new production-grade product from zero.

**Product name:** INRP2P Exchange  
**Public positioning:** USDT ↔ INR OTC Exchange for India  
**Primary market:** India  
**Primary users:** businesses, OTC operators, payment operators, brokers, gaming/forex/payment-industry clients, and other professional customers who regularly exchange meaningful INR ↔ USDT volumes.

Forget every previous version of INRP2P.

Do not reuse the old P2P marketplace, DealSafe, rewards, referrals, social P2P, escrow, consumer marketplace, or old navigation concepts.

This is a new product.

---

## Mission

Build the best operational INR ↔ USDT exchange product for the way this market actually works today.

Do not build a Binance clone.  
Do not build an order book.  
Do not build trading charts.  
Do not build an AI assistant.  
Do not add crypto news, staking, cards, gamification, generic fintech features, or decorative crypto functionality.

The product must replace the operational mess of:

**Telegram / WhatsApp + calculator + spreadsheets + blockchain explorer + bank apps + manual trade tracking**

A client should be able to request or receive a rate, accept it, send or receive funds, and track settlement.

An exchange operator should be able to manage rates, trades, INR payout capacity, USDT, clients, settlement legs, and margin from one system.

---

## Core business example

A client has **100,000 USDT** and wants INR.

An underlying route offers the exchange **₹104.20 / USDT**.

The exchange quotes the client **₹102.00 / USDT**.

Client receives:

**₹10,200,000**

Underlying route economics:

**₹10,420,000**

Gross exchange margin:

**₹220,000**

The client must never see the route rate or internal exchange margin.

The operator must immediately see:

- Client amount: 100,000 USDT
- Client rate: ₹102.00
- Route rate: ₹104.20
- Client payout: ₹10,200,000
- Gross margin: ₹220,000

**Client rate and route rate are separate concepts everywhere in the system.**

Do not hard-code this only for SELL USDT. Build the pricing model correctly for both:

- USDT → INR
- INR → USDT

All amounts, rates, fees, and P&L must use exact decimal/fixed-point arithmetic. Never use floating-point arithmetic for money.

---

## Product model

There are three different price concepts and they must never be mixed:

### 1. Market reference rate
Optional external reference only.

### 2. Route rate
The actual economic price available to the exchange from an underlying liquidity/settlement route.

### 3. Client quote rate
The final price offered and locked for the client.

The operator controls the client quote.

The system calculates expected margin before the quote is sent.

---

## V1 scope

Build both trade directions into the domain model:

- **SELL USDT → RECEIVE INR**
- **BUY USDT → PAY INR**

The initial launch may visually prioritize SELL USDT because it is the first operational corridor, but the architecture must support both directions without redesigning the database or state machine later.

Initial crypto:
- USDT

Initial network:
- TRON / TRC20

Initial fiat:
- INR

Do not add additional assets or chains until this corridor works properly.

---

## Client experience

The client product should be extremely simple.

Primary navigation:

- Exchange
- Trades
- History
- Bank & Wallets
- Account

Do not present a generic dashboard before Exchange.

Exchange is the default home surface.

### Example SELL flow

Amount:

`100,000 USDT`

Receive to:

`saved INR bank account`

Optional:

`Target rate`

Button:

`Request quote`

The request goes to the operator desk.

The operator can:

- Quote
- Counter
- Decline

When a firm quote is returned, the client sees:

- Sell: 100,000 USDT
- Receive: ₹10,200,000
- Rate: ₹102.00
- Network: TRC20
- Estimated settlement
- Quote expiry countdown
- Accept Quote

The client sees only the final client price.

Never reveal:

- route rate
- provider identity
- exchange margin
- internal account capacity
- internal treasury information

---

## Quote system

Quotes are first-class immutable financial objects.

A quote must contain at minimum:

- unique quote ID
- client
- direction
- base amount
- fiat amount
- client rate
- route rate snapshot
- gross margin snapshot
- network
- bank account
- wallet
- creation time
- expiry time
- created by
- status

Statuses:

- DRAFT
- SENT
- ACCEPTED
- EXPIRED
- REJECTED
- CANCELLED

An expired quote cannot be accepted.

Accepting a quote must be atomic and idempotent.

Once accepted, the economic terms are frozen into the Trade.

Changing a live trade's rate must never silently mutate the original accepted quote.

Any correction must be an explicit audited adjustment.

---

## Quote links

A core feature is a private shareable quote link.

An operator can create:

- 100,000 USDT
- ₹102.20
- TRC20
- valid for 90 seconds

and receive a secure link such as:

`inrp2p.com/q/XXXXXXXX`

The link can be sent through Telegram, WhatsApp, or any messenger.

The customer opens a clean page showing only:

- amount
- rate
- expected INR
- network
- expiry
- Accept / Reject

Messenger is acquisition and communication.

The financial trade itself lives in INRP2P.

Do not require a complicated dashboard workflow before a client can view a private quote.

---

## Trade model

When a quote is accepted, create an immutable Trade.

Do not implement the entire trade as one mutable status string with ad-hoc transitions.

Model the trade plus its settlement legs.

Core trade states should cover:

- OPEN
- AWAITING_FIRST_LEG
- FIRST_LEG_DETECTED
- FIRST_LEG_CONFIRMED
- SETTLING
- PARTIALLY_SETTLED
- COMPLETED
- EXCEPTION
- CANCELLED

Exact naming may improve during architecture design, but transitions must be explicit and validated by a state machine.

Never allow arbitrary status edits from the UI.

---

## USDT → INR flow

1. Quote accepted.
2. Client receives exact TRC20 destination and amount.
3. System waits for USDT.
4. TRON monitoring detects the transfer.
5. Do not mark USDT final merely because the transaction was broadcast or first seen.
6. Track:
   - tx hash
   - from
   - to
   - token contract
   - expected amount
   - actual amount
   - block
   - detected time
   - confirmation/finality state
7. Only move into confirmed crypto state according to defined TRON finality semantics.
8. INR payout begins.
9. One or more INR settlement legs are recorded.
10. Trade completes only when the recorded settlement obligation is fully satisfied.

---

## INR settlement

Large INR settlements may consist of multiple real bank transfers.

The product must natively support multiple INR settlement legs.

Example:

Trade total: `₹10,200,000`

- ₹2,000,000 — UTR XXXXX — COMPLETED
- ₹2,500,000 — UTR XXXXX — COMPLETED
- ₹2,500,000 — PROCESSING
- ₹2,000,000 — PENDING
- ₹1,200,000 — PENDING

Client-facing UI shows:

`₹4,500,000 / ₹10,200,000 received`

Each fiat leg must support:

- amount
- currency
- source settlement account
- destination account
- UTR/reference
- created time
- sent time
- confirmed time
- status
- proof/attachment
- operator
- notes

Do not design payment splitting or company rotation as a mechanism for evading banking controls or reporting thresholds.

The system is an operational record of legitimate settlement legs and available accounts.

---

## INR settlement accounts

The exchange may operate with multiple legitimate INR settlement accounts/entities.

Model them properly from day one.

For every INR account track:

- entity
- bank
- masked account details
- payment rail
- working status
- internal working daily capacity
- used today
- reserved
- remaining
- pending payouts
- notes

Statuses:

- ACTIVE
- PAUSED
- UNAVAILABLE

Operators must be able to reserve capacity for accepted trades.

Concurrency matters: two operators must not accidentally allocate the same remaining capacity twice.

Use database-level transactional locking / reservation semantics.

Do not hard-code assumptions such as "one trade = one bank account".

---

## USDT treasury

Create a real treasury view for TRC20 USDT.

Track designated wallets and operational balances.

For each wallet:

- address
- label
- status
- observed balance
- reserved amount
- available amount
- incoming pending
- outgoing pending

The application must not store raw private keys in V1.

V1 should operate as a system of record and monitoring layer around externally controlled wallets.

Create a wallet adapter boundary so custody/signing infrastructure can be integrated later without rewriting Trade or Treasury domains.

---

## Operator Desk

This is the most important product surface.

The operator should be able to keep this page open all day.

Top summary:

- Today's completed volume
- Open trade volume
- INR paid today
- USDT received/sent today
- Gross margin today
- Open trades
- Trades needing action

Main live queue:

- Client
- Direction
- Amount
- Client requested rate
- Current route rate
- Proposed/client quote rate
- Potential margin
- Trade status
- Next required action

Actions:

- QUOTE
- COUNTER
- USDT RECEIVED
- CREATE INR PAYOUT
- ADD UTR
- CONFIRM PAYOUT
- MARK EXCEPTION

Do not turn this into a generic analytics dashboard.

The main purpose is:

**What needs attention right now?**

---

## Rates

Create a simple operator-controlled rate desk.

Support:

- reference market rate
- route rate
- client quote rate

The route rate may change throughout the day based on real liquidity demand.

Example:

10:00 → ₹104.00  
14:00 → ₹104.20  
18:00 → ₹104.50

Rate changes must be timestamped and audited.

Historical trades must never recalculate when the current rate changes.

Allow client-specific/manual quotes.

Do not automatically publish internal route rates.

---

## Clients

Keep client management practical.

For each client:

- name/company
- contacts
- Telegram
- WhatsApp
- email
- notes
- saved INR bank accounts
- saved crypto wallets
- typical trade direction
- typical size
- pricing notes
- total completed volume
- total gross margin generated
- last trade
- open trades

Provide:

- Create Quote
- Repeat Previous Trade

Do not build a bloated CRM.

---

## Exceptions

Explicitly support:

- wrong USDT amount
- partial USDT amount
- USDT sent from unexpected wallet
- wrong network
- transaction detected but not final
- expired quote
- duplicate tx hash
- duplicate UTR
- partial INR payout
- INR payout delayed
- bank transfer failed
- client changed bank account after quote
- route capacity changed
- trade cancellation
- operator mistake
- manual reconciliation correction

Every exception must be recoverable without directly editing database rows.

Provide explicit audited operator actions.

Any recalculation creates a new immutable financial adjustment record.

---

## Financial core

Do not build finance logic from mutable totals scattered across application tables.

Use an internal double-entry ledger from day one for economic/accounting events.

This does not mean INRP2P must custody customer money.

It means every financial fact recorded by the system has a traceable debit/credit representation.

At minimum support ledger events for:

- accepted trade obligation
- USDT received
- INR payable
- INR settlement leg
- exchange gross margin
- adjustment/reversal where permitted

Ledger entries are append-only.

Never delete or silently edit posted ledger entries.

Corrections happen through compensating entries.

All money calculations use exact numeric types.

Define currency precision centrally.

---

## Audit

Every sensitive action must be auditable:

- rate changed
- quote created
- quote accepted
- quote expired
- settlement account selected
- capacity reserved
- USDT confirmation
- UTR entered/changed
- trade status transition
- manual adjustment
- exception resolution
- client bank/wallet change
- operator permission change

Audit records are append-only.

Store:

- actor
- time
- action
- entity
- before/after where applicable
- request/correlation ID

Do not log full sensitive bank/account data unnecessarily.

---

## Roles

Build RBAC from the start.

At minimum:

- OWNER
- DEALER
- SETTLEMENT_OPERATOR
- FINANCE
- SUPPORT
- READ_ONLY

Sensitive operator accounts require MFA.

---

## P&L

P&L must come from real immutable trade economics, not frontend calculations.

For each trade snapshot:

- client rate
- route rate
- client value
- route economic value
- fees
- gross margin
- currency

Dashboard:

- completed volume today
- gross margin today
- average margin / USDT
- open expected margin
- completed trades

Do not count unrealized/open trades as realized P&L.

---

## Receipt

Every completed trade receives a professional settlement receipt generated from immutable trade data.

Include:

- Trade ID
- date/time
- sold amount
- received amount
- executed rate
- network
- blockchain tx
- INR settlement legs
- UTRs
- completion time

Generate PDF and machine-readable CSV/JSON.

---

## Public website / SEO

Product brand:

# INRP2P Exchange

Primary descriptor:

**USDT ↔ INR OTC Exchange for India**

Do not publicly position the brand as "High Risk Exchange".

High-risk businesses are an ICP, not the SEO category/name.

Suggested hero:

# Buy & Sell USDT in India

Large trades.  
Locked rates.  
INR settlement.

Primary actions:

- Sell USDT
- Buy USDT
- Request OTC Quote

Create SEO-ready routes from the beginning:

- /
- /usdt-to-inr
- /inr-to-usdt
- /sell-usdt-in-india
- /buy-usdt-in-india
- /usdt-otc-india

Do not create fake reviews, fake volume, fake rates, fake settlement times, or fake regulatory claims.

---

## Mobile

Client flows must work excellently on mobile because many clients arrive from Telegram or WhatsApp links.

Operator Desk is desktop-first but responsive.

---

## Notifications

Create a notification abstraction from day one.

V1 can support:

- in-app
- email

Architecture should allow later:

- Telegram
- WhatsApp
- SMS

Notifications are never the source of truth.

The trade page is the source of truth.

---

## Security

Use secure session/authentication architecture.

MFA for privileged operator accounts.

Encrypt sensitive data at rest where appropriate.

Never store wallet private keys in plaintext or application database.

Do not expose raw bank details in logs.

Use signed/unguessable quote links.

Rate-limit sensitive endpoints.

Protect quote acceptance and financial mutations against retries/double submission.

Use idempotency keys for every financial mutation.

Use database constraints for uniqueness of:

- tx hash where applicable
- UTR/reference where applicable
- quote acceptance
- ledger posting identifiers

---

## Architecture

Prefer a modular monolith for V1 unless there is a demonstrated reason for separate services.

Do not prematurely build microservices.

PostgreSQL is the system of record.

Use explicit modules/domains:

- Identity
- Clients
- Pricing
- Quotes
- Trades
- Settlement
- INR Accounts
- Crypto/Treasury
- Ledger
- Audit
- Notifications
- Reporting

Use an outbox/event pattern for reliable side effects.

Financial state transitions must commit atomically with corresponding ledger/audit/outbox records where applicable.

External integrations sit behind adapters:

- TronAdapter
- MarketRateAdapter
- NotificationAdapter
- BankRailAdapter
- CustodyAdapter

---

## Background jobs

Use a durable job system for:

- TRON transaction monitoring
- quote expiration
- settlement reconciliation
- notifications
- report generation
- capacity release after cancellation/expiry

Jobs must be retry-safe and idempotent.

Never rely on in-memory timers for financial lifecycle events.

---

## Data model

Before implementation, produce and review an ERD covering at least:

- User
- Role/Permission
- Client
- ClientContact
- BankAccount
- CryptoWallet
- SettlementEntity
- INRSettlementAccount
- LiquidityRoute
- RateSnapshot
- TradeRequest
- Quote
- QuoteLink
- Trade
- SettlementLeg
- CryptoTransfer
- FiatTransfer
- CapacityReservation
- LedgerAccount
- LedgerEntry
- FinancialAdjustment
- Attachment
- ExceptionCase
- AuditEvent
- Notification

Do not blindly create exactly these tables if better normalization exists, but the architecture must cover all of these responsibilities.

---

## State machines

Before UI implementation, write the full Trade and Quote state machines.

Document:

- who can cause each transition
- preconditions
- financial side effects
- ledger effects
- audit effects
- retry/idempotency behavior
- failure path

No UI screen may mutate statuses directly outside domain commands.

---

## Implementation order

### Phase 0
Create:

- PRODUCT.md
- ARCHITECTURE.md
- DOMAIN_MODEL.md
- STATE_MACHINES.md
- FINANCIAL_INVARIANTS.md
- SECURITY.md
- UX_FLOWS.md
- IMPLEMENTATION_PLAN.md

Before production page implementation, also define:

- client navigation
- operator navigation
- core component inventory
- Exchange wireframe
- Firm Quote wireframe
- Trade wireframe
- Operator Desk wireframe
- INR settlement wireframe
- responsive rules

Challenge the plan before writing production code.

Specifically inspect:

- money precision
- double settlement
- race conditions
- capacity over-allocation
- duplicate blockchain events
- duplicate UTRs
- quote expiry races
- margin calculation
- historical pricing mutation
- permissions failures

### Phase 1
Foundation:
- authentication
- RBAC
- audit
- database
- ledger primitives

### Phase 1.5
Implement the production design system and reusable financial components.

### Phase 2
Clients, bank accounts, wallets, INR settlement accounts, routes, and rates.

### Phase 3
Trade requests, quoting, counter quotes, quote links, expiration, and acceptance.

### Phase 4
Trade state machine and settlement legs.

### Phase 5
TRON USDT monitoring and reconciliation.

### Phase 6
Operator Desk, Rates, INR Accounts, USDT Treasury, Clients, and trade operations.

### Phase 7
Client Exchange, quote page, active trade tracking, and history.

### Phase 8
P&L, receipts, exports, exceptions, and reconciliation.

### Phase 9
Public site, SEO surfaces, production hardening, monitoring, and deployment.

---

## Testing

Implement tests for at least:

- 100k USDT sell at route 104.20/client 102.00 gives ₹10.2M client obligation and ₹220k gross margin
- reverse INR → USDT pricing
- quote accepted one millisecond before expiry
- quote acceptance after expiry rejected
- same quote accepted twice
- two operators accepting same request
- capacity reservation race
- duplicate USDT webhook/event
- same blockchain tx attached to two trades
- USDT short payment
- USDT overpayment
- wrong TRC20 destination
- transaction seen but not finalized
- multiple INR payout legs
- partial INR settlement
- failed payout leg
- duplicate UTR
- cancelled trade releases reserved capacity
- rate changes do not affect accepted trades
- financial adjustment preserves original history
- completed P&L only counts realized trades
- role permissions
- audit history cannot be silently altered

Create integration tests against a real test PostgreSQL database and end-to-end tests for the core flow.

---

## Demo scenario

Route rate:

`₹104.20 / USDT`

Client sells:

`100,000 USDT`

Operator quotes:

`₹102.00`

Client sees:

`100,000 USDT → ₹10,200,000`

Client accepts.

Quote becomes immutable trade.

Client sends exactly 100,000 USDT on TRC20.

System detects and confirms it correctly.

Exchange settles ₹10,200,000 through several recorded INR payout legs.

Every payout has its own amount/status/UTR.

Client can see received vs remaining INR.

Operator sees:

`₹220,000 gross margin`

Trade completes.

System generates an immutable settlement receipt and correct ledger/P&L entries.

No spreadsheet or calculator is needed at any point.

---

## Product standard

Do not optimize for number of features.

The standard is:

Can a real INR ↔ USDT exchange desk operate the entire trade lifecycle inside INRP2P without going back to spreadsheets and manual calculators?

Can a client arriving from Telegram or WhatsApp understand and accept a 100k USDT quote in seconds?

Can an operator always answer:

- what is the agreed rate?
- how much has arrived?
- how much is still owed?
- which INR payouts were sent?
- which UTR belongs to which amount?
- what is the margin?
- what needs action now?

If any answer requires manually reconstructing events, the product is not finished.

---

## Final quality bar

The product must pass three independent standards:

### Financial
Money, rates, margin, settlement, and history are correct and immutable.

### Operational
A real INR ↔ USDT desk can run the working day without spreadsheets or manual calculators.

### Design
The client product feels simpler than dealing through Telegram, while the operator product feels substantially more controlled than Telegram + Excel.

If a design decision conflicts with financial clarity, financial clarity wins.

If a visual effect does not help explain money, rate, status, settlement, or required action, remove it.

Do not ship generic SaaS UI and call it premium.

Do not ship crypto-template UI and call it fintech.

The finished product must feel specifically designed for INRP2P Exchange.

---

## Final deliverables

At the end provide:

1. final architecture summary
2. complete implemented feature matrix
3. financial invariants and how they are enforced
4. state machine matrix
5. security review
6. tests and results
7. known limitations
8. production launch checklist

The goal is not a prototype.

Build the foundation of a real INRP2P Exchange that can launch on INR ↔ USDT first and grow later without replacing its financial core.
