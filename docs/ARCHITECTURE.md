# INRP2P Exchange — Architecture

Status: Phase 0, revision 3 (`DECISIONS.md` Revision 3).

## 1. Shape: modular monolith

One deployable application, one PostgreSQL system of record, one durable job runner. No microservices in V1: every financial state transition must commit atomically with its ledger, audit and outbox records, which a single database transaction gives for free and a distributed system does not.

Modules are enforced boundaries (separate packages, lint-enforced import rules), not folders by convention.

## 2. Stack (approved — `DECISIONS.md D-06`)

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 24 LTS | Single runtime for web, worker and tooling |
| Language | TypeScript 6, `strict` end to end | One type system from DB row to UI; `bigint` for exact money |
| Web | Next.js 16.x (latest patched stable, App Router) + React (version paired with that Next.js release) | SEO pages, client app, operator app and quote link in one app with per-surface layouts; server-rendered public pages |
| DB | PostgreSQL 18.6 | System of record; row locks, partial unique indexes, deferred constraints, SERIALIZABLE where needed |
| DB access | Kysely (typed SQL builder) + hand-written SQL migrations | Explicit transactions and `SELECT … FOR UPDATE`; no ORM hiding locking or issuing surprise writes |
| Jobs | Graphile Worker (Postgres-backed) | Durable, transactional enqueue in the same DB transaction, retries, cron; no Redis |
| Validation | Zod at every boundary | Commands, HTTP, adapter payloads |
| Money | Internal `Money`/`Rate` value types over `bigint` minor units | See `FINANCIAL_INVARIANTS.md §1` |
| Auth | **Better Auth**: users, sessions, credential login, email verification, client email-OTP login, operator TOTP two-factor. INRP2P adds RBAC, step-up freshness, command-level authorization and the quote-bound acceptance challenge (domain primitive) | No proprietary auth/session framework; quote acceptance needs quote-specific TTL, attempts, actor binding, DB-time validation, idempotency and atomic consumption with acceptance, which a generic auth OTP does not give |
| PDF | Server-side render from immutable receipt snapshot (HTML → PDF via headless Chromium) | Same design system, grayscale-safe |
| Tests | Vitest (unit), Testcontainers PostgreSQL (integration), Playwright (E2E + visual regression) | Real Postgres for concurrency tests |
| Components | Storybook (component gallery) | Required by design system |
| Monorepo | pnpm workspaces | Package boundaries = module boundaries |

Versions are pinned in `package.json`/lockfile and `.nvmrc`/`engines`; security patch updates within the approved major lines do not require a decision.

## 3. Repository layout

```
apps/
  web/                    Next.js: (public) (client) (operator) q/[token] routes; thin handlers only
  worker/                 Graphile Worker entry: jobs + outbox dispatcher
packages/
  kernel/                 Money, Rate, Currency precision, ids, clock, Result, errors, idempotency
  db/                     migrations, Kysely types, transaction helper, test DB harness
  identity/               Better Auth configuration (operator + client), roles, permissions, step-up verification, auth audit hooks
  audit/                  append-only audit writer + sealing
  ledger/                 ledger accounts, journal posting, balance queries
  clients/                clients, contacts, bank accounts, crypto wallets
  routes/                 liquidity routes (incl. settlement_model), route obligations, route settlements + allocations
  pricing/                rate snapshots, quote math
  quotes/                 trade requests, quotes, quote links, acceptance challenges (domain OTP), accept/reject (app + OTP-verified link)
  trades/                 trade aggregate + state machine, exceptions, adjustments
  settlement/             settlement legs (payer EXCHANGE_ACCOUNT | ROUTE), movements (fiat/crypto transfer records), transfer allocations, movement journals, capacity reservations
  inr-accounts/           settlement entities, INR settlement accounts, daily capacity
  treasury/               treasury wallets, crypto transfers, deposit addresses + assignments (via CustodyAdapter)
  scanner/                TRON block/address scanning: chain cursor, detection, solidification confirmation, orphan sweep
  notifications/          notification intents + channel adapters
  reporting/              P&L, receipts, exports
  adapters/               TronAdapter, MarketRateAdapter, NotificationAdapter, BankRailAdapter, CustodyAdapter, RouteAdapter
  desk/                   operator read models (strip, queue, trade, orders, positions, treasury, clients); reads only, view access by field absence
  ui/                     design tokens + financial components (Storybook)
docs/
```

