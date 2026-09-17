# INRP2P Exchange — Phase 2 Report (Reference Data)

Status: implemented, awaiting founder review. Phase 3 not started.
Base: `b43f975` (Phase 1.5 canonical visual baselines, CI green). Scope: `IMPLEMENTATION_PLAN.md` Phase 2 only — no trade requests, quotes, trades, settlement legs, exceptions, TRON scanning or UI screens.

## 1. D-02 gate — status: **OPEN (provider not confirmed)**

No custody/wallet provider has been confirmed to support TRC20 address derivation or pooling. Per the gate:

- **Built:** the `CustodyAdapter` port, `custody_provider_config` (append-only capability record), deposit address and assignment tables, the provider-independent allocation / release / cooldown logic, and a deterministic `FakeCustodyAdapter` used only by tests.
- **Not built:** any real provider adapter. No attribution fallback of any kind exists (no shared address, amount or sender matching).
- **Effect now:** with no capability recorded, `getDepositAddressCapability('TRON')` returns `UNSUPPORTED`; `assertSellAcceptanceSupported` and `allocateDepositAddress` refuse with `CUSTODY_CAPABILITY_UNSUPPORTED`. Phase 3 SELL acceptance will therefore be disabled until the gate closes.
- **To close the gate:** confirm the provider supports `DERIVED` or `POOL` TRC20 receive addresses and how funds on them are consolidated (and what that needs, e.g. TRX for energy/bandwidth). Then a provider adapter is implemented against the port, and an OWNER/FINANCE records the capability with `custody.record_capability` (consolidation notes are mandatory for `DERIVED`/`POOL`). If the provider cannot do either, the exact limitation is reported and SELL stays disabled.

## 2. What exists

```
packages/adapters     KeyEncryptionKey port + LocalKeyEncryptionKey (dev/test), envelope FieldProtector (AES-256-GCM per value, KEK-wrapped DEK, AAD context, keyed HMAC), CustodyAdapter port; testing: FakeCustodyAdapter, testFieldProtector
packages/clients      clients, contacts, client users + can_accept_quotes, beneficiary bank accounts (encrypted, archive-not-edit), client wallets, reveal, masked queries, authorized acceptors
packages/inr-accounts settlement entities, exchange INR accounts (encrypted), per-IST-day capacity, reservations (reserve / consume / release / day rollover), capacity changes
packages/routes       liquidity routes: settlement model (PER_TRADE only), execution mode, status, usable-route precondition
packages/pricing      append-only rate snapshots (ROUTE / REFERENCE), publish, current-rate queries with DB-time age
packages/treasury     treasury wallets, custody capability record, pool import, deposit address allocation (POOL / DERIVED), release → COOLDOWN, cooldown job, retire, pool status
packages/kernel       + TRON base58check validation/encoding, payload validation helpers, new domain error codes
packages/identity     + operatorCommand helper; testing fixtures (operators with step-up, client logins, runAs)
packages/db           + migrations 0008–0011, schema types, DATE columns parsed as 'YYYY-MM-DD' strings
apps/worker           + cron jobs capacity_day_rollover (5 min), deposit_address_cooldown_release (10 min)
```

## 3. Migrations

| # | File | Contents |
|---|---|---|
| 0008 | clients | shared guards `inrp2p_guard_status_transition` (whitelist, IX040) and `inrp2p_guard_immutable_columns` (IX041); domains `inrp2p_sealed`, `inrp2p_hmac`, `inrp2p_tron_address`; `client` (CL-NNNN ref, compliance hook columns, version), `client_contact` (encrypted phone/WhatsApp, one primary), `client_user` (CLIENT auth users only, IX022), `bank_account` (encrypted number, last4, HMAC, unique among ACTIVE per client, ACTIVE→ARCHIVED only), `crypto_wallet` |
| 0009 | inr_accounts | `settlement_entity`, `inr_settlement_account` (encrypted, unique HMAC, ACTIVE/PAUSED/UNAVAILABLE), `inr_account_day` (FI-30 anchor; trigger refuses commitments growing past capacity, IX030), `capacity_reservation` (purpose + exactly one subject, partial consumption, ACTIVE→CONSUMED/RELEASED once, no delete); deferred trigger: day `reserved` = Σ open reservation remainders (IX031) |
| 0010 | routes_pricing | `liquidity_route` (schema knows PER_TRADE/PREFUNDED/NET_SETTLED; constraint `liquidity_route_v1_per_trade_only`), `rate_snapshot` (append-only, series-checked supersedes chain, IX042) |
| 0011 | treasury_custody | `treasury_wallet`, `custody_provider_config` (append-only), `deposit_address` (unique address and provider reference; POOL born AVAILABLE, DERIVED born ASSIGNED; whitelist AVAILABLE→ASSIGNED→COOLDOWN→AVAILABLE/RETIRED), `deposit_assignment` (unique trade, one open per address, release once); deferred trigger: ASSIGNED ⇔ exactly one open assignment (IX043) |

