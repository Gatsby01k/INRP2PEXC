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
  status: Generated<'ACTIVE' | 'ARCHIVED'>;
  verified_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  archived_by: string | null;
  archived_at: Date | null;
  archive_reason: string | null;
}

export interface CryptoWalletTable {
  id: Generated<string>;
  client_id: string;
  network: 'TRON';
  address: string;
  label: string;
  purpose: 'SOURCE' | 'DESTINATION' | 'BOTH';
  status: Generated<'ACTIVE' | 'ARCHIVED'>;
  created_by: string;
  created_at: Generated<Date>;
  archived_by: string | null;
  archived_at: Date | null;
  archive_reason: string | null;
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
export type ReservationReleaseReason = 'TRADE_CANCELLED' | 'LEG_CANCELLED' | 'LEG_FAILED' | 'TRADE_COMPLETED' | 'ROUTE_SETTLEMENT_FAILED' | 'DAY_ROLLOVER' | 'OPERATOR';

export interface CapacityReservationTable {
  id: Generated<string>;
  purpose: 'CLIENT_PAYOUT' | 'ROUTE_SETTLEMENT';
  trade_id: string | null;
  route_settlement_id: string | null;
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
export type ExecutionMode = 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE';

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
  role: 'HOT' | 'COLD' | 'DEPOSIT_POOL';
  status: Generated<'ACTIVE' | 'PAUSED' | 'RETIRED'>;
  custody: Generated<'EXTERNAL'>;
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

export interface DepositAssignmentTable {
  id: Generated<string>;
  deposit_address_id: string;
  trade_id: string;
  expected_amount_minor: bigint;
  assigned_at: Generated<Date>;
  released_at: Date | null;
  release_reason: 'TRADE_COMPLETED' | 'TRADE_CANCELLED' | null;
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
  | 'ROUTE_CAPACITY_CHANGED' | 'TRADE_CANCELLATION' | 'OPERATOR_MISTAKE' | 'RECONCILIATION_MISMATCH';

export type ExceptionSubjectType = 'TRADE' | 'SETTLEMENT_LEG' | 'FIAT_TRANSFER' | 'CRYPTO_TRANSFER' | 'DEPOSIT_ADDRESS' | 'ROUTE_OBLIGATION' | 'ROUTE_SETTLEMENT' | 'INR_ACCOUNT' | 'CLIENT';
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
  notes: string | null;
  created_by: string;
  created_at: Generated<Date>;
  sent_at: Date | null;
  confirmed_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  failure_reason: string | null;
}

export type FiatRail = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';
export type MovementStatus = 'RECORDED' | 'CONFIRMED' | 'FAILED';
export type FiatPayerType = 'CLIENT' | 'EXCHANGE_ACCOUNT' | 'ROUTE';
export type FiatPayeeType = 'CLIENT_BANK' | 'EXCHANGE_ACCOUNT' | 'ROUTE';

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
}

export type CryptoPayerType = 'CLIENT' | 'EXCHANGE_TREASURY' | 'ROUTE' | 'UNKNOWN';
export type CryptoPayeeType = 'CLIENT_WALLET' | 'EXCHANGE_TREASURY' | 'ROUTE' | 'UNKNOWN';
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
  source: 'SCANNER' | 'OPERATOR_SUBMITTED';
  detected_at: Generated<Date>;
  confirmed_at: Date | null;
  failed_at: Date | null;
  created_by: string;
}

export type RouteSettlementFlow = 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE' | 'DIRECT_TO_CLIENT';

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
  | 'DESTINATION_ARCHIVED';

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
  /** Set when the same message also went out by email; null when it did not (TD-04). */
  email_sent_at: Date | null;
  created_at: Generated<Date>;
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

export type StatementLineOutcome = 'MATCHED' | 'MISMATCHED' | 'UNRECORDED';

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
}

export interface Database {
  currency: CurrencyTable;
  idempotency_key: IdempotencyKeyTable;
  audit_event: AuditEventTable;
  audit_seal: AuditSealTable;
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
  fiat_transfer: FiatTransferTable;
  crypto_transfer: CryptoTransferTable;
  route_settlement: RouteSettlementTable;
  transfer_allocation: TransferAllocationTable;
  route_settlement_allocation: RouteSettlementAllocationTable;
  financial_adjustment: FinancialAdjustmentTable;
  chain_cursor: ChainCursorTable;
  client_notification: ClientNotificationTable;
  receipt: ReceiptTable;
  bank_statement_import: BankStatementImportTable;
  bank_statement_line: BankStatementLineTable;
}