### Dependency rule
`kernel` ← `db`, `audit`, `ledger` ← domain modules ← `apps/*`.
Domain modules talk to each other only through their public command/query API (never another module's tables). Cross-module side effects that need not be atomic go through the outbox.

`desk` is a read-only composition layer: it depends on the domain modules' public query APIs, never on their tables, and nothing depends on it except `apps/web`. It decides nothing — it projects the RBAC matrix into view flags and omits what the viewer may not see (field absence, `SECURITY.md §5`), while the command authorizes itself again inside its own transaction.

React components and route handlers contain **no financial logic**: they call commands and render query results. Money is formatted in `ui` from `Money` values; it is never computed there. Formatting is locale-independent: INR uses international three-digit grouping (`₹10,200,000`) via one deterministic formatter, never runtime `Intl` locale defaults (`DECISIONS.md D-11`).

## 4. Command pipeline

Every mutation is a **domain command** executed by one function with this shape:

```
execute(command, actor, idempotencyKey, correlationId):
  BEGIN
    claim idempotency key (INSERT … ON CONFLICT → return stored result if same request hash; reject if different hash)
    authorize(actor, permission, resource)          -- RBAC + MFA/step-up freshness
    lock aggregate rows (SELECT … FOR UPDATE, fixed lock order)
    load state; validate state-machine transition + preconditions (using DB time)
    write state change
    post ledger journal (balanced, unique posting id)       -- if financial
    append audit event (before/after, correlation id)
    insert outbox events                                   -- notifications, follow-up jobs
    store idempotency result
  COMMIT
```

Failure anywhere → rollback of all of it. There is no code path that writes a status without the audit record, or a financial status without the journal.

### Lock order (deadlock prevention)
Always acquire in this order when a command needs several:
`trade_request → quote → acceptance_challenge → trade → route_obligation → settlement_leg → route_settlement → movement (fiat_transfer / crypto_transfer) → inr_account_day → treasury_wallet → deposit_address`.

### Movements and postings
A real value movement (one UTR or one on-chain transfer) is stored once and posts one journal keyed by the movement (`fiat:{id}:confirm`, `crypto:{id}:confirm`). Settlement legs and route settlements link to movements through `transfer_allocation` (dimensions CLIENT / ROUTE) and never post their own journals. The direct route payout command (`payout_leg.confirm` for `payer = ROUTE`) runs in the `settlement` module and calls the `routes` module's allocation API inside the same transaction; this is the one place where client settlement and route settlement meet, and it is covered by dedicated double-count tests (`IMPLEMENTATION_PLAN.md` Phase 4).

### Time
All business time decisions (quote expiry, capacity day) use database time (`statement_timestamp()`), never app-server or browser clocks. Business day = Asia/Kolkata calendar day.

## 5. Outbox and jobs

- `outbox_event` rows are inserted inside the command transaction.
- Worker dispatcher claims events (`FOR UPDATE SKIP LOCKED`), executes handler, marks dispatched. Handlers are idempotent keyed by event id.
- Jobs (Graphile Worker):

| Job | Trigger | Idempotency |
|---|---|---|
| `quote.expire` | Scheduled at `expires_at`, plus sweeper cron every 15s | Transition guarded by state + `expires_at <= now()` under lock |
| `deposit_address.cooldown_release` | Cron | Address `COOLDOWN → AVAILABLE` (pool mode) only after cooldown and with no open assignment |
| `custody.pool_health` | Cron | Read-only: alerts when available deposit addresses fall below threshold |
| `tron_scan` (implements `tron.poll_address` / `tron.scan_blocks`) | Cron every minute, over a bounded window starting at `chain_cursor` minus a rescan overlap | `crypto_transfer` unique on `(network, tx_hash, log_index)`, plus one idempotency key per chain event (`tron:{txHash}:{logIndex}`); the cursor only moves forward (IX066) and only across blocks the run actually processed, so a long outage is walked window by window rather than skipped |
| `tron_confirm` (implements `tron.confirm_transfer`) | Cron every minute over DETECTED transfers | Transition guarded by transfer state; confirmation is the `ChainVerifier`'s answer, never the job's |
| `tron_orphan_sweep` | Cron every 10 minutes | Only DETECTED transfers the providers no longer report; a solidified block is irreversible, so CONFIRMED is never swept |
| `route.reconcile` | Cron | Read-only: checks FI-64 (obligation remaining = ledger route balance per obligation) and opens `ROUTE_SETTLEMENT_MISMATCH` / `ROUTE_OBLIGATION_OVERDUE` idempotently |
| `settlement.reconcile` | Cron | Read-only diffing → opens ExceptionCases idempotently (unique open case per `(type, subject)`) |
| `capacity.release` | Outbox from cancellation/expiry/leg failure | Reservation state guarded |
| `notification.send` | Outbox | Unique `(notification_id, channel)` delivery row |
| `receipt.generate` | Outbox on trade completion | Unique receipt per trade version |
| `audit.seal` | Cron | Seals contiguous ranges; idempotent by range |

No in-memory timers for any financial lifecycle event. The UI countdown is display only.

## 6. Adapters (ports)

| Port | V1 implementation | Contract |
|---|---|---|
| `TronAdapter` | `TronHttpProvider` (TronGrid / full node HTTP API) as primary + a second provider for cross-check, combined by `DualProviderChainVerifier` | `listIncomingTransfers(address, contract, sinceBlock)`, `getTransfer(txHash, logIndex)`, `getLatestBlockNumber()`, `getSolidifiedBlockNumber()`; returns raw facts, never decisions. Each adapter declares a stable `independenceGroup` (who actually operates the data behind it), which is configured, never inferred from a URL. The verifier's `TransferReceipt` carries both `agreedBy` (provider names, for the audit trail) and `agreedGroups` (distinct independence groups), and the domain applies `DECISIONS.md D-05` to the **groups**: configuration alone never counts as agreement, and two adapters onto the same operator count once however they are named |
| `MarketRateAdapter` | Optional reference feed; can be disabled | `getReference(pair)` → timestamped rate + source; failure never blocks quoting |
| `NotificationAdapter` | In-app (DB) + email (SMTP/transactional provider) | `send(intent)`; Telegram/WhatsApp/SMS later |
| `BankRailAdapter` | `ManualRailAdapter`: operator records transfer + UTR | Later: bank API; same leg state machine |
| `CustodyAdapter` (wallet adapter) | Provider-specific, watch-only: no keys in the app. Outbound USDT sent in the provider's tooling; operator records tx hash; system verifies on-chain | `capabilities()` → `{ depositAddress: DERIVED / POOL / UNSUPPORTED }`; `allocateDepositAddress(network, tradeRef)`; `listDepositAddresses()`. If the provider reports `UNSUPPORTED`, implementation stops and the limitation is reported (`DECISIONS.md D-02`). Later: MPC/HSM signing |
| `RouteAdapter` | `ManualRouteAdapter`: operators record route movements (route → exchange, exchange → route) and direct route → client payouts (as payout legs with `payer = ROUTE`); on-chain evidence verified via `TronAdapter` | `settlementModel()`, `executionMode()` (`DIRECT_TO_CLIENT` / `TO_EXCHANGE`); `recordSettlement(...)`; later provider APIs (payout status, statement import) for per-trade, prefunded or net settlement (`DECISIONS.md D-03`, `D-14`) |

Adapters are the only place that talks to the outside world. Domain modules depend on port interfaces; tests use deterministic fakes.

## 7. Surfaces and hosting

| Surface | Host | Auth |
|---|---|---|
| Public site + SEO | `inrp2p.com` | none |
| Quote link | `inrp2p.com/q/{token}` | token = view only, no state change; accept/reject = OTP to verified email of an authorized client user (`DECISIONS.md D-01`, `D-15`) |
| Client app | `app.inrp2p.com` | client session |
| Operator app | `desk.inrp2p.com` | operator session + mandatory MFA; optional IP allowlist |

Separate hostnames for client and operator gives separate cookies (no operator session ever present in a client browser context) and allows network restrictions on the desk. One codebase, one deploy.

## 8. Data protection

- Bank account numbers, IFSC-bound details: envelope-encrypted (AES-256-GCM, data key wrapped by cloud KMS). Stored alongside `last4` and a keyed HMAC for duplicate detection. Decryption only in the settlement module for users with `bank_account:reveal`, audited.
- No private keys anywhere in the application or database (V1 custody is external).
- Logs: structured, with a redaction layer that masks account numbers, UTR (last 4 visible), emails, phone numbers, tokens.

## 9. Observability

- Correlation id per request, propagated into audit, outbox, jobs, logs.
- Metrics: deposit address pool availability, OTP delivery latency and failure rate, open route obligations by age, quote latency, quote acceptance rate, time-to-first-leg-confirmation, payout completion time, open exceptions by type, TRON adapter lag (head vs solidified vs our scanner), job failures, ledger imbalance check (must always be zero).
- Alerts: ledger imbalance ≠ 0, scanner lag > threshold, capacity invariant violation, repeated job failure, audit seal gap.

## 10. Deliberately not in V1

Microservices, event sourcing of all aggregates (we use state + append-only ledger + append-only audit instead), multi-region writes, key custody, automated bank payouts, multi-tenant white-label.
