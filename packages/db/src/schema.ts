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
}
