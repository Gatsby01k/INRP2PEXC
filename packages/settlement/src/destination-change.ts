import { sql } from 'kysely';
import { DomainError, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, assertSecondApprover, operatorCommand } from '@inrp2p/identity';
import { releaseReservation } from '@inrp2p/inr-accounts';
import { lockTrade } from '@inrp2p/trades';
import { resolveExceptionInTx } from './exceptions.ts';
import { settleFunding } from './funding.ts';
import { lockLeg, tradePayoutDestination } from './legs.ts';
import { advanceTrade } from './progress.ts';

/**
 * A changed destination for an open trade (production task D1, TD-18; SECURITY S8).
 *
 * A trade's destination was frozen at acceptance, so when a client replaced their bank account or wallet mid-trade
 * the trade could only be unwound. `trade_economics` stays exactly as it was accepted; the change is an append-only
 * amendment, with the reason and how the client confirmed it, requested by one person and approved by another, each
 * with step-up. The new destination is the same client's and verified (ACTIVE); a payout planned to the old one is
 * cancelled on the record and one already sent is resolved first — never two payees. Every client administrator is
 * told. The database holds the same rules (IX092).
 */

const OPEN_STATES = new Set(['FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED', 'AWAITING_FIRST_LEG', 'FIRST_LEG_DETECTED']);

async function lockChange(ctx: TxContext, requestId: string) {
  const id = requireUuid(requestId, 'requestId');
  const peek = await ctx.tx.selectFrom('trade_destination_change').select('trade_id').where('id', '=', id).executeTakeFirst();
  if (!peek) throw new DomainError('NOT_FOUND', 'destination change not found');
  const trade = await lockTrade(ctx.tx, peek.trade_id);
  const change = await ctx.tx.selectFrom('trade_destination_change').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
  if (change.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `destination change ${change.ref} is ${change.status.toLowerCase()}`);
  return { trade, change };
}

async function describe(ctx: TxContext, to: { bankAccountId: string | null; walletId: string | null }): Promise<string> {
  if (to.bankAccountId) {
    const b = await ctx.tx.selectFrom('bank_account').select(['bank_name', 'account_last4']).where('id', '=', to.bankAccountId).executeTakeFirstOrThrow();
    return `${b.bank_name} ••••${b.account_last4}`;
  }
  const w = await ctx.tx.selectFrom('crypto_wallet').select(['label', 'address']).where('id', '=', to.walletId!).executeTakeFirstOrThrow();
  return `${w.label} (${w.address.slice(0, 6)}…${w.address.slice(-4)})`;
}

