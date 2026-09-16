# INRP2P Exchange — Architecture

Status: Phase 0 draft, for review.

## 1. Shape: modular monolith

One deployable application, one PostgreSQL system of record, one durable job runner. No microservices in V1: every financial state transition must commit atomically with its ledger, audit and outbox records, which a single database transaction gives for free and a distributed system does not.

Modules are enforced boundaries (separate packages, lint-enforced import rules), not folders by convention.

## 2. Stack (proposed — see `DECISIONS.md D-06`)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) end to end | One type system from DB row to UI; `bigint` for exact money |
| Web | Next.js (App Router), React | SEO pages, client app, operator app and quote link in one app with per-surface layouts; server-rendered public pages |
| DB | PostgreSQL 16 | System of record; row locks, partial unique indexes, deferred constraints, SERIALIZABLE where needed |
| DB access | Kysely (typed SQL builder) + hand-written SQL migrations | Explicit transactions and `SELECT … FOR UPDATE`; no ORM hiding locking or issuing surprise writes |
| Jobs | Graphile Worker (Postgres-backed) | Durable, transactional enqueue in the same DB transaction, retries, cron; no Redis |
| Validation | Zod at every boundary | Commands, HTTP, adapter payloads |
| Money | Internal `Money`/`Rate` value types over `bigint` minor units | See `FINANCIAL_INVARIANTS.md §1` |
| Auth | Own session layer: DB sessions, Argon2id, TOTP MFA (WebAuthn later) | Full control over MFA, step-up, session revocation, audit |
| PDF | Server-side render from immutable receipt snapshot (HTML → PDF via headless Chromium) | Same design system, grayscale-safe |
| Tests | Vitest (unit), Testcontainers PostgreSQL (integration), Playwright (E2E + visual regression) | Real Postgres for concurrency tests |
| Components | Storybook (component gallery) | Required by design system |
| Monorepo | pnpm workspaces | Package boundaries = module boundaries |

## 3. Repository layout

```
apps/
  web/                    Next.js: (public) (client) (operator) q/[token] routes; thin handlers only
  worker/                 Graphile Worker entry: jobs + outbox dispatcher
packages/
  kernel/                 Money, Rate, Currency precision, ids, clock, Result, errors, idempotency
  db/                     migrations, Kysely types, transaction helper, test DB harness
  identity/               users, sessions, MFA, roles, permissions
  audit/                  append-only audit writer + sealing
  ledger/                 ledger accounts, journal posting, balance queries
  clients/                clients, contacts, bank accounts, crypto wallets
  pricing/                liquidity routes, rate snapshots, quote math
  quotes/                 trade requests, quotes, quote links, acceptance
  trades/                 trade aggregate + state machine, exceptions, adjustments
  settlement/             settlement legs, fiat transfers, capacity reservations
  inr-accounts/           settlement entities, INR settlement accounts, daily capacity
  treasury/               crypto wallets (exchange-side), crypto transfers, deposit addresses
  notifications/          notification intents + channel adapters
  reporting/              P&L, receipts, exports
  adapters/               TronAdapter, MarketRateAdapter, NotificationAdapter, BankRailAdapter, CustodyAdapter
  ui/                     design tokens + financial components (Storybook)
docs/
```

