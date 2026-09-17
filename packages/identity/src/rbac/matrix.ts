/**
 * Operator RBAC matrix — the executable form of SECURITY.md §3. A unit test parses the table in
 * SECURITY.md and asserts it is identical to this matrix, so the two cannot drift.
 */
export const OPERATOR_ROLES = ['OWNER', 'DEALER', 'SETTLEMENT_OPERATOR', 'FINANCE', 'SUPPORT', 'READ_ONLY'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** ALLOW ✔ · STEP_UP ⧗ · STEP_UP_SECOND_APPROVER ⧗✱ · DENY — */
export type Requirement = 'ALLOW' | 'STEP_UP' | 'STEP_UP_SECOND_APPROVER' | 'DENY';

type Row = Readonly<Record<OperatorRole, Requirement>>;

const A: Requirement = 'ALLOW';
const S: Requirement = 'STEP_UP';
const S2: Requirement = 'STEP_UP_SECOND_APPROVER';
const D: Requirement = 'DENY';

//                                  OWNER DEALER SETTLE FINANCE SUPPORT READ_ONLY
const r = (o: Requirement, d: Requirement, s: Requirement, f: Requirement, su: Requirement, ro: Requirement): Row =>
  Object.freeze({ OWNER: o, DEALER: d, SETTLEMENT_OPERATOR: s, FINANCE: f, SUPPORT: su, READ_ONLY: ro });

export const PERMISSION_MATRIX = Object.freeze({
  'desk:view': r(A, A, A, A, A, A),
  'economics:view': r(A, A, D, A, D, D),
  'rates:update_route': r(A, A, D, D, D, D),
  'request:create': r(A, A, D, D, A, D),
  'request:decline': r(A, A, D, D, D, D),
  'quote:create': r(A, A, D, D, D, D),
  'quote:send': r(A, A, D, D, D, D),
  'quote:cancel': r(A, A, D, D, D, D),
  'quote:send_negative_margin': r(S, D, D, D, D, D),
  'quote_link:create': r(A, A, D, D, D, D),
  'quote_link:revoke': r(A, A, D, D, D, D),
  'settlement:reserve_capacity': r(A, D, A, D, D, D),
  'settlement:create_payout': r(A, D, A, D, D, D),
  'settlement:send_payout': r(A, D, A, D, D, D),
  'settlement:record_utr': r(A, D, A, D, D, D),
  'settlement:record_route_payout_sent': r(A, D, A, D, D, D),
  'settlement:change_utr': r(S, D, S, D, D, D),
  'settlement:confirm_payout': r(S, D, S, D, D, D),
  'settlement:confirm_incoming': r(S, D, S, D, D, D),
  'settlement:fail_payout': r(S, D, S, D, D, D),
  'settlement:cancel_payout': r(S, D, S, D, D, D),
  'crypto:submit_tx_for_verification': r(A, D, A, A, D, D),
  'trade:cancel': r(S, S, D, D, D, D),
  'exception:open': r(A, A, A, A, A, D),
  'exception:resolve': r(A, A, A, A, D, D),
  'adjustment:request': r(A, A, A, A, D, D),
  'adjustment:approve': r(S2, D, D, S2, D, D),
  'refund:approve': r(S2, D, D, S2, D, D),
  'inr_account:manage': r(S, D, D, S, D, D),
  'capacity:change': r(S, D, D, S, D, D),
  'treasury:manage_wallets': r(S, D, D, S, D, D),
  'client:manage': r(A, A, D, D, A, D),
  'client:manage_contacts': r(A, A, D, D, A, D),
  'client_bank:add': r(S, D, D, D, S, D),
  'client_user:grant_accept_quotes': r(S, D, D, D, S, D),
  'routes:configure': r(S, D, D, D, D, D),
  'route_settlement:record': r(A, D, D, A, D, D),
  'route_settlement:confirm': r(S, D, D, S, D, D),
  'route_settlement:allocate': r(S, D, D, S, D, D),
  'route_positions:view': r(A, A, D, A, D, D),
  'custody:configure': r(S, D, D, S, D, D),
  'bank_account:reveal': r(S, D, S, S, D, D),
  'ledger:view': r(A, D, D, A, D, D),
  'pnl:view': r(A, A, D, A, D, D),
  'ledger:export': r(A, D, D, A, D, D),
  'receipt:view': r(A, A, A, A, A, A),
  'audit:view': r(A, D, D, A, D, D),
  'users:manage': r(S, D, D, D, D, D),
  'roles:assign': r(S, D, D, D, D, D),
} as const satisfies Record<string, Row>);

export type Permission = keyof typeof PERMISSION_MATRIX;
export const PERMISSIONS = Object.freeze(Object.keys(PERMISSION_MATRIX) as Permission[]);

/** Permissions that may be granted individually to a role that is otherwise denied (SECURITY §3 "grantable"). */
export const GRANTABLE: Readonly<Partial<Record<Permission, readonly OperatorRole[]>>> = Object.freeze({
  'economics:view': Object.freeze(['READ_ONLY'] as const),
});

/** Step-up freshness window (SECURITY §2.1). */
export const STEP_UP_MAX_AGE_SECONDS = 600;

const RANK: Record<Requirement, number> = { ALLOW: 3, STEP_UP: 2, STEP_UP_SECOND_APPROVER: 1, DENY: 0 };

/** Most permissive requirement across a user's roles and individual grants. */
export function effectiveRequirement(permission: Permission, roles: readonly OperatorRole[], grants: readonly string[] = []): Requirement {
  let best: Requirement = 'DENY';
  for (const role of roles) {
    const req = PERMISSION_MATRIX[permission][role];
    if (RANK[req] > RANK[best]) best = req;
  }
  if (best === 'DENY' && grants.includes(permission)) {
    const allowedRoles = GRANTABLE[permission] ?? [];
    if (roles.some((role) => allowedRoles.includes(role))) best = 'ALLOW';
  }
  return best;
}
