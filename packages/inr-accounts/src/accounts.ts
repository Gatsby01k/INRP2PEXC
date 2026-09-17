import { sql } from 'kysely';
import { DomainError, Money, last4, normalizeIfsc, normalizeIndianAccountNumber, optionalText, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type InrAccountStatus, type Rail, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { FieldProtector } from '@inrp2p/adapters';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';

const RAILS = ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const;
export const inrAccountSealContext = (entityId: string) => `inr_settlement_account.account_number:${entityId}`;
export const INR_ACCOUNT_HMAC_CONTEXT = 'inr_settlement_account.account_number';

/** `settlement_entity.create` — `inr_account:manage` (⧗). */
export function createSettlementEntity(actor: OperatorActor) {
  return operatorCommand(actor, 'inr_account:manage', async (ctx, p: { legalName: string; shortName: string }) => {
    let row;
    try {
      row = await ctx.tx
        .insertInto('settlement_entity')
        .values({ legal_name: requireText(p.legalName, 'legalName', 200), short_name: requireText(p.shortName, 'shortName', 60), created_by: actorLabel(ctx) })
        .returning(['id', 'legal_name', 'short_name', 'status'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('INVALID_ARGUMENT', 'short name already in use');
      throw e;
    }
    await appendAudit(ctx, { action: 'settlement_entity.created', entityType: 'settlement_entity', entityId: row.id, after: row });
    return { entityId: row.id };
  });
}

export interface CreateInrAccountPayload {
  readonly entityId: string;
  readonly label: string;
  readonly bankName: string;
  readonly ifsc: string;
  readonly accountNumber: string;
  readonly rails: readonly Rail[];
  readonly direction: 'PAYOUT' | 'COLLECTION' | 'BOTH';
  /** Decimal INR, e.g. "10000000.00". */
  readonly defaultDailyCapacity: string;
  readonly notes?: string | null;
}

function nonNegativeInr(value: string, field: string): Money<'INR'> {
  const m = Money.parse(value, 'INR');
  if (m.isNegative()) throw new DomainError('INVALID_AMOUNT', `${field} must not be negative`);
  return m;
}

/** `inr_account.create` — `inr_account:manage` (⧗). The account number is envelope-encrypted; duplicates are detected by keyed HMAC. */
export function createInrAccount(actor: OperatorActor, protector: FieldProtector) {
  return operatorCommand(actor, 'inr_account:manage', async (ctx, p: CreateInrAccountPayload) => {
    const entity = await ctx.tx.selectFrom('settlement_entity').select(['id', 'status']).where('id', '=', requireUuid(p.entityId, 'entityId')).forShare().executeTakeFirst();
    if (!entity) throw new DomainError('NOT_FOUND', 'settlement entity not found');
    if (entity.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'settlement entity is inactive');
    const accountNumber = normalizeIndianAccountNumber(p.accountNumber);
    const rails = [...new Set((p.rails ?? []).map((r) => requireOneOf(r, 'rails', RAILS)))];
    if (rails.length === 0) throw new DomainError('INVALID_ARGUMENT', 'at least one rail is required');
    const capacity = nonNegativeInr(p.defaultDailyCapacity, 'defaultDailyCapacity');
    let row;
    try {
      row = await ctx.tx
        .insertInto('inr_settlement_account')
        .values({
          entity_id: entity.id,
          label: requireText(p.label, 'label', 80),
          bank_name: requireText(p.bankName, 'bankName', 140),
          ifsc: normalizeIfsc(p.ifsc),
          account_number_enc: await protector.seal(accountNumber, inrAccountSealContext(entity.id)),
          account_last4: last4(accountNumber),
          account_hmac: protector.lookupHash(accountNumber, INR_ACCOUNT_HMAC_CONTEXT),
          rails,
          direction: requireOneOf(p.direction, 'direction', ['PAYOUT', 'COLLECTION', 'BOTH'] as const),
          default_daily_capacity_minor: capacity.minor,
          notes: optionalText(p.notes, 'notes'),
          created_by: actorLabel(ctx),
        })
        .returning(['id', 'entity_id', 'label', 'bank_name', 'ifsc', 'account_last4', 'rails', 'direction', 'status', 'default_daily_capacity_minor'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e, 'inr_settlement_account_account_hmac_key')) throw new DomainError('DUPLICATE_DESTINATION', 'this bank account is already registered');
      if (isUniqueViolation(e)) throw new DomainError('INVALID_ARGUMENT', 'label already in use');
      throw e;
    }
    await appendAudit(ctx, { action: 'settlement_account.created', entityType: 'inr_settlement_account', entityId: row.id, after: row });
    return { accountId: row.id };
  });
}

/** `inr_account.set_status` — `inr_account:manage` (⧗). PAUSED/UNAVAILABLE accounts accept no new reservations (FI-32). */
export function setInrAccountStatus(actor: OperatorActor) {
  return operatorCommand(actor, 'inr_account:manage', async (ctx, p: { accountId: string; status: InrAccountStatus; reason: string }) => {
    const status = requireOneOf(p.status, 'status', ['ACTIVE', 'PAUSED', 'UNAVAILABLE'] as const);
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('inr_settlement_account').select(['id', 'status', 'version']).where('id', '=', requireUuid(p.accountId, 'accountId')).forUpdate().executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', 'INR account not found');
    if (before.status === status) return { changed: false };
    await ctx.tx.updateTable('inr_settlement_account').set({ status, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'settlement_account.status_changed', entityType: 'inr_settlement_account', entityId: before.id, before: { status: before.status }, after: { status, reason } });
    return { changed: true };
  });
}
