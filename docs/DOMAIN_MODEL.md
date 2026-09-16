# INRP2P Exchange — Domain Model

Status: Phase 0, revision 2 (decisions D-01…D-13 applied).
Conventions: ids are UUIDv7 (time-ordered) unless noted; human references (`IX-260916-1842`) are separate unique columns. All timestamps `timestamptz` (UTC stored, IST displayed). Money/rate columns follow `FINANCIAL_INVARIANTS.md §1`. `created_at`, `created_by` on every table; mutable tables also carry `version` (optimistic check) in addition to row locks.

## 1. ERD

```mermaid
erDiagram
  USER ||--o{ USER_ROLE : has
  ROLE ||--o{ ROLE_PERMISSION : grants
  USER ||--o{ SESSION : opens
  USER ||--o| MFA_FACTOR : secures

  CLIENT ||--o{ CLIENT_CONTACT : has
  CLIENT ||--o{ CLIENT_USER : "logs in as"
  CLIENT ||--o{ BANK_ACCOUNT : saves
  CLIENT ||--o{ CRYPTO_WALLET : saves

  SETTLEMENT_ENTITY ||--o{ INR_SETTLEMENT_ACCOUNT : owns
  INR_SETTLEMENT_ACCOUNT ||--o{ INR_ACCOUNT_DAY : "capacity per IST day"
  LIQUIDITY_ROUTE ||--o{ RATE_SNAPSHOT : publishes
  LIQUIDITY_ROUTE ||--o{ ROUTE_OBLIGATION : "owes / is owed"
  LIQUIDITY_ROUTE ||--o{ ROUTE_SETTLEMENT : "settles via"
  ROUTE_SETTLEMENT ||--o{ ROUTE_SETTLEMENT_ALLOCATION : allocates
  ROUTE_OBLIGATION ||--o{ ROUTE_SETTLEMENT_ALLOCATION : "satisfied by"

  CLIENT ||--o{ TRADE_REQUEST : raises
  TRADE_REQUEST ||--o{ QUOTE : "answered by"
  QUOTE ||--o| QUOTE_LINK : "shared via"
  QUOTE ||--o{ ACCEPTANCE_CHALLENGE : "verified by"
  CLIENT_USER ||--o{ ACCEPTANCE_CHALLENGE : "receives OTP"
  RATE_SNAPSHOT ||--o{ QUOTE : "route snapshot"
  QUOTE ||--o| TRADE : "accepted into"

  TRADE ||--|| TRADE_ECONOMICS : "frozen terms"
  TRADE ||--|| ROUTE_OBLIGATION : "route side (PER_TRADE)"
  TRADE ||--o{ SETTLEMENT_LEG : "settles via"
  SETTLEMENT_LEG ||--o| FIAT_TRANSFER : "INR evidence"
  ROUTE_SETTLEMENT ||--o| FIAT_TRANSFER : "INR evidence"
  SETTLEMENT_LEG ||--o{ CRYPTO_TRANSFER_ALLOCATION : "USDT evidence"
  CRYPTO_TRANSFER ||--o{ CRYPTO_TRANSFER_ALLOCATION : "allocated (leg or route settlement)"
  ROUTE_SETTLEMENT ||--o{ CRYPTO_TRANSFER_ALLOCATION : "USDT evidence"
  TRADE ||--o{ CAPACITY_RESERVATION : reserves
  ROUTE_SETTLEMENT ||--o{ CAPACITY_RESERVATION : "reserves (INR out)"
  INR_ACCOUNT_DAY ||--o{ CAPACITY_RESERVATION : "drawn from"
  TREASURY_WALLET ||--o{ DEPOSIT_ADDRESS : "is / contains"
  DEPOSIT_ADDRESS ||--o{ DEPOSIT_ASSIGNMENT : "assigned to trade"
  TRADE ||--o{ FINANCIAL_ADJUSTMENT : "corrected by"
  TRADE ||--o{ EXCEPTION_CASE : raises
  TRADE ||--o| RECEIPT : "settled into"

  LEDGER_JOURNAL ||--|{ LEDGER_ENTRY : contains
  LEDGER_ACCOUNT ||--o{ LEDGER_ENTRY : "posted to"

  ATTACHMENT }o--|| SETTLEMENT_LEG : "proof"
  AUDIT_EVENT }o--|| USER : "actor"
  NOTIFICATION }o--|| OUTBOX_EVENT : "produced by"
```

