import { sql } from 'kysely';
import { DomainError, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { ExceptionSubjectType, ExceptionType, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';

/** Exceptions that stop a trade from progressing (DOMAIN_MODEL §3, "Blocking" column). */
export const BLOCKING_TYPES: readonly ExceptionType[] = Object.freeze([
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'ROUTE_DIRECT_PAYOUT_MISMATCH',
  'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'ROUTE_SETTLEMENT_MISMATCH', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
]);

export const severityOf = (type: ExceptionType): 'BLOCKING' | 'WARNING' => (BLOCKING_TYPES.includes(type) ? 'BLOCKING' : 'WARNING');

export interface OpenExceptionInput {
  readonly type: ExceptionType;
  readonly subjectType: ExceptionSubjectType;
  readonly subjectId: string;
  readonly tradeId?: string | null;
  readonly detectedBy?: 'SYSTEM' | 'OPERATOR';
  readonly details?: Record<string, unknown>;
}

/**
 * Recomputes `trade.hold` from the open blocking cases (H1/H2). The caller holds the trade row lock (every
 * command that can open or resolve a case starts by locking its trade); the database re-checks `hold` at commit.
 */
export async function syncTradeHold(ctx: TxContext, tradeId: string): Promise<boolean> {
  const trade = await ctx.tx.selectFrom('trade').select(['id', 'hold', 'version']).where('id', '=', tradeId).executeTakeFirstOrThrow();
  const r = await sql<{ blocked: boolean }>`
    select exists (
      select 1 from exception_case
      where trade_id = ${tradeId} and severity = 'BLOCKING' and status in ('OPEN', 'IN_PROGRESS')
    ) as blocked`.execute(ctx.tx);
  const hold = r.rows[0]!.blocked;
  if (hold !== trade.hold) {
    await ctx.tx.updateTable('trade').set({ hold, version: trade.version + 1 }).where('id', '=', trade.id).execute();
  }
  return hold;
}

/**
 * Opens an exception case, or returns the existing open one for the same (type, subject) — detection runs
 * repeatedly and must not create duplicates (unique partial index). Blocking cases put the trade on hold.
 */
export async function openExceptionInTx(ctx: TxContext, input: OpenExceptionInput): Promise<{ exceptionId: string; ref: string; opened: boolean }> {
  const subjectId = requireUuid(input.subjectId, 'subjectId');
  const existing = await ctx.tx
    .selectFrom('exception_case')
    .select(['id', 'ref'])
    .where('type', '=', input.type)
    .where('subject_type', '=', input.subjectType)
    .where('subject_id', '=', subjectId)
    .where('status', 'in', ['OPEN', 'IN_PROGRESS'])
    .executeTakeFirst();
  if (existing) return { exceptionId: existing.id, ref: existing.ref, opened: false };

  const severity = severityOf(input.type);
  const row = await ctx.tx
    .insertInto('exception_case')
    .values({
      trade_id: input.tradeId ?? null,
      type: input.type,
      severity,
      subject_type: input.subjectType,
      subject_id: subjectId,
      detected_by: input.detectedBy ?? 'SYSTEM',
      details: JSON.stringify(input.details ?? {}),
      opened_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  if (input.tradeId && severity === 'BLOCKING') await syncTradeHold(ctx, input.tradeId);
  await appendAudit(ctx, {
    action: 'exception.opened', entityType: 'exception_case', entityId: row.id,
    after: { ref: row.ref, type: input.type, severity, subject_type: input.subjectType, subject_id: subjectId, trade_id: input.tradeId ?? null, details: input.details ?? {} },
  });
  await enqueueOutbox(ctx, { type: 'desk.exception_opened', aggregateType: 'exception_case', aggregateId: row.id, payload: { exceptionId: row.id, ref: row.ref, type: input.type, severity, tradeId: input.tradeId ?? null } });
  return { exceptionId: row.id, ref: row.ref, opened: true };
}

/** `exception.open` — `exception:open`. Operators open cases the system cannot detect (e.g. WRONG_NETWORK). */
export function openException(actor: OperatorActor) {
  return operatorCommand(actor, 'exception:open', async (ctx, p: OpenExceptionInput & { notes?: string }) => {
    const type = requireOneOf(p.type, 'type', EXCEPTION_TYPES);
    const out = await openExceptionInTx(ctx, { ...p, type, detectedBy: 'OPERATOR', details: { ...(p.details ?? {}), ...(p.notes ? { notes: requireText(p.notes, 'notes', 2000) } : {}) } });
    return out;
  });
}

/** `exception.take` — `exception:resolve`. Claims the case so two operators do not work the same one. */
export function takeException(actor: OperatorActor) {
  return operatorCommand(actor, 'exception:resolve', async (ctx, p: { exceptionId: string }) => {
    const c = await lockException(ctx, p.exceptionId);
    if (c.status !== 'OPEN') throw new DomainError('INVALID_TRANSITION', `exception is ${c.status}`);
    await ctx.tx.updateTable('exception_case').set({ status: 'IN_PROGRESS', taken_by: ctx.actor.id ?? 'SYSTEM', taken_at: sql<Date>`inrp2p_now()` }).where('id', '=', c.id).execute();
    await appendAudit(ctx, { action: 'exception.taken', entityType: 'exception_case', entityId: c.id, before: { status: c.status }, after: { status: 'IN_PROGRESS' } });
    return { status: 'IN_PROGRESS' as const };
  });
}

/** Resolution commands an operator may record directly; money-moving resolutions run their own command first. */
export const NON_FINANCIAL_RESOLUTIONS = Object.freeze([
  'accept_sender', 'await_top_up', 'record_recovery_outcome', 'hold_in_suspense', 'attach_evidence_and_void',
  'confirm_new_destination', 'keep_original', 'reallocate_reservations', 'create_remaining_leg', 'create_replacement_leg',
  'record_correct_route', 'record_route_settlement', 'correct_utr', 'escalate',
] as const);

export type ResolutionCommand = (typeof NON_FINANCIAL_RESOLUTIONS)[number] | 'financial_adjustment' | 'refund_and_cancel' | 'cancel_trade' | 'reclassify_payer' | 'refund_excess' | 'adjust_trade_to_received' | 'requote_for_same_client' | 'refund' | 'reallocate' | 'mark_failed' | 'confirm' | 'replenish_pool';

async function lockException(ctx: TxContext, exceptionId: string) {
  const id = requireUuid(exceptionId, 'exceptionId');
  const rows = await sql<{ id: string; status: string; severity: string; trade_id: string | null; type: ExceptionType }>`
    select id, status, severity, trade_id, type from exception_case where id = ${id} for update`.execute(ctx.tx);
  const c = rows.rows[0];
  if (!c) throw new DomainError('NOT_FOUND', 'exception case not found');
  return c;
}

/**
 * Resolves a case, recording which command resolved it (DOMAIN_MODEL §3). Resolutions that move money are
 * performed by their own command, which passes its id here; this command never posts a journal itself.
 */
export async function resolveExceptionInTx(
  ctx: TxContext,
  input: { exceptionId: string; resolution: ResolutionCommand; notes: string; financialAdjustmentId?: string | null },
): Promise<{ status: 'RESOLVED' }> {
  const c = await lockException(ctx, input.exceptionId);
  if (c.status !== 'OPEN' && c.status !== 'IN_PROGRESS') throw new DomainError('INVALID_TRANSITION', `exception is ${c.status}`);
  const notes = requireText(input.notes, 'notes', 2000);
  await ctx.tx
    .updateTable('exception_case')
    .set({
      status: 'RESOLVED',
      resolution_command: input.resolution,
      resolution_notes: notes,
      financial_adjustment_id: input.financialAdjustmentId ?? null,
      resolved_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
      resolved_at: sql<Date>`inrp2p_now()`,
    })
    .where('id', '=', c.id)
    .execute();
  if (c.trade_id) await syncTradeHold(ctx, c.trade_id);
  await appendAudit(ctx, { action: 'exception.resolved', entityType: 'exception_case', entityId: c.id, before: { status: c.status }, after: { status: 'RESOLVED', resolution: input.resolution, notes } });
  return { status: 'RESOLVED' };
}

/** `exception.resolve` — `exception:resolve`, for the resolutions that do not move money. */
export function resolveException(actor: OperatorActor) {
  return operatorCommand(actor, 'exception:resolve', async (ctx, p: { exceptionId: string; resolution: (typeof NON_FINANCIAL_RESOLUTIONS)[number]; notes: string }) => {
    const resolution = requireOneOf(p.resolution, 'resolution', NON_FINANCIAL_RESOLUTIONS);
    return resolveExceptionInTx(ctx, { exceptionId: p.exceptionId, resolution, notes: p.notes });
  });
}

/** `exception.void` — `exception:resolve`. For false positives and idempotent replays only. */
export function voidException(actor: OperatorActor) {
  return operatorCommand(actor, 'exception:resolve', async (ctx, p: { exceptionId: string; reason: string }) => {
    const c = await lockException(ctx, p.exceptionId);
    if (c.status !== 'OPEN' && c.status !== 'IN_PROGRESS') throw new DomainError('INVALID_TRANSITION', `exception is ${c.status}`);
    const reason = requireText(p.reason, 'reason', 2000);
    await ctx.tx
      .updateTable('exception_case')
      .set({ status: 'VOID', resolution_notes: reason, resolved_by: ctx.actor.id ?? 'SYSTEM', resolved_at: sql<Date>`inrp2p_now()` })
      .where('id', '=', c.id)
      .execute();
    if (c.trade_id) await syncTradeHold(ctx, c.trade_id);
    await appendAudit(ctx, { action: 'exception.voided', entityType: 'exception_case', entityId: c.id, before: { status: c.status }, after: { status: 'VOID', reason } });
    return { status: 'VOID' as const };
  });
}

export const EXCEPTION_TYPES = Object.freeze([
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
  'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
  'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
  'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
] as const);
