import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, never>;
type Json = unknown;

export interface CurrencyTable {
  code: string;
  minor_unit_exponent: number;
}

export interface IdempotencyKeyTable {
  scope: string;
  key: string;
  request_hash: string;
  actor_id: string | null;
  status: 'PENDING' | 'COMPLETED';
  response: Json | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface AuditEventTable {
  seq: Generated<bigint>;
  id: Generated<string>;
  at: Generated<Date>;
  actor_type: 'USER' | 'SYSTEM' | 'CLIENT_LINK';
  actor_id: string | null;
  surface: 'OPERATOR' | 'CLIENT' | 'PUBLIC' | 'SYSTEM';
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Json | null;
  after: Json | null;
  correlation_id: string;
  idempotency_key: string | null;
  session_id: string | null;
  ip_hash: string | null;
}

export interface AuditSealTable {
  id: Generated<bigint>;
  from_seq: bigint;
  to_seq: bigint;
  event_count: bigint;
  prev_seal_hash: string | null;
  seal_hash: string;
  sealed_at: Generated<Date>;
}

/** One contiguous range of audit seals written to write-once storage (migration 0034, TD-17). */
export interface AuditSealExportTable {
  id: Generated<string>;
  first_seal_id: bigint;
  last_seal_id: bigint;
  from_seq: bigint;
  to_seq: bigint;
  seal_count: number;
  last_seal_hash: string;
  bucket: string;
  object_key: string;
  version_id: string | null;
  sha256: string;
  retain_until: Date;
  exported_at: Generated<Date>;
}

/** Each comparison of the seal archive with the database (migration 0034). */
export interface AuditArchiveVerificationTable {
  id: Generated<string>;
  ran_at: Generated<Date>;
  ok: boolean;
  archived_seals: number;
  findings: Generated<unknown>;
  superseded: Generated<unknown>;
}

/** Each restore drill and what it proved (migration 0034, TD-16). */
export interface BackupVerificationTable {
  id: Generated<string>;
  kind: 'DUMP_RESTORE' | 'POINT_IN_TIME';
  ran_at: Generated<Date>;
  ok: boolean;
  recovered_to: Date | null;
  restore_seconds: number | null;
  environment: string;
  findings: Generated<unknown>;
  recorded_by: string;
}

/** Outgoing payments held after the database changed underneath (migration 0034). */
export interface RestoreFenceTable {
  id: Generated<string>;
  ref: Generated<string>;
  status: Generated<'RAISED' | 'LIFTED'>;
  reason: string;
  raised_by: string;
  raised_at: Generated<Date>;
  identity_before: unknown;
  identity_after: unknown;
  known_until: Date | null;
  lift_id: string | null;
  lifted_by: string | null;
  lifted_at: Date | null;
}

/** A reconciliation recorded by one person and approved, or declined, by another (migration 0034). */
export interface RestoreFenceLiftTable {
  id: Generated<string>;
  fence_id: string;
  status: Generated<'REQUESTED' | 'APPROVED' | 'DECLINED'>;
  reconciliation: string;
  requested_by: string;
  requested_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}

export type LedgerAccountType = 'ASSET' | 'LIAB' | 'REVENUE' | 'EXPENSE' | 'SUSPENSE';

export interface LedgerAccountTable {
  id: Generated<string>;
  code: string;
  type: LedgerAccountType;
  currency: string;
  created_at: Generated<Date>;
}

export interface LedgerJournalTable {
  id: Generated<string>;
  posting_key: string;
  event_type: string;
  trade_id: string | null;
  correlation_id: string;
  idempotency_key: string;
  posted_by: string;
  posted_at: Generated<Date>;
  reverses_journal_id: string | null;
  created_txid: Generated<string>;
}

export interface LedgerEntryTable {
  id: Generated<bigint>;
  journal_id: string;
  account_id: string;
  currency: string;
  direction: 'DR' | 'CR';
  amount_minor: bigint;
  trade_id: string | null;
  route_obligation_id: string | null;
}

export interface LedgerAccountBalanceView {
  account_id: string;
  code: string;
  type: LedgerAccountType;
  currency: string;
  dr_minus_cr_minor: bigint;
}

export interface LedgerGlobalImbalanceView {
  currency: string;
  dr_minus_cr_minor: bigint;
}

export interface OutboxEventTable {
  id: Generated<string>;
  type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Json;
  correlation_id: string;
  created_at: Generated<Date>;
  dispatched_at: Date | null;
  failed_at: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface OutboxDeliveryTable {
  event_id: string;
  handler: string;
  delivered_at: Generated<Date>;
}

export interface AuthUserTable {
  id: Generated<string>;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  two_factor_enabled: boolean | null;
  kind: 'OPERATOR' | 'CLIENT';
  status: Generated<'ACTIVE' | 'DISABLED'>;
}

export interface AuthSessionTable {
  id: Generated<string>;
  expires_at: Date;
  token: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  ip_address: string | null;
  user_agent: string | null;
  user_id: string;
  surface: 'OPERATOR' | 'CLIENT';
}

export interface OperatorUserRoleTable {
  user_id: string;
  role_code: string;
  granted_by: string | null;
  granted_at: Generated<Date>;
}

export interface OperatorPermissionGrantTable {
  user_id: string;
  permission_code: string;
  granted_by: string;
  granted_at: Generated<Date>;
}

export interface StepUpVerificationTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  method: 'TOTP';
  verified_at: Generated<Date>;
  ip_hash: string | null;
}

export interface SessionActivityTable {
  session_id: string;
  last_activity_at: Date;
}


// ---- Phase 2 reference data (migrations 0008–0011) ----

export type ClientStatus = 'ACTIVE' | 'SUSPENDED';
export type DirectionValue = 'SELL_USDT' | 'BUY_USDT';

export interface ClientTable {
  id: Generated<string>;
  ref: Generated<string>;
  legal_name: string;
  display_name: string;
  type: 'COMPANY' | 'INDIVIDUAL';
  status: Generated<ClientStatus>;
  /** Exchange, History and quotes (migration 0023). Off for a client that exists only because it applied to be a trader. */
  exchange_access: Generated<boolean>;
  typical_direction: DirectionValue | null;
  typical_size_usdt_minor: bigint | null;
  pricing_notes: string | null;
  kyc_status: Generated<'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'>;
  screening_status: Generated<'NOT_SCREENED' | 'CLEAR' | 'POTENTIAL_MATCH' | 'CONFIRMED_MATCH'>;
  compliance_notes: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface ClientContactTable {
  id: Generated<string>;
  client_id: string;
  name: string;
  email: string | null;
  phone_enc: string | null;
  phone_last4: string | null;
  whatsapp_enc: string | null;
  whatsapp_last4: string | null;
  telegram_handle: string | null;
  is_primary: Generated<boolean>;
  notes: string | null;
  status: Generated<'ACTIVE' | 'ARCHIVED'>;
  created_by: string;
  created_at: Generated<Date>;
  archived_by: string | null;
  archived_at: Date | null;
}

export type ClientUserRole = 'CLIENT_ADMIN' | 'CLIENT_TRADER';

export interface ClientUserTable {
  id: Generated<string>;
  client_id: string;
  user_id: string;
  role: ClientUserRole;
  can_accept_quotes: Generated<boolean>;
  status: Generated<'ACTIVE' | 'DISABLED'>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type Rail = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';

/**
 * A destination's review state (migration 0023). ACTIVE is "verified": the only state anything settles through. A
 * destination the client submitted itself starts PENDING_REVIEW until an operator verifies or rejects it.
 */
export type DestinationStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'REJECTED' | 'ARCHIVED';

export interface BankAccountTable {
  id: Generated<string>;
  client_id: string;
  holder_name: string;
  bank_name: string;
  ifsc: string;
  account_number_enc: string;
  account_last4: string;
  account_hmac: string;
  rail_preferences: Rail[];
  status: Generated<DestinationStatus>;
  verified_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  archived_by: string | null;
  archived_at: Date | null;
  archive_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
}

export interface CryptoWalletTable {
  id: Generated<string>;
  client_id: string;
  network: 'TRON';
  address: string;
  label: string;
  purpose: 'SOURCE' | 'DESTINATION' | 'BOTH';
  status: Generated<DestinationStatus>;
  created_by: string;
  created_at: Generated<Date>;
  archived_by: string | null;
  archived_at: Date | null;
  archive_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
}

export interface SettlementEntityTable {
  id: Generated<string>;
  legal_name: string;
  short_name: string;
  status: Generated<'ACTIVE' | 'INACTIVE'>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type InrAccountStatus = 'ACTIVE' | 'PAUSED' | 'UNAVAILABLE';

export interface InrSettlementAccountTable {
  id: Generated<string>;
  entity_id: string;
  label: string;
  bank_name: string;
  ifsc: string;
  account_number_enc: string;
  account_last4: string;
  account_hmac: string;
  rails: Rail[];
  direction: 'PAYOUT' | 'COLLECTION' | 'BOTH';
  status: Generated<InrAccountStatus>;
  default_daily_capacity_minor: bigint;
  notes: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
  /** ADR 0018: who payers pay, and the account's UPI ID when it has one. */
  upi_vpa: string | null;
  beneficiary_name: string | null;
}

export interface InrAccountDayTable {
  account_id: string;
  day: string;
  capacity_minor: bigint;
  used_minor: Generated<bigint>;
  reserved_minor: Generated<bigint>;
  pending_payout_minor: Generated<bigint>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED';
export type ReservationReleaseReason = 'TRADE_CANCELLED' | 'LEG_CANCELLED' | 'LEG_FAILED' | 'TRADE_COMPLETED' | 'ROUTE_SETTLEMENT_FAILED' | 'DAY_ROLLOVER' | 'OPERATOR' | 'TRADER_PAYOUT_FAILED';

export interface CapacityReservationTable {
  id: Generated<string>;
  purpose: 'CLIENT_PAYOUT' | 'ROUTE_SETTLEMENT' | 'TRADER_REWARD_PAYOUT';
  trade_id: string | null;
  route_settlement_id: string | null;
  trader_reward_payout_id: Generated<string | null>;
  account_id: string;
  day: string;
  amount_minor: bigint;
  consumed_minor: Generated<bigint>;
  status: Generated<ReservationStatus>;
  released_minor: Generated<bigint>;
  released_reason: ReservationReleaseReason | null;
  created_by: string;
  created_at: Generated<Date>;
  closed_at: Date | null;
}

export type RouteStatus = 'ACTIVE' | 'PAUSED' | 'RETIRED';
export type SettlementModel = 'PER_TRADE' | 'PREFUNDED' | 'NET_SETTLED';
export type ExecutionMode = 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE' | 'P2P';

export interface LiquidityRouteTable {
  id: Generated<string>;
  name: string;
  direction: DirectionValue | 'BOTH';
  asset: Generated<'USDT'>;
  network: Generated<'TRON'>;
  status: Generated<RouteStatus>;
  settlement_model: Generated<SettlementModel>;
  execution_mode: ExecutionMode;
  registered_payout_identity: string | null;
  registered_route_address: string | null;
  available_base_minor: Generated<bigint>;
  notes: string | null;
  /** Set on a trader's own route (migration 0022): its rate is the trader's, never the desk's. */
  trader_id: Generated<string | null>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface RateSnapshotTable {
  id: Generated<string>;
  kind: 'REFERENCE' | 'ROUTE';
  route_id: string | null;
  direction: DirectionValue;
  rate_micro: bigint;
  source: string;
  effective_at: Generated<Date>;
  supersedes_id: string | null;
  created_by: string;
  created_at: Generated<Date>;
}

export interface TreasuryWalletTable {
  id: Generated<string>;
  network: 'TRON';
  address: string;
  label: string;
  role: 'HOT' | 'COLD' | 'DEPOSIT_POOL' | 'TRADER_RESERVE' | 'NETWORK_BUDGET';
  status: Generated<'ACTIVE' | 'PAUSED' | 'RETIRED'>;
  /** `HD_SIGNER`: the exchange's own signer holds its key (the network budget wallet, migration 0037). */
  custody: Generated<'EXTERNAL' | 'HD_SIGNER'>;
  observed_balance_minor: Generated<bigint>;
  observed_at: Date | null;
  reserved_minor: Generated<bigint>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustodyProviderConfigTable {
  id: Generated<string>;
  provider: string;
  network: 'TRON';
  deposit_address_capability: 'DERIVED' | 'POOL' | 'UNSUPPORTED';
  consolidation_notes: string | null;
  verified_by: string;
  verified_at: Generated<Date>;
  notes: string | null;
}

export type DepositAddressStatus = 'AVAILABLE' | 'ASSIGNED' | 'COOLDOWN' | 'RETIRED';

export interface DepositAddressTable {
  id: Generated<string>;
  treasury_wallet_id: string;
  network: 'TRON';
  address: string;
  source: 'DERIVED' | 'POOL';
  provider: string;
  custody_reference: string;
  status: DepositAddressStatus;
  cooldown_until: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** What a deposit address is assigned to: a trade (D-02), a trader's reserve, or a trader's delivery on one obligation. */
export type DepositReleaseReason = 'TRADE_COMPLETED' | 'TRADE_CANCELLED' | 'OBLIGATION_SETTLED' | 'OBLIGATION_CANCELLED' | 'TRADER_CLOSED';

export interface DepositAssignmentTable {
  id: Generated<string>;
  deposit_address_id: string;
  trade_id: string | null;
  trader_id: Generated<string | null>;
  route_obligation_id: Generated<string | null>;
  expected_amount_minor: bigint;
  assigned_at: Generated<Date>;
  released_at: Date | null;
  release_reason: DepositReleaseReason | null;
  created_by: string;
}

// ---- Phase 3 requests, quotes, trades (migrations 0012–0014) ----

export interface RateLimitCounterTable {
  bucket: string;
  window_start: Date;
  hits: number;
}

export type RequestStatus = 'OPEN' | 'QUOTED' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';
export type FixedSideValue = 'BASE' | 'QUOTE';

export interface TradeRequestTable {
  id: Generated<string>;
  ref: Generated<string>;
  client_id: string;
  direction: DirectionValue;
  fixed_side: FixedSideValue;
  requested_base_minor: bigint | null;
  requested_quote_minor: bigint | null;
  target_rate_micro: bigint | null;
  bank_account_id: string | null;
  crypto_wallet_id: string | null;
  source_wallet_id: string | null;
  network: Generated<'TRON'>;
  channel: 'CLIENT_APP' | 'OPERATOR' | 'LINK';
  status: Generated<RequestStatus>;
  status_reason: string | null;
  assigned_dealer_id: string | null;
  created_by: string;
  created_at: Generated<Date>;
  last_activity_at: Generated<Date>;
  closed_at: Date | null;
  version: Generated<number>;
}

export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';
export type QuoteCancelReason = 'SUPERSEDED' | 'DECLINED_BY_DESK' | 'WITHDRAWN' | 'OPERATOR' | 'DISCARDED';

export interface QuoteTable {
  id: Generated<string>;
  ref: Generated<string>;
  trade_request_id: string;
  client_id: string;
  direction: DirectionValue;
  fixed_side: FixedSideValue;
  base_minor: bigint;
  quote_inr_minor: bigint;
  client_rate_micro: bigint;
  route_rate_micro: bigint;
  route_rate_snapshot_id: string;
  route_id: string;
  route_value_inr_minor: bigint;
  gross_margin_inr_minor: bigint;
  network: 'TRON';
  bank_account_id: string | null;
  crypto_wallet_id: string | null;
  /** P2P (ADR 0019): the trader's USDT and the exchange's USDT margin; null through the exchange. */
  route_base_minor: bigint | null;
  gross_margin_base_minor: bigint | null;
  valid_for_seconds: number;
  sent_at: Date | null;
  expires_at: Date | null;
  status: Generated<QuoteStatus>;
  cancel_reason: QuoteCancelReason | null;
  is_counter: boolean;
  negative_margin_reason: string | null;
  created_by: string;
  created_at: Generated<Date>;
  sent_by: string | null;
  accepted_by_user_id: string | null;
  accepted_via: 'APP' | 'LINK' | null;
  acceptance_challenge_id: string | null;
  accepted_at: Date | null;
  rejected_by_user_id: string | null;
  rejected_via: 'APP' | 'LINK' | null;
  rejected_at: Date | null;
  closed_at: Date | null;
}

export interface QuoteLinkTable {
  id: Generated<string>;
  quote_id: string;
  token_hash: string;
  created_by: string;
  created_at: Generated<Date>;
  first_opened_at: Date | null;
  open_count: Generated<number>;
  revoked_at: Date | null;
  revoked_by: string | null;
}

export type ChallengeStatus = 'PENDING' | 'CONSUMED' | 'FAILED' | 'EXPIRED' | 'SUPERSEDED';

export interface AcceptanceChallengeTable {
  id: Generated<string>;
  quote_id: string;
  quote_link_id: string;
  client_user_id: string;
  channel: Generated<'EMAIL'>;
  destination_masked: string;
  code_hash: string;
  code_salt: string;
  expires_at: Date;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  status: Generated<ChallengeStatus>;
  consumed_for: 'ACCEPT' | 'REJECT' | null;
  sent_at: Generated<Date>;
  consumed_at: Date | null;
  closed_at: Date | null;
  ip_hash: string | null;
}

export interface OtpDeliveryTable {
  id: Generated<string>;
  challenge_id: string;
  code_sealed: string | null;
  created_at: Generated<Date>;
  delivered_at: Date | null;
  provider_message_id: string | null;
  erased_reason: 'DELIVERED' | 'CHALLENGE_CLOSED' | null;
}

export type TradeLifecycleState = 'AWAITING_FIRST_LEG' | 'FIRST_LEG_DETECTED' | 'FIRST_LEG_CONFIRMED' | 'SETTLING' | 'PARTIALLY_SETTLED' | 'COMPLETED' | 'CANCELLED';

export interface TradeTable {
  id: Generated<string>;
  ref: Generated<string>;
  quote_id: string;
  trade_request_id: string;
  client_id: string;
  direction: DirectionValue;
  lifecycle_state: TradeLifecycleState;
  hold: Generated<boolean>;
  opened_at: Generated<Date>;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_by: string;
  version: Generated<number>;
}

export interface TradeTransitionTable {
  id: Generated<bigint>;
  trade_id: string;
  from_state: string | null;
  to_state: string;
  command: string;
  actor: string;
  correlation_id: string;
  at: Generated<Date>;
}

export interface TradeEconomicsTable {
  trade_id: string;
  direction: DirectionValue;
  fixed_side: FixedSideValue;
  base_minor: bigint;
  quote_inr_minor: bigint;
  client_rate_micro: bigint;
  route_rate_micro: bigint;
  route_value_inr_minor: bigint;
  gross_margin_inr_minor: bigint;
  route_id: string;
  route_rate_snapshot_id: string;
  route_execution_mode: ExecutionMode;
  /** P2P (ADR 0019): the trader's USDT and the exchange's USDT margin; null through the exchange. */
  route_base_minor: bigint | null;
  gross_margin_base_minor: bigint | null;
  fees_json: Generated<Json>;
  network: 'TRON';
  bank_account_id: string | null;
  crypto_wallet_id: string | null;
  frozen_at: Generated<Date>;
}

export interface RouteObligationTable {
  id: Generated<string>;
  ref: Generated<string>;
  route_id: string;
  trade_id: string | null;
  direction: DirectionValue;
  exchange_delivers_asset: 'USDT' | 'INR';
  exchange_delivers_minor: bigint;
  route_delivers_asset: 'USDT' | 'INR';
  route_delivers_minor: bigint;
  settlement_model: 'PER_TRADE';
  execution_mode: ExecutionMode;
  status: Generated<'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'CANCELLED'>;
  opened_at: Generated<Date>;
  settled_at: Date | null;
  cancelled_at: Date | null;
  created_by: string;
}

export interface TreasuryReservationTable {
  id: Generated<string>;
  treasury_wallet_id: string;
  trade_id: string;
  amount_minor: bigint;
  consumed_minor: Generated<bigint>;
  status: Generated<'ACTIVE' | 'CONSUMED' | 'RELEASED'>;
  released_reason: 'TRADE_CANCELLED' | 'TRADE_COMPLETED' | 'OPERATOR' | null;
  created_by: string;
  created_at: Generated<Date>;
  closed_at: Date | null;
}

export type ExceptionType =
  | 'USDT_WRONG_AMOUNT' | 'USDT_OVERPAYMENT' | 'USDT_UNEXPECTED_SENDER' | 'WRONG_NETWORK' | 'TX_NOT_FINAL'
  | 'ROUTE_DIRECT_PAYOUT_MISMATCH' | 'FUNDS_AFTER_TRADE_CLOSED' | 'UNALLOCATED_DEPOSIT' | 'DEPOSIT_POOL_LOW'
  | 'ROUTE_SETTLEMENT_MISMATCH' | 'ROUTE_OBLIGATION_OVERDUE' | 'DUPLICATE_TX_HASH' | 'DUPLICATE_UTR'
  | 'PARTIAL_INR_PAYOUT' | 'INR_PAYOUT_DELAYED' | 'BANK_TRANSFER_FAILED' | 'CLIENT_BANK_CHANGED'
  | 'ROUTE_CAPACITY_CHANGED' | 'TRADE_CANCELLATION' | 'OPERATOR_MISTAKE' | 'RECONCILIATION_MISMATCH'
  | 'CHAIN_SEND_UNRESOLVED' | 'NETWORK_BUDGET_SHORT' | 'INR_UNEXPECTED_SENDER' | 'P2P_PAYMENT_OVERDUE' | 'P2P_RECEIPT_OVERDUE';

export type ExceptionSubjectType = 'TRADE' | 'SETTLEMENT_LEG' | 'FIAT_TRANSFER' | 'CRYPTO_TRANSFER' | 'DEPOSIT_ADDRESS' | 'ROUTE_OBLIGATION' | 'ROUTE_SETTLEMENT' | 'INR_ACCOUNT' | 'CLIENT' | 'CHAIN_SEND';
export type ExceptionStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'VOID';

export interface ExceptionCaseTable {
  id: Generated<string>;
  ref: Generated<string>;
  trade_id: string | null;
  type: ExceptionType;
  severity: 'BLOCKING' | 'WARNING';
  status: Generated<ExceptionStatus>;
  subject_type: ExceptionSubjectType;
  subject_id: string;
  detected_by: 'SYSTEM' | 'OPERATOR';
  details: Generated<Json>;
  opened_by: string;
  opened_at: Generated<Date>;
  taken_by: string | null;
  taken_at: Date | null;
  resolution_command: string | null;
  resolution_notes: string | null;
  financial_adjustment_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
}

export type LegSide = 'CLIENT_TO_EXCHANGE' | 'EXCHANGE_TO_CLIENT' | 'REFUND_TO_CLIENT';
export type LegStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type LegPayer = 'CLIENT' | 'EXCHANGE_ACCOUNT' | 'ROUTE';
export type AssetCode = 'INR' | 'USDT';

export interface SettlementLegTable {
  id: Generated<string>;
  trade_id: string;
  seq: number;
  ref: Generated<string>;
  side: LegSide;
  asset: AssetCode;
  amount_minor: bigint;
  status: Generated<LegStatus>;
  payer: LegPayer;
  route_id: string | null;
  inr_account_id: string | null;
  capacity_reservation_id: string | null;
  treasury_wallet_id: string | null;
  destination_bank_account_id: string | null;
  destination_wallet_id: string | null;
  /** A pass-through USDT outflow's sending deposit address (migration 0025, D-16). */
  source_deposit_address_id: Generated<string | null>;
  /** Who marked a payout sent and who confirmed it (migration 0027, C1). NULL for legs sent before it. */
  sent_by: Generated<string | null>;
  confirmed_by: Generated<string | null>;
  /** A refund leg's kind (migration 0028, D2): UNWIND before a cancellation, EXCESS for an overpayment. NULL = UNWIND (legacy). */
  refund_kind: Generated<'UNWIND' | 'EXCESS' | null>;
  notes: string | null;
  created_by: string;
  created_at: Generated<Date>;
  sent_at: Date | null;
  confirmed_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  failure_reason: string | null;
}

/** A changed payout destination of an open trade (migration 0028, D1). Append-only; the latest APPROVED is in force. */
export interface TradeDestinationChangeTable {
  id: Generated<string>;
  ref: Generated<string>;
  trade_id: string;
  exception_case_id: string | null;
  from_bank_account_id: string | null;
  from_wallet_id: string | null;
  to_bank_account_id: string | null;
  to_wallet_id: string | null;
  reason: string;
  evidence: string;
  status: Generated<'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>;
  requested_by: string;
  requested_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}

/** The payout second-person threshold (migration 0027, C1). Append-only; the latest row is in force. */
export interface PayoutApprovalPolicyTable {
  id: Generated<string>;
  enabled: boolean;
  threshold_inr_minor: bigint;
  reason: string;
  set_by: string;
  set_at: Generated<Date>;
}

/** A request to grant OWNER, approved by another OWNER in their own session (migration 0027, C2 / TD-20). */
export interface OperatorRoleRequestTable {
  id: Generated<string>;
  ref: Generated<string>;
  target_user_id: string;
  role_code: 'OWNER';
  reason: string;
  status: Generated<'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'>;
  requested_by: string;
  requested_session_id: string;
  requested_at: Generated<Date>;
  expires_at: Date;
  decided_by: string | null;
  decided_session_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  approved_xact: string | null;
}

/** What the chain says an exchange address holds, when and how sure (migration 0026). Append-only. */
export interface CustodyBalanceObservationTable {
  id: Generated<string>;
  network: 'TRON';
  address: string;
  token_contract: string;
  quality: 'AGREED' | 'SINGLE_SOURCE' | 'DISAGREED' | 'ERROR';
  balance_minor: bigint | null;
  solidified_block: bigint | null;
  trx_sun: bigint | null;
  providers: string;
  independent_sources: number;
  detail: string | null;
  observed_by: string;
  observed_at: Generated<Date>;
}

/** Whose money a trade runs on (migration 0025, DECISIONS.md D-16). */
export type FundingModel = 'COUNTERPARTY_FUNDED' | 'LEGACY_EXCHANGE_FUNDED';

export interface TradeFundingTable {
  trade_id: string;
  model: FundingModel;
  created_at: Generated<Date>;
}

export type FundingSourceKind = 'CLIENT_FUNDS' | 'COUNTERPARTY_FUNDS';
export type FundingUseKind = 'CLIENT_PAYOUT' | 'REFUND' | 'ROUTE_PAYMENT' | 'ESCROW_RETURN';
export type FundingAllocationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED';

/** A confirmed incoming movement of a trade and where it is (view, migration 0025). */
export interface FundingSourceView {
  kind: FundingSourceKind;
  source_id: string;
  trade_id: string;
  asset: AssetCode;
  amount_minor: bigint;
  /** `INR:{inr_account_id}` or `TRON:{address}`. */
  location: string;
  confirmed_at: Date | null;
}

/** Part of one funding source earmarked for one outgoing use of the same trade (migration 0025). */
export interface FundingAllocationTable {
  id: Generated<string>;
  trade_id: string;
  source_kind: FundingSourceKind;
  source_leg_id: string | null;
  source_route_settlement_id: string | null;
  use_kind: FundingUseKind;
  use_leg_id: string | null;
  use_route_settlement_id: string | null;
  /** A route payment the signer will make, earmarked when it is planned (migration 0037). */
  use_chain_send_id: Generated<string | null>;
  asset: AssetCode;
  amount_minor: bigint;
  location: string;
  status: Generated<FundingAllocationStatus>;
  created_by: string;
  created_at: Generated<Date>;
  closed_by: string | null;
  closed_at: Date | null;
  close_reason: string | null;
}

export type FiatRail = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';
export type MovementStatus = 'RECORDED' | 'CONFIRMED' | 'FAILED';
export type FiatPayerType = 'CLIENT' | 'EXCHANGE_ACCOUNT' | 'ROUTE';
export type FiatPayeeType = 'CLIENT_BANK' | 'EXCHANGE_ACCOUNT' | 'ROUTE' | 'TRADER';

export interface FiatTransferTable {
  id: Generated<string>;
  rail: FiatRail;
  utr: string;
  amount_minor: bigint;
  payer_type: FiatPayerType;
  payer_id: string;
  payee_type: FiatPayeeType;
  payee_id: string;
  destination_masked: string;
  value_date: string | null;
  status: Generated<MovementStatus>;
  recorded_by: string;
  recorded_at: Generated<Date>;
  confirmed_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  /** ADR 0018: the payer's registered account the rupees are declared to come from (IX118), and who filed it. */
  payer_bank_account_id: string | null;
  filed_by: Generated<FiatFiledBy>;
}

export type FiatFiledBy = 'DESK' | 'CLIENT' | 'TRADER';

/** A BUY trade's payment instructions, fixed at acceptance (migration 0038, IX117). */
export interface TradeCollectionTable {
  trade_id: string;
  inr_account_id: string;
  reference: string;
  pay_by: Date;
  created_at: Generated<Date>;
}

export type SenderVerdict = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN' | 'ACCEPTED';

/** Who the sender of a credit was seen to be, and the verdict against the declared account (migration 0038). */
export interface FiatSenderCheckTable {
  id: Generated<string>;
  fiat_transfer_id: string;
  via: 'STATEMENT' | 'DESK' | 'PAYEE';
  seen_name: string | null;
  seen_account: string | null;
  expected_bank_account_id: string | null;
  verdict: SenderVerdict;
  detail: Generated<Json>;
  statement_line_id: string | null;
  reason: string | null;
  checked_by: string;
  checked_at: Generated<Date>;
}

export type CryptoPayerType = 'CLIENT' | 'EXCHANGE_TREASURY' | 'ROUTE' | 'TRADER' | 'UNKNOWN';
export type CryptoPayeeType = 'CLIENT_WALLET' | 'EXCHANGE_TREASURY' | 'ROUTE' | 'TRADER' | 'UNKNOWN';
export type CryptoTransferState = 'DETECTED' | 'CONFIRMED' | 'FAILED' | 'ORPHANED';

export interface CryptoTransferTable {
  id: Generated<string>;
  network: 'TRON';
  tx_hash: string;
  log_index: number;
  token_contract: string;
  from_address: string;
  to_address: string;
  amount_minor: bigint;
  payer_type: CryptoPayerType;
  payer_id: string | null;
  payee_type: CryptoPayeeType;
  payee_id: string | null;
  block_number: bigint | null;
  block_time: Date | null;
  receipt_status: 'SUCCESS' | 'FAILED' | null;
  solidified_block: bigint | null;
  state: Generated<CryptoTransferState>;
  verified_by: string | null;
  source: 'SCANNER' | 'OPERATOR_SUBMITTED' | 'CLIENT_SUBMITTED' | 'CUSTODY_SIGNER';
  detected_at: Generated<Date>;
  confirmed_at: Date | null;
  failed_at: Date | null;
  created_by: string;
}

export type RouteSettlementFlow = 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE' | 'DIRECT_TO_CLIENT' | 'DIRECT_FROM_CLIENT';

export interface RouteSettlementTable {
  id: Generated<string>;
  ref: Generated<string>;
  route_id: string;
  route_obligation_id: string;
  obligation_side: ObligationSide;
  flow: RouteSettlementFlow;
  asset: AssetCode;
  amount_minor: bigint;
  transfer_kind: TransferKind;
  fiat_transfer_id: string | null;
  crypto_transfer_id: string | null;
  capacity_reservation_id: string | null;
  status: Generated<MovementStatus>;
  created_by: string;
  recorded_at: Generated<Date>;
  confirmed_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  /** Set when this delivery is a trader's Security Reserve applied to it (migration 0029, TD-21). */
  reserve_application_id: Generated<string | null>;
  /** Set when the exchange's signer made this payment (migration 0037). */
  chain_send_id: Generated<string | null>;
}

export type TransferKind = 'FIAT' | 'CRYPTO';
export type AllocationDimension = 'CLIENT' | 'ROUTE';

export interface TransferAllocationTable {
  id: Generated<string>;
  transfer_kind: TransferKind;
  fiat_transfer_id: string | null;
  crypto_transfer_id: string | null;
  dimension: AllocationDimension;
  settlement_leg_id: string | null;
  exception_case_id: string | null;
  route_settlement_id: string | null;
  amount_minor: bigint;
  allocated_by: string;
  created_at: Generated<Date>;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
}

export type ObligationSide = 'ROUTE_DELIVERS' | 'EXCHANGE_DELIVERS';

export interface RouteSettlementAllocationTable {
  id: Generated<string>;
  route_settlement_id: string;
  route_obligation_id: string;
  side: ObligationSide;
  amount_minor: bigint;
  allocated_by: string;
  created_at: Generated<Date>;
}

export type AdjustmentType = 'AMOUNT_CORRECTION' | 'RATE_CORRECTION' | 'FEE' | 'WRITE_OFF' | 'REFUND';

export interface FinancialAdjustmentTable {
  id: Generated<string>;
  ref: Generated<string>;
  trade_id: string;
  type: AdjustmentType;
  delta_base_minor: Generated<bigint>;
  delta_quote_inr_minor: Generated<bigint>;
  delta_route_inr_minor: Generated<bigint>;
  delta_margin_inr_minor: Generated<bigint>;
  reason: string;
  evidence_note: string | null;
  exception_case_id: string | null;
  status: Generated<'REQUESTED' | 'POSTED' | 'REJECTED'>;
  requested_by: string;
  requested_at: Generated<Date>;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  reject_reason: string | null;
  ledger_journal_id: string | null;
}

/** Scanner progress per (network, scanner) — Phase 5, migration 0016. */
export interface ChainCursorTable {
  id: Generated<string>;
  network: 'TRON';
  scanner: string;
  last_scanned_block: bigint;
  last_solidified_block: Generated<bigint>;
  last_run_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  /** What the last run read and could prove (migration 0024). */
  last_window_from: Generated<bigint | null>;
  last_window_to: Generated<bigint | null>;
  last_complete: Generated<boolean | null>;
  last_incomplete_reason: Generated<string | null>;
  last_served_by: Generated<string | null>;
}

/** Each configured chain provider's last answer (migration 0024). Not financial. */
export interface ChainProviderStatusTable {
  network: 'TRON';
  provider: string;
  independence_group: string;
  last_ok_at: Date | null;
  last_error_at: Date | null;
  last_error: string | null;
  consecutive_failures: Generated<number>;
  last_head: bigint | null;
  last_solidified: bigint | null;
  updated_at: Generated<Date>;
}

export type ChainBackfillStatus = 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

/** An audited historical read behind the cursor (TD-06, migration 0024). */
export interface ChainBackfillTable {
  id: Generated<string>;
  ref: Generated<string>;
  network: 'TRON';
  from_block: bigint;
  to_block: bigint;
  addresses: string[];
  reason: string;
  status: Generated<ChainBackfillStatus>;
  next_block: bigint;
  runs: Generated<number>;
  detected: Generated<number>;
  already_known: Generated<number>;
  last_error: string | null;
  last_run_at: Date | null;
  requested_by: string;
  requested_at: Generated<Date>;
  closed_by: string | null;
  closed_at: Date | null;
  close_reason: string | null;
}

/** Client-facing in-app notifications (migration 0017). Written by the outbox handler, read by the client product. */
export type NotificationKind =
  | 'QUOTE_SENT'
  | 'QUOTE_EXPIRED'
  | 'REQUEST_DECLINED'
  | 'TRADE_OPENED'
  | 'PAYOUT_CONFIRMED'
  | 'TRADE_COMPLETED'
  | 'TRADE_CANCELLED'
  | 'DESTINATION_ADDED'
  | 'DESTINATION_ARCHIVED'
  | 'TRADE_DESTINATION_CHANGED'
  | 'TRADER_APPROVED'
  | 'TRADER_REJECTED'
  | 'TRADER_PAUSED'
  | 'TRADER_RESUMED'
  | 'TRADER_ORDER_NEW'
  | 'TRADER_ORDER_ACCEPTED'
  | 'TRADER_ACTION_REQUIRED'
  | 'TRADER_PAYMENT_CONFIRMED'
  | 'TRADER_ORDER_COMPLETED'
  | 'TRADER_ORDER_CLOSED'
  | 'TRADER_RESERVE_ISSUE'
  | 'PAYMENT_RETURNED';

export interface ClientNotificationTable {
  id: Generated<string>;
  client_id: string;
  /** Null addresses the whole client; a user id narrows the notification to one person. */
  user_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  subject_ref: string | null;
  href: string | null;
  outbox_event_id: string;
  read_at: Date | null;
  /** Set once every recipient's email has been accepted by the provider; null until then, or when none was sent (TD-04). */
  email_sent_at: Date | null;
  created_at: Generated<Date>;
}

/** Whether new business is open; append-only, the latest row in force (migration 0033). */
export interface TradingControlTable {
  id: Generated<string>;
  new_business: 'OPEN' | 'PAUSED';
  reason: string;
  set_by: string;
  set_at: Generated<Date>;
}

/** The worker's heartbeat and a non-secret summary of what it runs (migration 0033). */
export interface WorkerHeartbeatTable {
  worker_id: string;
  started_at: Date;
  beat_at: Date;
  release: string | null;
  config: Generated<unknown>;
  /** The cluster and timeline the database was on at this beat (migration 0034, the restore fence). */
  db_identity: Generated<unknown>;
}

/** A receipt artifact written once to private object storage (migration 0032, TD-12). */
export interface ReceiptObjectTable {
  receipt_id: string;
  format: 'json' | 'csv' | 'html' | 'pdf';
  bucket: string;
  object_key: string;
  version_id: string | null;
  /** Of the stored bytes: what a reader verifies. */
  sha256: string;
  /** The issued artifact it is: the recorded json/csv/html hash; for a PDF, the HTML it was printed from. */
  source_sha256: string;
  byte_size: bigint;
  retain_until: Date | null;
  stored_at: Generated<Date>;
}

/** One client notification email to one recipient (migration 0031): its id is the provider idempotency key. */
export interface ClientNotificationEmailTable {
  id: Generated<string>;
  notification_id: string;
  user_id: string;
  address: string;
  status: Generated<'PENDING' | 'SENT' | 'FAILED'>;
  attempts: Generated<number>;
  provider_message_id: string | null;
  last_error: string | null;
  created_at: Generated<Date>;
  sent_at: Date | null;
  failed_at: Date | null;
}

/**
 * A settlement receipt: the immutable snapshot plus the hashes of the artifacts it produces. Every column is
 * immutable; a correction is a new `version`, never an edit (DOMAIN_MODEL §2.8).
 */
export interface ReceiptTable {
  id: Generated<string>;
  trade_id: string;
  version: Generated<number>;
  snapshot_json: Json;
  /** sha256 over the canonical JSON bytes of the snapshot itself. */
  sha256: string;
  json_sha256: string;
  csv_sha256: string;
  html_sha256: string;
  /** Object-store keys. V1 has no object store: artifacts are regenerated from the snapshot and hash-checked. */
  json_key: string | null;
  csv_key: string | null;
  pdf_key: string | null;
  generated_at: Generated<Date>;
  generated_by: string;
}

/**
 * An imported bank statement (SECURITY S7). Evidence, therefore immutable: a corrected statement is a new
 * import of the corrected file, never an edit of this one.
 */
export interface BankStatementImportTable {
  id: Generated<string>;
  inr_account_id: string;
  period_from: string;
  period_to: string;
  filename: string;
  /** sha256 of the uploaded bytes; unique per account so the same file cannot be counted twice. */
  sha256: string;
  line_count: number;
  matched: number;
  mismatched: number;
  unrecorded: number;
  /** Recorded payments in the period the statement does not show at all — the fake-UTR case. */
  missing: number;
  imported_by: string;
  imported_at: Generated<Date>;
}

export type StatementLineOutcome = 'MATCHED' | 'MISMATCHED' | 'UNRECORDED' | 'AMBIGUOUS';

export interface BankStatementLineTable {
  id: Generated<string>;
  import_id: string;
  seq: number;
  value_date: string;
  direction: 'CREDIT' | 'DEBIT';
  amount_minor: bigint;
  reference: string;
  description: string | null;
  outcome: StatementLineOutcome;
  fiat_transfer_id: string | null;
  /** The remitter as the statement shows it (its own columns, or read from the narration). */
  sender_name: string | null;
  sender_account: string | null;
}

// ---- Traders (migration 0022) ----

export type TraderStatus = 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'PAUSED';
/** What an applicant says about their P2P experience (migration 0023). */
export type P2pExperience = 'BINANCE' | 'BYBIT' | 'OTHER' | 'NONE';
/** A trader's side, in the trader's own words: Buy USDT (it has INR) or Sell USDT (it has USDT). */
export type TraderSide = 'BUY_USDT' | 'SELL_USDT';
export type TraderOrderStatus = 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN' | 'RELEASED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface TraderProgramTable {
  id: Generated<number>;
  default_required_reserve_minor: bigint | null;
  reward_bps: number | null;
  offer_ttl_seconds: Generated<number>;
  hold_ttl_seconds: Generated<number>;
  auto_assign: Generated<boolean>;
  collection_account_id: string | null;
  /** ADR 0019: how the programme's routes execute — rupees through the exchange, or P2P between client and trader. */
  execution_mode: Generated<'TO_EXCHANGE' | 'P2P'>;
  updated_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface TraderProfileTable {
  id: Generated<string>;
  ref: Generated<string>;
  client_id: string;
  status: Generated<TraderStatus>;
  offers_buy: boolean;
  offers_sell: boolean;
  typical_inr_minor: bigint | null;
  typical_usdt_minor: bigint | null;
  bank_account_id: string;
  wallet_id: string;
  required_reserve_minor: bigint | null;
  reward_bps: number | null;
  max_order_inr_minor: bigint | null;
  max_order_usdt_minor: bigint | null;
  max_capacity_inr_minor: bigint | null;
  max_capacity_usdt_minor: bigint | null;
  available: Generated<boolean>;
  assignments_enabled: Generated<boolean>;
  control_note: string | null;
  applied_by: string;
  applied_at: Generated<Date>;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
  // The application's own details, and a proposed replacement destination (migration 0023).
  p2p_experience: P2pExperience | null;
  profile_link: string | null;
  telegram_handle: string | null;
  phone_enc: string | null;
  phone_last4: string | null;
  daily_capacity_inr_minor: bigint | null;
  daily_capacity_usdt_minor: bigint | null;
  ownership_confirmed_at: Date | null;
  proposed_bank_account_id: Generated<string | null>;
  proposed_wallet_id: Generated<string | null>;
}

export interface TraderBlockTable {
  id: Generated<string>;
  trader_id: string;
  side: TraderSide;
  route_id: string;
  capacity_minor: Generated<bigint>;
  reserved_minor: Generated<bigint>;
  rate_micro: bigint | null;
  min_order_minor: bigint | null;
  max_order_minor: bigint | null;
  status: Generated<'ACTIVE' | 'PAUSED'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface TraderOrderTable {
  id: Generated<string>;
  ref: Generated<string>;
  trader_id: string;
  block_id: string;
  route_id: string;
  trade_request_id: string;
  side: TraderSide;
  base_minor: bigint;
  inr_minor: bigint;
  rate_micro: bigint;
  capacity_minor: bigint;
  planned_client_rate_micro: bigint | null;
  status: Generated<TraderOrderStatus>;
  offered_by: string;
  offered_at: Generated<Date>;
  offer_expires_at: Date;
  accepted_at: Date | null;
  accepted_by: string | null;
  hold_until: Date | null;
  route_rate_snapshot_id: string | null;
  trade_id: string | null;
  route_obligation_id: string | null;
  quote_id: string | null;
  started_at: Date | null;
  delivered_at: Date | null;
  reward_bps: number | null;
  reward_inr_minor: bigint | null;
  completed_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason: string | null;
  version: Generated<number>;
}

export interface TraderReserveWithdrawalTable {
  id: Generated<string>;
  ref: Generated<string>;
  trader_id: string;
  amount_minor: bigint;
  status: Generated<'REQUESTED' | 'SENT' | 'COMPLETED' | 'REJECTED' | 'CANCELLED'>;
  destination_address: string;
  requested_by: string;
  requested_at: Generated<Date>;
  treasury_wallet_id: string | null;
  crypto_transfer_id: string | null;
  sent_recorded_by: string | null;
  sent_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason: string | null;
}

export type TraderReserveApplicationStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'SENT' | 'COMPLETED' | 'FAILED';

/** A trader's Security Reserve applied to USDT one of its orders did not deliver (migration 0029, TD-21). */
export interface TraderReserveApplicationTable {
  id: Generated<string>;
  ref: Generated<string>;
  trader_id: string;
  trader_order_id: string;
  route_obligation_id: string;
  /** APPLY: the reserve becomes the order's USDT delivery. HOLD: kept back against an INR shortfall, nothing moves. */
  kind: Generated<'APPLY' | 'HOLD'>;
  amount_minor: bigint;
  reason: string;
  status: Generated<TraderReserveApplicationStatus>;
  requested_by: string;
  requested_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  sent_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason: string | null;
}

export interface TraderRewardPayoutTable {
  id: Generated<string>;
  ref: Generated<string>;
  trader_id: string;
  amount_minor: bigint;
  status: Generated<'RECORDED' | 'CONFIRMED' | 'FAILED'>;
  inr_account_id: string;
  fiat_transfer_id: string;
  capacity_reservation_id: string | null;
  destination_bank_account_id: string;
  recorded_by: string;
  recorded_at: Generated<Date>;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
}

// ---- USDT TRC20 rails (migration 0037, ADR 0017) ----

export interface CustodyHdAccountTable {
  provider: string;
  network: 'TRON';
  account_xpub: string;
  deposit_path_prefix: string;
  fee_wallet_path: string;
  fee_wallet_address: string;
  recorded_by: string;
  recorded_at: Generated<Date>;
}

export interface NetworkFeePolicyTable {
  id: Generated<string>;
  quote_energy: number;
  reserve_energy: number;
  bandwidth_buffer_sun: bigint;
  topup_bytes: number;
  topup_buffer_bps: number;
  price_buffer_bps: number;
  refund_sends_sell: number;
  min_net_margin_inr_minor: bigint;
  max_snapshot_age_seconds: number;
  max_trx_rate_age_seconds: number;
  auto_send_enabled: boolean;
  reason: string;
  set_by: string;
  set_at: Generated<Date>;
}

export interface NetworkFeeSnapshotTable {
  id: Generated<string>;
  network: Generated<'TRON'>;
  energy_price_sun: bigint;
  bandwidth_price_sun: bigint;
  create_account_fee_sun: bigint;
  create_new_account_fee_sun: bigint;
  free_net_limit: number;
  providers: string;
  observed_by: string;
  observed_at: Generated<Date>;
}

export interface NetworkTrxRateTable {
  id: Generated<string>;
  usdt_per_trx_micro: bigint;
  source: string;
  published_by: string;
  effective_at: Generated<Date>;
}

export interface QuoteNetworkFeeTable {
  quote_id: string;
  funder_trader_id: string | null;
  snapshot_id: string;
  trx_rate_id: string;
  usdt_per_trx_micro: bigint;
  energy_price_sun: bigint;
  sends_priced: number;
  fee_sun: bigint;
  fee_inr_minor: bigint;
  /** The trader order the quote prices and the reward it counted (IX113): the order starts with exactly these. */
  trader_order_id: string | null;
  reward_bps: number | null;
  reward_inr_minor: bigint;
  net_margin_inr_minor: bigint;
  reserve_sends: number;
  reserve_sun: bigint;
  min_net_margin_inr_minor: bigint;
  /** P2P (ADR 0019): the fee, the net margin and the minimum, in USDT; null through the exchange. */
  fee_usdt_minor: bigint | null;
  net_margin_usdt_minor: bigint | null;
  min_net_margin_usdt_minor: bigint | null;
  created_at: Generated<Date>;
}

export type NetworkBudgetEntryKind = 'DEPOSIT' | 'WITHDRAWAL' | 'SPENT' | 'ADJUSTMENT';

export interface NetworkBudgetEntryTable {
  id: Generated<string>;
  /** The funder: a trader's network deposit, or the platform's budget (null). */
  trader_id: string | null;
  kind: NetworkBudgetEntryKind;
  amount_sun: bigint;
  trade_id: string | null;
  chain_send_attempt_id: string | null;
  withdrawal_id: string | null;
  tx_hash: string | null;
  from_address: string | null;
  posting_key: string;
  note: string | null;
  created_by: string;
  created_at: Generated<Date>;
}

export interface NetworkBudgetHoldTable {
  id: Generated<string>;
  trade_id: string;
  trader_id: string | null;
  amount_sun: bigint;
  sends: number;
  per_send_sun: bigint;
  snapshot_id: string;
  status: Generated<'ACTIVE' | 'CLOSED'>;
  created_at: Generated<Date>;
  closed_at: Date | null;
  close_reason: string | null;
  spent_sun: bigint | null;
  reimbursed_sun: bigint | null;
  reimbursed_inr_minor: bigint | null;
}

export type NetworkWithdrawalStatus = 'REQUESTED' | 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';

export interface NetworkDepositWithdrawalTable {
  id: Generated<string>;
  ref: Generated<string>;
  trader_id: string;
  amount_sun: bigint;
  fee_estimate_sun: bigint;
  to_address: string;
  status: Generated<NetworkWithdrawalStatus>;
  requested_by: string;
  requested_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
}

export type ChainSendPurpose = 'CLIENT_PAYOUT' | 'REFUND' | 'ROUTE_PAYMENT' | 'ESCROW_RETURN' | 'TOPUP' | 'DEPOSIT_WITHDRAWAL';
export type ChainSendStatus = 'AWAITING_APPROVAL' | 'PLANNED' | 'AWAITING_RESOURCES' | 'BLOCKED' | 'SENDING' | 'CONFIRMED' | 'CANCELLED';
export type ChainSendBearer = 'CLIENT' | 'TRADER' | 'PLATFORM';

export interface ChainSendTable {
  id: Generated<string>;
  ref: Generated<string>;
  network: Generated<'TRON'>;
  asset: 'USDT' | 'TRX';
  purpose: ChainSendPurpose;
  trade_id: string | null;
  settlement_leg_id: string | null;
  route_obligation_id: string | null;
  parent_send_id: string | null;
  withdrawal_id: string | null;
  from_address: string;
  from_path: string;
  to_address: string;
  amount_minor: bigint;
  fee_estimate_sun: Generated<bigint>;
  /** A USDT send's fixed TRX cap (IX114/IX115); null for a TRX send. */
  network_cap_sun: bigint | null;
  funder_trader_id: string | null;
  bearer: ChainSendBearer;
  status: ChainSendStatus;
  needs_approval: boolean;
  requested_by: string;
  approved_by: string | null;
  approved_at: Date | null;
  blocked_reason: string | null;
  last_error: string | null;
  last_error_at: Date | null;
  failed_attempts: Generated<number>;
  crypto_transfer_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  closed_at: Date | null;
  close_reason: string | null;
}

export type ChainSendAttemptStatus = 'SIGNED' | 'BROADCAST' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';

export interface ChainSendAttemptTable {
  id: Generated<string>;
  send_id: string;
  seq: number;
  txid: string;
  raw_data_hex: string;
  signature_hex: string;
  ref_block_num: bigint;
  expiration: Date;
  fee_limit_sun: bigint | null;
  status: Generated<ChainSendAttemptStatus>;
  broadcasts: Generated<number>;
  last_broadcast_at: Date | null;
  last_broadcast_result: string | null;
  block_number: bigint | null;
  block_time: Date | null;
  fee_sun: bigint | null;
  energy_used: bigint | null;
  energy_fee_sun: bigint | null;
  net_fee_sun: bigint | null;
  result: string | null;
  signed_at: Generated<Date>;
  decided_at: Date | null;
  decided_by: string | null;
}

export interface Database {
  currency: CurrencyTable;
  custody_hd_account: CustodyHdAccountTable;
  network_fee_policy: NetworkFeePolicyTable;
  network_fee_snapshot: NetworkFeeSnapshotTable;
  network_trx_rate: NetworkTrxRateTable;
  quote_network_fee: QuoteNetworkFeeTable;
  network_budget_entry: NetworkBudgetEntryTable;
  network_budget_hold: NetworkBudgetHoldTable;
  network_deposit_withdrawal: NetworkDepositWithdrawalTable;
  chain_send: ChainSendTable;
  chain_send_attempt: ChainSendAttemptTable;
  idempotency_key: IdempotencyKeyTable;
  audit_event: AuditEventTable;
  audit_seal: AuditSealTable;
  audit_seal_export: AuditSealExportTable;
  audit_archive_verification: AuditArchiveVerificationTable;
  backup_verification: BackupVerificationTable;
  restore_fence: RestoreFenceTable;
  restore_fence_lift: RestoreFenceLiftTable;
  ledger_account: LedgerAccountTable;
  ledger_journal: LedgerJournalTable;
  ledger_entry: LedgerEntryTable;
  ledger_account_balance: LedgerAccountBalanceView;
  ledger_global_imbalance: LedgerGlobalImbalanceView;
  outbox_event: OutboxEventTable;
  outbox_delivery: OutboxDeliveryTable;
  auth_user: AuthUserTable;
  auth_session: AuthSessionTable;
  operator_user_role: OperatorUserRoleTable;
  operator_permission_grant: OperatorPermissionGrantTable;
  step_up_verification: StepUpVerificationTable;
  session_activity: SessionActivityTable;
  client: ClientTable;
  client_contact: ClientContactTable;
  client_user: ClientUserTable;
  bank_account: BankAccountTable;
  crypto_wallet: CryptoWalletTable;
  settlement_entity: SettlementEntityTable;
  inr_settlement_account: InrSettlementAccountTable;
  inr_account_day: InrAccountDayTable;
  capacity_reservation: CapacityReservationTable;
  liquidity_route: LiquidityRouteTable;
  rate_snapshot: RateSnapshotTable;
  treasury_wallet: TreasuryWalletTable;
  custody_provider_config: CustodyProviderConfigTable;
  deposit_address: DepositAddressTable;
  deposit_assignment: DepositAssignmentTable;
  rate_limit_counter: RateLimitCounterTable;
  trade_request: TradeRequestTable;
  quote: QuoteTable;
  quote_link: QuoteLinkTable;
  acceptance_challenge: AcceptanceChallengeTable;
  otp_delivery: OtpDeliveryTable;
  trade: TradeTable;
  trade_transition: TradeTransitionTable;
  trade_economics: TradeEconomicsTable;
  route_obligation: RouteObligationTable;
  treasury_reservation: TreasuryReservationTable;
  exception_case: ExceptionCaseTable;
  settlement_leg: SettlementLegTable;
  trade_funding: TradeFundingTable;
  funding_source: FundingSourceView;
  funding_allocation: FundingAllocationTable;
  custody_balance_observation: CustodyBalanceObservationTable;
  payout_approval_policy: PayoutApprovalPolicyTable;
  trade_destination_change: TradeDestinationChangeTable;
  operator_role_request: OperatorRoleRequestTable;
  fiat_transfer: FiatTransferTable;
  trade_collection: TradeCollectionTable;
  fiat_sender_check: FiatSenderCheckTable;
  crypto_transfer: CryptoTransferTable;
  route_settlement: RouteSettlementTable;
  transfer_allocation: TransferAllocationTable;
  route_settlement_allocation: RouteSettlementAllocationTable;
  financial_adjustment: FinancialAdjustmentTable;
  chain_cursor: ChainCursorTable;
  chain_provider_status: ChainProviderStatusTable;
  chain_backfill: ChainBackfillTable;
  client_notification: ClientNotificationTable;
  client_notification_email: ClientNotificationEmailTable;
  receipt_object: ReceiptObjectTable;
  trading_control: TradingControlTable;
  worker_heartbeat: WorkerHeartbeatTable;
  receipt: ReceiptTable;
  bank_statement_import: BankStatementImportTable;
  bank_statement_line: BankStatementLineTable;
  trader_program: TraderProgramTable;
  trader_profile: TraderProfileTable;
  trader_block: TraderBlockTable;
  trader_order: TraderOrderTable;
  trader_reserve_withdrawal: TraderReserveWithdrawalTable;
  trader_reserve_application: TraderReserveApplicationTable;
  trader_reward_payout: TraderRewardPayoutTable;
}