Grants: `inrp2p_app` gets SELECT/INSERT and column-level UPDATE only on the mutable columns; no DELETE on any Phase 2 table. `inrp2p_readonly` cannot read encrypted columns or HMACs.

## 4. Commands and permissions

Every mutation runs through `executeCommand` (idempotency → authorization in the transaction → locks → writes → audit/outbox). Permissions are the existing SECURITY §3 matrix; no matrix cell changed.

| Command | Permission | Audit |
|---|---|---|
| `client.create` / `client.update` (expected version) / `client.set_status` | `client:manage` | `client.created` / `client.updated` / `client.suspended`·`client.reactivated` |
| `client_contact.add` / `archive` | `client:manage_contacts` | `client_contact.added` / `archived` |
| `client_user.link` / `set_status` | `client:manage` | `client_user.linked` / `disabled`·`enabled` |
| `client_user.set_accept_quotes` | operator `client_user:grant_accept_quotes` ⧗, or CLIENT_ADMIN of that client with fresh TOTP | `client_user.accept_permission_changed` |
| `client_bank.add` / `archive` | operator `client_bank:add` ⧗, or CLIENT_ADMIN with fresh TOTP (D-08) | `client_bank.added` / `archived` + outbox `client.destination_*` |
| `client_wallet.add` / `archive` | same as bank accounts (see §6.2) | `client_wallet.added` / `archived` + outbox |
| `bank_account.reveal` | `bank_account:reveal` ⧗; refused with an idempotency key | `bank_account.revealed` |
| `settlement_entity.create`, `inr_account.create` / `set_status` | `inr_account:manage` ⧗ | `settlement_entity.created`, `settlement_account.created` / `status_changed` |
| `capacity.set_day` / `set_default` | `capacity:change` ⧗ | `capacity.changed` / `capacity.default_changed` (+ outbox `capacity.over_committed`) |
| `capacity.reserve` (financial) | `settlement:reserve_capacity` | `capacity.reserved` |
| `routes.create` / `configure` / `set_status` / `set_settlement_model` | `routes:configure` ⧗ | `routes.created` / `configured`·`execution_mode_changed` / `status_changed` / `settlement_model_changed` |
| `rates.publish_route_rate`, `rates.record_reference_rate` | `rates:update_route` | `rate.changed`, `rate.reference_recorded` |
| `treasury.register_wallet` / `set_wallet_status` | `treasury:manage_wallets` ⧗ | `treasury_wallet.registered` / `status_changed` |
| `custody.record_capability`, `import_pool_addresses`, `retire_deposit_address` | `custody:configure` ⧗ | `custody.capability_changed`, `deposit_address.imported`, `deposit_address.retired` |

Domain functions for later phases (called inside their commands, not exposed as commands): `reserveCapacity`, `consumeReservation`, `releaseReservation`, `releasePastDayReservations`, `allocateDepositAddress`, `releaseDepositAssignment`, `releaseCooledDownAddresses`, `recordReferenceRate`, `requireUsableRoute`, `requireCurrentRouteRate`, `assertSellAcceptanceSupported`, `isActiveBankAccountOfClient`, `isActiveWalletOfClient`, `listAuthorizedAcceptors`.

## 5. Exit criteria