## 2. Modules and entities

### 2.1 Identity
| Entity | Key fields | Notes |
|---|---|---|
| `user` | email (unique, citext), email_verified_at, display_name, kind (`OPERATOR`,`CLIENT`), status (`ACTIVE`,`DISABLED`), password_hash (argon2id, nullable for passwordless clients) | One table, two kinds; client users link via `client_user` |
| `role` | code (`OWNER`,`DEALER`,`SETTLEMENT_OPERATOR`,`FINANCE`,`SUPPORT`,`READ_ONLY`) | Seeded; custom roles later |
| `permission` / `role_permission` | code e.g. `quote:send` | Matrix in `SECURITY.md §3` |
| `user_role` | user_id, role_id, granted_by | Changes audited |
| `mfa_factor` | user_id, type (`TOTP`), secret (encrypted), confirmed_at | Required for every operator |
| `session` | token_hash, user_id, surface (`CLIENT`,`OPERATOR`), mfa_verified_at, ip, ua, expires_at, revoked_at | Opaque token in cookie; only hash stored |

### 2.2 Clients
| Entity | Key fields |
|---|---|
| `client` | ref (`CL-0042`), legal_name, display_name, type (`COMPANY`,`INDIVIDUAL`), status (`ACTIVE`,`SUSPENDED`), typical_direction, typical_size_usdt_minor, pricing_notes (operator-only), kyc_status, screening_status, compliance_notes (compliance hooks, `DECISIONS.md D-07`; `kyc_status` gates quote acceptance when policy enables it) |
| `client_contact` | client_id, name, email, phone, telegram_handle, whatsapp_number, is_primary, notes — operator CRM record; **not** an authentication or OTP channel |
| `client_user` | client_id, user_id, role (`CLIENT_ADMIN`,`CLIENT_TRADER`), can_accept_quotes (bool, audited), status — "verified client contact" for D-01 = `user.email` of a client_user with `can_accept_quotes` and `email_verified_at` set |
| `bank_account` (client beneficiary) | client_id, holder_name, bank_name, ifsc, account_number_enc, account_last4, account_hmac, rail_preferences, status (`ACTIVE`,`ARCHIVED`), verified_at | Unique `(client_id, account_hmac)` among ACTIVE. Never edited in place — change = archive + new row (so a quote's target can't silently change) |
| `crypto_wallet` (client) | client_id, network, address, label, purpose (`SOURCE`,`DESTINATION`,`BOTH`), status | Same archive-not-edit rule; unique `(client_id, network, address)` |

Derived (query, not stored): total completed volume, total gross margin, last trade, open trades.

### 2.3 INR Accounts
| Entity | Key fields |
|---|---|
| `settlement_entity` | legal_name, short_name ("Company A"), status |
| `inr_settlement_account` | entity_id, bank_name, account_last4, account_enc, ifsc, rails (`IMPS`,`NEFT`,`RTGS`,`UPI`), direction (`PAYOUT`,`COLLECTION`,`BOTH`), status (`ACTIVE`,`PAUSED`,`UNAVAILABLE`), default_daily_capacity_minor, notes |
| `inr_account_day` | account_id, day (IST date), capacity_minor, used_minor, reserved_minor, pending_payout_minor | PK `(account_id, day)`; created lazily from default; the concurrency anchor for FI-30 |
| `capacity_reservation` | purpose (`CLIENT_PAYOUT`,`ROUTE_SETTLEMENT`), trade_id (nullable), route_settlement_id (nullable; exactly one of the two set), account_id, day, amount_minor, status (`ACTIVE`,`CONSUMED`,`RELEASED`), consumed_minor, released_reason | Partially consumable: legs consume, remainder released. Outgoing INR route settlements draw on the same daily capacity |