### Dependency rule
`kernel` ← `db`, `audit`, `ledger` ← domain modules ← `apps/*`.
Domain modules talk to each other only through their public command/query API (never another module's tables). Cross-module side effects that need not be atomic go through the outbox.

React components and route handlers contain **no financial logic**: they call commands and render query results. Money is formatted in `ui` from `Money` values; it is never computed there.

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
`trade_request → quote → trade → settlement_leg → inr_account_day_capacity → treasury_wallet → deposit_address`.

### Time
All business time decisions (quote expiry, capacity day) use database time (`statement_timestamp()`), never app-server or browser clocks. Business day = Asia/Kolkata calendar day.

## 5. Outbox and jobs

- `outbox_event` rows are inserted inside the command transaction.
- Worker dispatcher claims events (`FOR UPDATE SKIP LOCKED`), executes handler, marks dispatched. Handlers are idempotent keyed by event id.
- Jobs (Graphile Worker):

| Job | Trigger | Idempotency |
|---|---|---|
| `quote.expire` | Scheduled at `expires_at`, plus sweeper cron every 15s | Transition guarded by state + `expires_at <= now()` under lock |
| `tron.poll_address` / `tron.scan_blocks` | Cron + on deposit address assignment | `crypto_transfer` unique on `(network, tx_hash, log_index)` |
| `tron.confirm_transfer` | Per detected transfer, backoff until solidified | Transition guarded by transfer state |
| `settlement.reconcile` | Cron | Read-only diffing → opens ExceptionCases idempotently (unique open case per `(type, subject)`) |
| `capacity.release` | Outbox from cancellation/expiry/leg failure | Reservation state guarded |
| `notification.send` | Outbox | Unique `(notification_id, channel)` delivery row |
| `receipt.generate` | Outbox on trade completion | Unique receipt per trade version |
| `audit.seal` | Cron | Seals contiguous ranges; idempotent by range |

No in-memory timers for any financial lifecycle event. The UI countdown is display only.

## 6. Adapters (ports)

| Port | V1 implementation | Contract |
|---|---|---|
| `TronAdapter` | TronGrid / full node HTTP API (primary) + second provider for cross-check | `listTrc20Transfers(address, sinceBlock)`, `getTransactionInfo(txHash)`, `getSolidifiedBlockNumber()`; returns raw facts, never decisions |
| `MarketRateAdapter` | Optional reference feed; can be disabled | `getReference(pair)` → timestamped rate + source; failure never blocks quoting |
| `NotificationAdapter` | In-app (DB) + email (SMTP/transactional provider) | `send(intent)`; Telegram/WhatsApp/SMS later |
| `BankRailAdapter` | `ManualRailAdapter`: operator records transfer + UTR | Later: bank API; same leg state machine |
| `CustodyAdapter` | `WatchOnlyCustody`: no keys; outbound USDT sent externally, operator records tx hash, system verifies on-chain | Later: MPC/HSM signing provider |

Adapters are the only place that talks to the outside world. Domain modules depend on port interfaces; tests use deterministic fakes.

## 7. Surfaces and hosting

| Surface | Host | Auth |
|---|---|---|
| Public site + SEO | `inrp2p.com` | none |
| Quote link | `inrp2p.com/q/{token}` | token (+ acceptance verification, `DECISIONS.md D-01`) |
| Client app | `app.inrp2p.com` | client session |
| Operator app | `desk.inrp2p.com` | operator session + mandatory MFA; optional IP allowlist |

Separate hostnames for client and operator gives separate cookies (no operator session ever present in a client browser context) and allows network restrictions on the desk. One codebase, one deploy.

## 8. Data protection

- Bank account numbers, IFSC-bound details: envelope-encrypted (AES-256-GCM, data key wrapped by cloud KMS). Stored alongside `last4` and a keyed HMAC for duplicate detection. Decryption only in the settlement module for users with `bank_account:reveal`, audited.
- No private keys anywhere in the application or database (V1 custody is external).
- Logs: structured, with a redaction layer that masks account numbers, UTR (last 4 visible), emails, phone numbers, tokens.

## 9. Observability

- Correlation id per request, propagated into audit, outbox, jobs, logs.
- Metrics: quote latency, quote acceptance rate, time-to-first-leg-confirmation, payout completion time, open exceptions by type, TRON adapter lag (head vs solidified vs our scanner), job failures, ledger imbalance check (must always be zero).
- Alerts: ledger imbalance ≠ 0, scanner lag > threshold, capacity invariant violation, repeated job failure, audit seal gap.

## 10. Deliberately not in V1

Microservices, event sourcing of all aggregates (we use state + append-only ledger + append-only audit instead), multi-region writes, key custody, automated bank payouts, multi-tenant white-label.
