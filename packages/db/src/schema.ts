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
}