`remaining = capacity − used − reserved` (can be negative only after an audited capacity reduction).

### 2.4 Routes and pricing
| Entity | Key fields |
|---|---|
| `liquidity_route` | name (internal only), direction, asset, network, status, settlement_model (`PER_TRADE` · `PREFUNDED` · `NET_SETTLED`; V1 validation accepts only `PER_TRADE`), available_base_minor (operator-maintained), notes. **Never** exposed to client APIs |
| `route_obligation` | ref, route_id, trade_id (unique while model = `PER_TRADE`; nullable for future netting), direction, exchange_delivers_asset, exchange_delivers_minor, route_delivers_asset, route_delivers_minor, status (`EXPECTED`,`OPEN`,`PARTIALLY_SETTLED`,`SETTLED`,`CANCELLED`), opened_at, settled_at — amounts copied from `trade_economics` at acceptance and never updated. SELL: exchange delivers `base` USDT, route delivers `route_value_inr`. BUY: exchange delivers `route_value_inr` INR, route delivers `base` USDT |
| `route_settlement` | ref, route_id, flow (`TO_ROUTE`,`FROM_ROUTE`), asset, amount_minor, inr_account_id / treasury_wallet_id, adapter (`MANUAL`), adapter_reference, status (`RECORDED`,`CONFIRMED`,`FAILED`), recorded_by, confirmed_by, confirmed_at, notes — evidence: `fiat_transfer` (INR, UTR) or `crypto_transfer_allocation` (USDT) |
| `route_settlement_allocation` | route_settlement_id, route_obligation_id, amount_minor, allocated_by — Σ per settlement ≤ settlement amount; Σ per obligation side ≤ obligation (FI-61) |
| `rate_snapshot` | kind (`REFERENCE`,`ROUTE`), route_id (null for reference), direction, rate_micro, source (`OPERATOR`,`FEED:{name}`), effective_at, created_by, supersedes_id | Append-only; "current route rate" = latest by `effective_at` per route+direction |

### 2.5 Quotes
| Entity | Key fields |
|---|---|
| `trade_request` | ref, client_id, direction, fixed_side, requested_base_minor / requested_quote_minor, target_rate_micro (nullable), bank_account_id / crypto_wallet_id (destination), source_wallet_id (SELL expected sender, optional), channel (`CLIENT_APP`,`OPERATOR`,`LINK`), status (`OPEN`,`QUOTED`,`ACCEPTED`,`DECLINED`,`WITHDRAWN`,`EXPIRED`), assigned_dealer_id |
| `quote` | ref, trade_request_id, client_id, direction, fixed_side, base_minor, quote_inr_minor, client_rate_micro, route_rate_micro, route_rate_snapshot_id, route_id, route_value_inr_minor, gross_margin_inr_minor, network, bank_account_id, crypto_wallet_id, valid_for_seconds, sent_at, expires_at, status (`DRAFT`,`SENT`,`ACCEPTED`,`EXPIRED`,`REJECTED`,`CANCELLED`), cancel_reason (`SUPERSEDED`,`DECLINED_BY_DESK`,`WITHDRAWN`,`OPERATOR`), is_counter, negative_margin_reason, created_by, accepted_by_user_id, accepted_via (`APP`,`LINK`), acceptance_challenge_id (required when `LINK`), accepted_at |
| `quote_link` | quote_id (unique), token_hash (sha256, unique), created_by, first_opened_at, open_count, revoked_at — token = 128-bit random, base62 (22 chars); expires with the quote; grants view only |
| `acceptance_challenge` | quote_id, quote_link_id, client_user_id, channel (`EMAIL`; later `TELEGRAM`,`WHATSAPP`,`SMS`), destination_masked, code_hash, code_salt, expires_at (≤ 5 min and ≤ quote.expires_at), attempts, max_attempts (5), status (`PENDING`,`CONSUMED`,`FAILED`,`EXPIRED`,`SUPERSEDED`), sent_at, consumed_at, ip_hash — partial unique: one `PENDING` per `(quote_id, client_user_id)`; unique `quote.acceptance_challenge_id` |