/** `trade.request_destination_change` — `trade:request_destination_change` (⧗). Changes nothing until approved. */
export function requestDestinationChange(actor: OperatorActor) {
  return operatorCommand(actor, 'trade:request_destination_change', async (ctx, p: {
    tradeId: string; toBankAccountId?: string | null; toWalletId?: string | null; reason: string; evidence: string; exceptionId?: string | null;
  }) => {
    const trade = await lockTrade(ctx.tx, p.tradeId);
    if (!OPEN_STATES.has(trade.lifecycle_state)) throw new DomainError('INVALID_TRANSITION', `trade is ${trade.lifecycle_state}`);
    const reason = requireText(p.reason, 'reason', 500);
    const evidence = requireText(p.evidence, 'evidence', 1000);
    if (reason.length < 10 || evidence.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why, and how the client confirmed the new destination (at least 10 characters each)');
    const current = await tradePayoutDestination(ctx.tx, trade.id);
    const paysInr = trade.direction === 'SELL_USDT';
    let to: { bankAccountId: string | null; walletId: string | null };
    if (paysInr) {
      const id = requireUuid(p.toBankAccountId, 'toBankAccountId');
      const b = await ctx.tx.selectFrom('bank_account').select(['client_id', 'status']).where('id', '=', id).executeTakeFirst();
      if (!b || b.client_id !== trade.client_id || b.status !== 'ACTIVE') throw new DomainError('DESTINATION_INVALID', 'the new account must be an active, verified account of this client');
      to = { bankAccountId: id, walletId: null };
      if (id === current.bankAccountId) throw new DomainError('INVALID_ARGUMENT', 'the trade already pays to this account');
    } else {
      const id = requireUuid(p.toWalletId, 'toWalletId');
      const w = await ctx.tx.selectFrom('crypto_wallet').select(['client_id', 'status', 'purpose']).where('id', '=', id).executeTakeFirst();
      if (!w || w.client_id !== trade.client_id || w.status !== 'ACTIVE' || (w.purpose !== 'DESTINATION' && w.purpose !== 'BOTH')) {
        throw new DomainError('DESTINATION_INVALID', 'the new wallet must be an active, verified receiving wallet of this client');
      }
      to = { bankAccountId: null, walletId: id };
      if (id === current.walletId) throw new DomainError('INVALID_ARGUMENT', 'the trade already pays to this wallet');
    }
    let exceptionId: string | null = null;
    if (p.exceptionId) {
      exceptionId = requireUuid(p.exceptionId, 'exceptionId');
      const c = await ctx.tx.selectFrom('exception_case').select(['trade_id', 'type', 'status']).where('id', '=', exceptionId).executeTakeFirst();
      if (!c || c.trade_id !== trade.id || c.type !== 'CLIENT_BANK_CHANGED' || (c.status !== 'OPEN' && c.status !== 'IN_PROGRESS')) {
        throw new DomainError('INVALID_ARGUMENT', 'that case is not an open destination change of this trade');
      }
    }
    const pending = await ctx.tx.selectFrom('trade_destination_change').select('ref').where('trade_id', '=', trade.id).where('status', '=', 'REQUESTED').executeTakeFirst();
    if (pending) throw new DomainError('INVALID_TRANSITION', `destination change ${pending.ref} is already waiting for approval`);
    const row = await ctx.tx
      .insertInto('trade_destination_change')
      .values({
        trade_id: trade.id, exception_case_id: exceptionId,
        from_bank_account_id: paysInr ? current.bankAccountId : null, from_wallet_id: paysInr ? null : current.walletId,
        to_bank_account_id: to.bankAccountId, to_wallet_id: to.walletId, reason, evidence, requested_by: actor.userId,
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'trade.destination_change_requested', entityType: 'trade_destination_change', entityId: row.id,
      after: { ref: row.ref, trade_id: trade.id, to: await describe(ctx, to), reason, evidence },
    });
    return { requestId: row.id, ref: row.ref };
  });
}

/**
 * `trade.approve_destination_change` — `trade:approve_destination_change` (⧗✱), by someone other than the requester.
 * Refused while a payout to the old destination is in flight; a payout still only planned to it is cancelled here,
 * on the record (its capacity and earmark released), and the desk plans it again to the new destination.
 */
export function approveDestinationChange(actor: OperatorActor) {
  return operatorCommand(actor, 'trade:approve_destination_change', async (ctx, p: { requestId: string; note?: string | null }, decision) => {
    const { trade, change } = await lockChange(ctx, p.requestId);
    assertSecondApprover(decision, change.requested_by, actor.userId);
    const inFlight = await ctx.tx.selectFrom('settlement_leg').select('ref').where('trade_id', '=', trade.id).where('side', '=', 'EXCHANGE_TO_CLIENT')
      .where('status', '=', 'PROCESSING').executeTakeFirst();
    if (inFlight) throw new DomainError('PAYOUT_IN_FLIGHT', `payout ${inFlight.ref} was sent to the old destination; confirm or fail it before changing where the trade pays`);
    const planned = await ctx.tx.selectFrom('settlement_leg').select('id').where('trade_id', '=', trade.id).where('side', '=', 'EXCHANGE_TO_CLIENT')
      .where('status', '=', 'PENDING').orderBy('seq').execute();
    for (const l of planned) {
      const leg = await lockLeg(ctx, l.id);
      await ctx.tx.updateTable('settlement_leg').set({ status: 'CANCELLED', cancelled_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
      if (leg.capacity_reservation_id) await releaseReservation(ctx, leg.capacity_reservation_id, 'LEG_CANCELLED');
      await settleFunding(ctx, { kind: 'CLIENT_PAYOUT', legId: leg.id }, 'RELEASED', `destination changed (${change.ref})`);
      await appendAudit(ctx, { action: 'leg.cancelled', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PENDING' }, after: { status: 'CANCELLED', reason: `destination changed (${change.ref})` } });
    }
    const note = p.note ? requireText(p.note, 'note', 500) : null;
    await ctx.tx
      .updateTable('trade_destination_change')
      .set({ status: 'APPROVED', decided_by: actor.userId, decided_at: sql<Date>`inrp2p_now()`, decision_note: note })
      .where('id', '=', change.id)
      .execute();
    // The case that held the trade is answered by this change.
    const cases = await ctx.tx.selectFrom('exception_case').select('id').where('trade_id', '=', trade.id).where('type', '=', 'CLIENT_BANK_CHANGED')
      .where('status', 'in', ['OPEN', 'IN_PROGRESS']).execute();
    for (const c of cases) await resolveExceptionInTx(ctx, { exceptionId: c.id, resolution: 'confirm_new_destination', notes: `destination change ${change.ref} approved` });
    const label = await describe(ctx, { bankAccountId: change.to_bank_account_id, walletId: change.to_wallet_id });
    await appendAudit(ctx, {
      action: 'trade.destination_changed', entityType: 'trade', entityId: trade.id,
      before: { bank_account_id: change.from_bank_account_id, wallet_id: change.from_wallet_id },
      after: { bank_account_id: change.to_bank_account_id, wallet_id: change.to_wallet_id, change_ref: change.ref, requested_by: change.requested_by, approved_by: actor.userId, legs_cancelled: planned.length },
    });
    await enqueueOutbox(ctx, {
      type: 'client.trade_destination_changed', aggregateType: 'trade', aggregateId: trade.id,
      payload: { tradeId: trade.id, clientId: trade.client_id, label },
    });
    await advanceTrade(ctx, trade.id);
    return { ref: change.ref, legsCancelled: planned.length };
  });
}

/** `trade.reject_destination_change` — `trade:approve_destination_change` (⧗), by someone other than the requester. */
export function rejectDestinationChange(actor: OperatorActor) {
  return operatorCommand(actor, 'trade:approve_destination_change', async (ctx, p: { requestId: string; note: string }) => {
    const { change } = await lockChange(ctx, p.requestId);
    if (change.requested_by === actor.userId) throw new DomainError('INVALID_ARGUMENT', 'the requester withdraws a change; someone else declines it');
    const note = requireText(p.note, 'note', 500);
    await ctx.tx.updateTable('trade_destination_change').set({ status: 'REJECTED', decided_by: actor.userId, decided_at: sql<Date>`inrp2p_now()`, decision_note: note }).where('id', '=', change.id).execute();
    await appendAudit(ctx, { action: 'trade.destination_change_rejected', entityType: 'trade_destination_change', entityId: change.id, after: { ref: change.ref, note } });
    return { ref: change.ref, status: 'REJECTED' as const };
  });
}

/** `trade.cancel_destination_change` — the requester withdraws it (`trade:request_destination_change`, ⧗). */
export function cancelDestinationChange(actor: OperatorActor) {
  return operatorCommand(actor, 'trade:request_destination_change', async (ctx, p: { requestId: string }) => {
    const { change } = await lockChange(ctx, p.requestId);
    if (change.requested_by !== actor.userId) throw new DomainError('FORBIDDEN', 'only the requester withdraws a change');
    await ctx.tx.updateTable('trade_destination_change').set({ status: 'CANCELLED', decided_by: actor.userId, decided_at: sql<Date>`inrp2p_now()` }).where('id', '=', change.id).execute();
    await appendAudit(ctx, { action: 'trade.destination_change_cancelled', entityType: 'trade_destination_change', entityId: change.id, after: { ref: change.ref } });
    return { ref: change.ref, status: 'CANCELLED' as const };
  });
}