| Criterion | Evidence (integration, PostgreSQL) |
|---|---|
| Capacity reservation race: two concurrent reservations on last capacity → exactly one succeeds | `inr-accounts/test/capacity.int.test.ts` "exit: two concurrent…" — 5 rounds, each exactly one success and one `CAPACITY_INSUFFICIENT`, remaining = 0; plus 12 concurrent reservations on ₹1,000,000 at ₹150,000 → exactly 6 succeed |
| Two concurrent address allocations never return the same address | `treasury/test/custody.int.test.ts` — 24 concurrent POOL allocations → 24 distinct addresses; 12 concurrent DERIVED allocations → 12 distinct; a provider re-issuing an address is refused (`DEPOSIT_ADDRESS_UNAVAILABLE`) and writes nothing; DB refuses a second open assignment |
| Capability recorded in `custody_provider_config` and queryable by the acceptance module | same file — default UNSUPPORTED blocks; recorded POOL returned by `assertSellAcceptanceSupported`; history append-only; changes audited with before/after |
| Non-`PER_TRADE` route model rejected | `pricing/test/routes-rates.int.test.ts` — create and change commands return `ROUTE_SETTLEMENT_MODEL_UNSUPPORTED`; direct UPDATE/INSERT rejected by constraint; no audit written |
| Paused account rejects reservations | capacity test — PAUSED and UNAVAILABLE → `ACCOUNT_NOT_ACTIVE`; ACTIVE again accepts; status changes audited |
| Rate snapshot append-only | routes-rates test — UPDATE denied to app role; UPDATE/DELETE/TRUNCATE rejected by trigger for the owner; cross-series supersede rejected; concurrent publishers keep one linear chain |
| Client bank change audited | clients test — add → archive → add produces `client_bank.added`, `client_bank.archived`, `client_bank.added` with actor, plus outbox notifications; in-place edit refused by grants and trigger; ARCHIVED cannot return to ACTIVE |

Additional coverage: envelope encryption (no plaintext in rows, audit or idempotency store; tamper and context binding; KEK rotation), reveal gating, client-admin vs trader vs other-client authorization and surface mismatch, TRON checksum typos, acceptors require verified email and ACTIVE user, partial consume + exactly-once release, capacity lowering below commitments (no cancellation, blocks new reservations, outbox signal), DB-level capacity and day-total guards, day rollover, cooldown and reuse, derived-address retirement, worker jobs as `inrp2p_worker`.

### Local gate
| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | lockfile updated for new workspace packages only; no new external dependencies |
| `workspace:graph` | acyclic, 16 packages |
| `versions:check` | OK (17 manifests) |
| `secret-scan` | clean (460 files) |
| `lint` | 0 problems; boundary rules added for the 6 new packages; float-money bans extended to them |
| `typecheck` | root + apps/web + packages/ui |
| `test:unit` | 188 passed |
| `test:integration` | 407 passed (13 files; 45 new) — local PostgreSQL 18.4; CI asserts 18.6 |
| `@inrp2p/web build` | success |

## 6. Interpretations and deviations for review

1. **Capacity primitives live in `inr-accounts`**, not `settlement`. ARCHITECTURE §3 lists capacity reservations under `settlement`, which does not exist until Phase 4; the day row is the concurrency anchor owned by INR accounts. Phase 4 settlement commands call the public `reserveCapacity` / `consumeReservation` / `releaseReservation`. No semantic change.
2. **Client wallets use `client_bank:add`.** The matrix has no wallet row; wallets are destinations with the same S8 risk, so they share the bank-account permission and client-admin TOTP rule.
3. **Step-up for client-admin acceptance grants.** SECURITY §2.2 says grants are "step-up, audited"; applied to both operator and CLIENT_ADMIN paths. If client admins without TOTP must be able to grant, this is a one-line change.
4. **SECURITY §6 "SECURITY DEFINER transition functions"** is implemented as status-whitelist triggers plus column-level UPDATE grants (same guarantee: the app role cannot write an unlisted transition or column). Revisit when trade/leg state machines arrive in Phases 3–4.
5. **Foreign keys to later tables** (`capacity_reservation.trade_id` / `route_settlement_id`, `deposit_assignment.trade_id`) are plain uuid columns now; the migrations that create `trade` and `route_settlement` add the FKs.
6. **Exceptions are not opened yet.** Capacity lowered below commitments emits outbox `capacity.over_committed`; the `ROUTE_CAPACITY_CHANGED` exception and `DEPOSIT_POOL_LOW` alerts are created by the exception module (Phase 4). No data is lost: the signal is durable.
7. **Encryption keys.** Only `LocalKeyEncryptionKey` exists (dev/test). A KMS-backed `KeyEncryptionKey` is required before production (TD-03). Nothing in the app is wired to real keys yet; there is no HTTP boundary in this phase.
8. **Route and rate tests live in `packages/pricing/test`**, so `routes` needs no dev dependency on `pricing` (keeps the graph acyclic).
9. **Compliance hooks** (`kyc_status`, `screening_status`, notes) exist as columns with no commands, per D-07 (schema-level hooks only).