Client-facing projection `ClientQuoteView` is a separate type containing only: ref, direction, base, inr amount, client rate, network, masked target, expires_at, status. It is the only shape the client API and the link page can serialize (enforced by type + test that serialized JSON contains no forbidden keys).

### 2.6 Trades
| Entity | Key fields |
|---|---|
| `trade` | ref (`IX-YYMMDD-NNNN`), quote_id (unique), trade_request_id, client_id, direction, lifecycle_state, hold (bool, derived from open blocking exceptions, stored for queue queries), opened_at, completed_at, cancelled_at |
| `trade_economics` | trade_id (PK), base_minor, quote_inr_minor, client_rate_micro, route_rate_micro, route_value_inr_minor, gross_margin_inr_minor, fees_json (explicit fee lines, V1 empty), network, bank_account_id, crypto_wallet_id, frozen_at | Insert-once |
| `trade_transition` | trade_id, from_state, to_state, command, actor, correlation_id, at | Append-only history (in addition to audit) |
| `financial_adjustment` | trade_id, type (`AMOUNT_CORRECTION`,`RATE_CORRECTION`,`FEE`,`WRITE_OFF`,`REFUND`), delta fields (base, quote_inr, margin), reason, evidence_attachment_ids, requested_by, approved_by (must differ, `SECURITY.md §4`), ledger_journal_id | Effective terms = economics ⊕ Σ approved adjustments |
| `exception_case` | ref, trade_id (nullable: unallocated funds), type (enum §3), severity (`BLOCKING`,`WARNING`), status (`OPEN`,`IN_PROGRESS`,`RESOLVED`,`VOID`), subject_type/subject_id, detected_by (`SYSTEM`,`OPERATOR`), resolution_command, resolution_notes, resolved_by, resolved_at | Unique open case per `(type, subject_type, subject_id)` |

### 2.7 Settlement
`settlement_leg` is the unit of value movement **for a trade**, in either direction.

| Field | Notes |
|---|---|
| trade_id, ref (`IX-…-L3`) | |
| side | `CLIENT_TO_EXCHANGE` (first leg) · `EXCHANGE_TO_CLIENT` (payout) · `REFUND_TO_CLIENT` |
| asset | `INR` or `USDT` |
| amount_minor | Planned amount |
| status | see `STATE_MACHINES.md §4` |
| inr_account_id / capacity_reservation_id | INR legs from exchange |
| destination_bank_account_id / destination_wallet_id | Snapshot of target at creation |
| operator_id, notes, created_at, sent_at, confirmed_at, failed_at, failure_reason | |

| Evidence entity | Key fields |
|---|---|
| `fiat_transfer` | exactly one of settlement_leg_id (unique) · route_settlement_id (unique), rail, utr, utr_normalized, amount_minor, source_account_id, destination (masked snapshot), value_date, recorded_by, proof_attachment_id | Unique `(rail, utr_normalized)` |
| `crypto_transfer` | network, tx_hash, log_index, token_contract, from_address, to_address, amount_minor, block_number, block_time, detected_at, receipt_status, state (`DETECTED`,`CONFIRMED`,`FAILED`,`ORPHANED`), confirmed_at, source (`SCANNER`,`OPERATOR_SUBMITTED`) | Unique `(network, tx_hash, log_index)` |
| `crypto_transfer_allocation` | crypto_transfer_id (unique), exactly one of settlement_leg_id · route_settlement_id · exception_case_id, amount_minor, allocated_by — one transfer → one destination; over/short handled by exception, not by splitting silently. Client deposits are allocated only through the trade's deposit assignment (D-02) |
| `attachment` | storage_key, sha256, mime, size, uploaded_by, subject_type/id | Immutable; replacing = new attachment |

### 2.8 Crypto / Treasury
| Entity | Key fields |
|---|---|
| `treasury_wallet` | network, address, label, role (`HOT`,`COLD`,`DEPOSIT_POOL`), status (`ACTIVE`,`PAUSED`,`RETIRED`), custody (`EXTERNAL`), observed_balance_minor, observed_at, reserved_minor |
| `deposit_address` | treasury_wallet_id, network, address (unique), source (`DERIVED`,`POOL`), custody_reference (provider id / derivation index — never key material), status (`AVAILABLE`,`ASSIGNED`,`COOLDOWN`,`RETIRED`), cooldown_until |
| `custody_provider_config` | provider, network, deposit_address_capability (`DERIVED`,`POOL`,`UNSUPPORTED`), verified_by, verified_at, notes — recorded result of the D-02 gate; `UNSUPPORTED` blocks SELL acceptance |
| `deposit_assignment` | deposit_address_id, trade_id (unique), expected_amount_minor, assigned_at, released_at | Partial unique: one open assignment per address. The only mechanism that attributes client USDT to a trade (`DECISIONS.md D-02`) |
| `chain_cursor` | network, scanner, last_scanned_block, last_solidified_block, updated_at | Scanner progress |

Treasury view (derived): observed, reserved, available = observed − reserved, incoming pending (DETECTED inbound + expected on open SELL trades), outgoing pending (unconfirmed BUY payout legs), today received/sent (confirmed, IST day).

### 2.9 Ledger
| Entity | Key fields |
|---|---|
| `ledger_account` | code (unique, e.g. `LIAB:CLIENT_PAYABLE:{uuid}`), type, currency, subject_type/id |
| `ledger_journal` | posting_key (unique), event_type, trade_id, correlation_id, posted_at, posted_by, reverses_journal_id |
| `ledger_entry` | journal_id, account_id, currency, direction (`DR`,`CR`), amount_minor (> 0) |

Balances are computed from entries; a `ledger_balance` cache may exist but is rebuildable and never authoritative.

### 2.10 Audit
`audit_event`: seq (bigserial), at, actor_type (`USER`,`SYSTEM`,`CLIENT_LINK`), actor_id, surface, action (e.g. `quote.accepted`), entity_type, entity_id, before (redacted jsonb), after (redacted jsonb), correlation_id, idempotency_key, ip_hash, session_id.
`audit_seal`: from_seq, to_seq, prev_seal_hash, seal_hash, sealed_at.

### 2.11 Notifications & infrastructure
| Entity | Key fields |
|---|---|
| `outbox_event` | id, type, payload, aggregate_type/id, created_at, dispatched_at, attempts, last_error |
| `notification` | recipient_user_id, template, payload (no secrets), created_from_event_id, read_at |
| `notification_delivery` | notification_id, channel (`IN_APP`,`EMAIL`, later `TELEGRAM`,`WHATSAPP`,`SMS`), status, attempts, provider_message_id — unique `(notification_id, channel)` |
| `idempotency_key` | scope, key, request_hash, response, status, created_at, expires_at — unique `(scope, key)` |
| `receipt` | trade_id, version, snapshot_json (immutable), sha256, pdf_key, csv_key, json_key, generated_at |

## 3. Exception types

| Type | Detected by | Blocking | Typical resolution commands |
|---|---|---|---|
| `USDT_WRONG_AMOUNT` (short) | Scanner vs expected | yes | `await_top_up` · `adjust_trade_to_received` (approval) · `refund_and_cancel` |
| `USDT_OVERPAYMENT` | Scanner | yes | `refund_excess` · `adjust_trade_to_received` (DEALER re-price approval) |
| `USDT_UNEXPECTED_SENDER` | Transfer already attributed by its deposit assignment, but `from` is not a registered client source wallet (sender is checked, never used for attribution) | yes | `accept_sender` (records verification) · `refund` |
| `WRONG_NETWORK` | Client/operator report (not detectable on TRON) | yes | `record_recovery_outcome` · `cancel` |
| `TX_NOT_FINAL` | Aging job (detected > N min without solidification) | warning | automatic on confirmation · `mark_failed` |
| `FUNDS_AFTER_TRADE_CLOSED` | USDT arrives at a deposit address in `COOLDOWN` whose last assignment was a cancelled/completed trade (client known from that assignment) | yes | `requote_for_same_client` (new quote + trade, allocation via new assignment of the same address, DEALER + FINANCE) · `refund` (two-person) |
| `UNALLOCATED_DEPOSIT` | USDT arrives at an address that was never assigned, or at a treasury wallet directly | yes | `refund` (two-person, destination verified out of band) · `hold_in_suspense` — never attributed to a trade by amount or sender |
| `DEPOSIT_POOL_LOW` | `custody.pool_health` job | warning | `replenish_pool` (in custody provider) |
| `ROUTE_SETTLEMENT_MISMATCH` | Route settlement amount/evidence does not match allocations | yes | `reallocate` · `financial_adjustment` |
| `ROUTE_OBLIGATION_OVERDUE` | Open obligation older than route SLA | warning | `record_route_settlement` · escalate |
| `DUPLICATE_TX_HASH` | Unique violation on allocation attempt | yes | `void` (idempotent replay) · `reallocate` |
| `DUPLICATE_UTR` | Unique violation on UTR entry | yes | `correct_utr` (audited) · `void` |
| `PARTIAL_INR_PAYOUT` | Leg confirmed amount < planned | warning | `create_remaining_leg` |
| `INR_PAYOUT_DELAYED` | SLA timer on SENT legs | warning | `confirm` · `mark_failed` |
| `BANK_TRANSFER_FAILED` | Operator/rail | yes | `mark_failed` → `create_replacement_leg` (capacity re-reserved) |
| `CLIENT_BANK_CHANGED` | Client archives destination after quote/accept | yes | `confirm_new_destination` (step-up + audit; legs not yet sent move) · `keep_original` |
| `ROUTE_CAPACITY_CHANGED` | Capacity/route availability lowered below commitments | warning | `reallocate_reservations` |
| `TRADE_CANCELLATION` | Operator/client request after acceptance | yes | `cancel_trade` (only if no confirmed funds) · `refund_and_cancel` |
| `OPERATOR_MISTAKE` | Operator | yes | `financial_adjustment` (two-person) |
| `RECONCILIATION_MISMATCH` | Reconcile job | yes | `financial_adjustment` · `attach_evidence_and_void` |

Every resolution is a domain command with its own permission, audit, and (where money moves) ledger journal. No resolution edits rows directly.

## 4. Normalization notes / deviations from the prompt's entity list

- `TradeRequest`, `Quote`, `QuoteLink`, `Trade`, `SettlementLeg`, `CryptoTransfer`, `FiatTransfer`, `CapacityReservation`, `LedgerAccount`, `LedgerEntry`, `FinancialAdjustment`, `Attachment`, `ExceptionCase`, `AuditEvent`, `Notification`: kept as named.
- Added `trade_economics` (split from `trade`) so frozen terms are physically insert-only.
- Added `ledger_journal` (groups balanced entries; carries the unique posting key).
- Added `inr_account_day` as the capacity concurrency anchor instead of mutable totals on the account.
- Added `deposit_address` / `deposit_assignment` / `custody_provider_config` for USDT attribution by unique per-trade address (`DECISIONS.md D-02`).
- Added `acceptance_challenge` for OTP-verified quote-link acceptance (`DECISIONS.md D-01`).
- `LiquidityRoute` extended with `settlement_model`; added `route_obligation`, `route_settlement`, `route_settlement_allocation`, kept separate from client settlement (`DECISIONS.md D-03`).
- Split client-owned `crypto_wallet` from exchange-owned `treasury_wallet` — they have different permissions, lifecycles and exposure.
- `Role/Permission` → `role`, `permission`, `role_permission`, `user_role`.
