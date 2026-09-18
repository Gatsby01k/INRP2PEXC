import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { Db, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { executeCommand } from '@inrp2p/commands';
import { type MovementParty, postJournal, tradeCompleteJournal } from '@inrp2p/ledger';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { releaseReservation } from '@inrp2p/inr-accounts';
import { consumeTreasuryReservation, releaseDepositAssignment, releaseTreasuryReservation } from '@inrp2p/treasury';
import { type TradeRow, effectiveObligations, legTotals, lockTrade, tradeEconomics, transitionTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';
import { lockLeg } from './legs.ts';
import { lockMovement, postMovement, verifyCryptoTransfer } from './movements.ts';
import { allocateToObligation, lockObligation, obligationOfTrade, obligationRemaining } from './obligations.ts';
import type { SettlementDeps } from './policy.ts';

export interface ConfirmPayoutResult {
  readonly legRef: string;
  readonly tradeState: string;
  readonly paid: string;
  readonly remaining: string;
  readonly routeSettlementId: string | null;
  readonly completed: boolean;
}

/**
 * `payout_leg.confirm` (T6/T7, STATE_MACHINES §4) — `settlement:confirm_payout` (⧗).
 *
 * One command, one transaction, **exactly one journal** — the movement's (FI-27). For a route-paid direct payout
 * the same movement additionally becomes a `DIRECT_TO_CLIENT` route settlement allocated to the trade's route
 * obligation, so the client payable and the route receivable both fall by the one real payment (D-14, FI-28).
 * If the route side does not fit, the whole command fails: no leg completion without the route allocation.
 */
export function confirmPayoutLeg(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'settlement:confirm_payout', async (ctx, p: { legId: string }): Promise<ConfirmPayoutResult> => {
    const legPeek = await ctx.tx.selectFrom('settlement_leg').select(['trade_id', 'payer']).where('id', '=', requireUuid(p.legId, 'legId')).executeTakeFirst();
    if (!legPeek) throw new DomainError('NOT_FOUND', 'settlement leg not found');
    // Lock order: trade → route obligation → leg → movement (ARCHITECTURE §4).
    const trade = await lockTrade(ctx.tx, legPeek.trade_id);
    if (trade.hold) throw new DomainError('TRADE_ON_HOLD', 'the trade has an open blocking exception');
    const econ = await tradeEconomics(ctx.tx, trade.id);
    const obligation = legPeek.payer === 'ROUTE' ? await lockObligation(ctx, (await obligationOfTrade(ctx.tx, trade.id)).id) : null;
    const leg = await lockLeg(ctx, p.legId);
    if (leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `leg ${leg.ref} is ${leg.status}`);

    const allocation = await ctx.tx
      .selectFrom('transfer_allocation')
      .select(['id', 'transfer_kind', 'fiat_transfer_id', 'crypto_transfer_id', 'amount_minor'])
      .where('settlement_leg_id', '=', leg.id)
      .where('voided_at', 'is', null)
      .executeTakeFirst();
    if (!allocation) throw new DomainError('UTR_REQUIRED', 'record the payment reference before confirming');
    const movementId = (allocation.fiat_transfer_id ?? allocation.crypto_transfer_id)!;
    await lockMovement(ctx, allocation.transfer_kind, movementId);

    const amount = Money.ofMinor(leg.amount_minor, leg.asset);
    // FI-20 under the trade lock: confirmed payouts never exceed the effective obligation.
    const { payout, receivable } = await effectiveObligations(ctx.tx, trade.id);
    const totals = await legTotals(ctx.tx, trade.id);
    if (totals.paid + amount.minor > payout.minor) {
      throw new DomainError('OVER_ALLOCATION', `confirming ${amount.toDecimalString()} would pay more than this trade owes`);
    }

    // The route side is checked before anything is written, so a mismatch leaves no trace to undo.
    if (obligation) {
      if (obligation.execution_mode !== 'DIRECT_TO_CLIENT' || obligation.route_id !== leg.route_id) {
        throw new DomainError('ROUTE_DIRECT_PAYOUT_MISMATCH', 'this trade’s route does not pay the client directly', { legId: leg.id, tradeId: trade.id });
      }
      const remaining = await obligationRemaining(ctx.tx, obligation.id);
      if (remaining.routeDelivers.currency !== amount.currency || amount.minor > remaining.routeDelivers.minor) {
        throw new DomainError('ROUTE_DIRECT_PAYOUT_MISMATCH', `the route owes only ${remaining.routeDelivers.toDecimalString()} ${remaining.routeDelivers.currency} on this trade`, {
          legId: leg.id, tradeId: trade.id, remaining: remaining.routeDelivers.minor.toString(), requested: amount.minor.toString(),
        });
      }
    }

    // Evidence must be real before it can settle anything.
    if (allocation.transfer_kind === 'FIAT') {
      const f = await ctx.tx.selectFrom('fiat_transfer').select(['status', 'utr']).where('id', '=', movementId).executeTakeFirstOrThrow();
      if (f.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payment reference is ${f.status}`);
      await ctx.tx.updateTable('fiat_transfer').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', movementId).execute();
    } else {
      const verified = await verifyCryptoTransfer(ctx, deps, movementId);
      if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason ?? 'the transfer is not confirmed on chain');
    }

    const from: MovementParty =
      leg.payer === 'ROUTE'
        ? { kind: 'ROUTE', routeId: leg.route_id!, routeObligationId: obligation!.id }
        : leg.asset === 'INR'
          ? { kind: 'EXCHANGE_ACCOUNT', inrAccountId: leg.inr_account_id! }
          : { kind: 'EXCHANGE_TREASURY', walletId: leg.treasury_wallet_id! };
    await postMovement(ctx, {
      kind: allocation.transfer_kind,
      movementId,
      amount,
      from,
      to: { kind: 'CLIENT', clientId: trade.client_id },
      tradeId: trade.id,
      purpose: 'CLIENT_PAYOUT',
    });

    await ctx.tx.updateTable('settlement_leg').set({ status: 'COMPLETED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
    if (leg.payer === 'EXCHANGE_ACCOUNT' && leg.asset === 'USDT') {
      await consumeTreasuryReservation(ctx, { tradeId: trade.id, amount: amount as Money<'USDT'> });
    }

    let routeSettlementId: string | null = null;
    if (obligation) {
      const settlement = await ctx.tx
        .insertInto('route_settlement')
        .values({
          route_id: obligation.route_id,
          route_obligation_id: obligation.id,
          obligation_side: 'ROUTE_DELIVERS',
          flow: 'DIRECT_TO_CLIENT',
          asset: leg.asset,
          amount_minor: amount.minor,
          transfer_kind: allocation.transfer_kind,
          fiat_transfer_id: allocation.fiat_transfer_id,
          crypto_transfer_id: allocation.crypto_transfer_id,
          status: 'CONFIRMED',
          confirmed_at: sql<Date>`inrp2p_now()`,
          created_by: `SYSTEM:${ctx.commandName}`,
        })
        .returning(['id', 'ref'])
        .executeTakeFirstOrThrow();
      routeSettlementId = settlement.id;
      await ctx.tx
        .insertInto('transfer_allocation')
        .values({
          transfer_kind: allocation.transfer_kind,
          fiat_transfer_id: allocation.fiat_transfer_id,
          crypto_transfer_id: allocation.crypto_transfer_id,
          dimension: 'ROUTE',
          route_settlement_id: settlement.id,
          amount_minor: amount.minor,
          allocated_by: `SYSTEM:${ctx.commandName}`,
        })
        .execute();
      await allocateToObligation(ctx, { obligation, side: 'ROUTE_DELIVERS', routeSettlementId: settlement.id, amount, allocatedBy: `SYSTEM:${ctx.commandName}` });
      await appendAudit(ctx, {
        action: 'route_settlement.confirmed', entityType: 'route_settlement', entityId: settlement.id,
        after: { ref: settlement.ref, flow: 'DIRECT_TO_CLIENT', amount, route_obligation_id: obligation.id, trade_id: trade.id, leg_ref: leg.ref },
      });
    }

    await appendAudit(ctx, {
      action: 'leg.confirmed', entityType: 'settlement_leg', entityId: leg.id,
      before: { status: 'PROCESSING' },
      after: { status: 'COMPLETED', amount, payer: leg.payer, movement: { kind: allocation.transfer_kind, id: movementId }, route_settlement_id: routeSettlementId },
    });

    const paid = totals.paid + amount.minor;
    const completed = paid === payout.minor && totals.received === receivable.minor;
    if (completed) {
      await completeTrade(ctx, trade, econ);
    } else if (trade.lifecycle_state === 'SETTLING') {
      await transitionTrade(ctx, trade, 'PARTIALLY_SETTLED', { extra: { paid: Money.ofMinor(paid, leg.asset), of: payout } });
    }
    await enqueueOutbox(ctx, {
      type: 'client.payout_confirmed', aggregateType: 'trade', aggregateId: trade.id,
      payload: { tradeId: trade.id, clientId: trade.client_id, legRef: leg.ref, paid: Money.ofMinor(paid, leg.asset).toDecimalString(), of: payout.toDecimalString() },
    });

    return {
      legRef: leg.ref,
      tradeState: completed ? 'COMPLETED' : trade.lifecycle_state === 'SETTLING' ? 'PARTIALLY_SETTLED' : trade.lifecycle_state,
      paid: Money.ofMinor(paid, leg.asset).toDecimalString(),
      remaining: Money.ofMinor(payout.minor - paid, leg.asset).toDecimalString(),
      routeSettlementId,
      completed,
    };
  });
}

/**
 * T7: both sides of the client's trade are settled. Margin moves from deferred to realized (FI-43), the
 * remaining commitments are released, and the deposit address goes to cooldown. Completion never waits for the
 * route obligation (FI-62) — a residual may stay open.
 */
export async function completeTrade(ctx: TxContext, trade: TradeRow, econ: Awaited<ReturnType<typeof tradeEconomics>>): Promise<void> {
  const reservations = await ctx.tx.selectFrom('capacity_reservation').select('id').where('trade_id', '=', trade.id).where('status', '=', 'ACTIVE').orderBy('id').execute();
  for (const r of reservations) await releaseReservation(ctx, r.id, 'TRADE_COMPLETED');
  await releaseTreasuryReservation(ctx, { tradeId: trade.id, reason: 'TRADE_COMPLETED' });
  if (trade.direction === 'SELL_USDT') {
    const assignment = await ctx.tx.selectFrom('deposit_assignment').select('id').where('trade_id', '=', trade.id).where('released_at', 'is', null).executeTakeFirst();
    if (assignment) await releaseDepositAssignment(ctx, { tradeId: trade.id, reason: 'TRADE_COMPLETED' });
  }
  // The realized margin is the effective one: frozen margin ⊕ margin deltas of posted adjustments (FI-12, FI-43),
  // so the deferred-margin account ends this trade at zero.
  const deltas = await ctx.tx
    .selectFrom('financial_adjustment')
    .select(({ fn }) => fn.sum<string>('delta_margin_inr_minor').as('total'))
    .where('trade_id', '=', trade.id)
    .where('status', '=', 'POSTED')
    .executeTakeFirst();
  const effectiveMargin = Money.ofMinor(econ.grossMargin.minor + BigInt(deltas?.total ?? '0'), 'INR');
  await transitionTrade(ctx, trade, 'COMPLETED', { extra: { gross_margin: effectiveMargin } });
  const journal = tradeCompleteJournal({ ...econ, grossMargin: effectiveMargin }, { tradeId: trade.id });
  if (journal) await postJournal(ctx, journal);
  await enqueueOutbox(ctx, { type: 'receipt.generate', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id, clientId: trade.client_id } });
}

/**
 * Runs `payout_leg.confirm` and, when the route side does not fit, records the mismatch for FINANCE in its own
 * transaction — the confirm itself rolled back, so no leg, allocation or journal exists (exit test 6).
 */
export async function confirmPayout(
  db: Db,
  actor: OperatorActor,
  deps: SettlementDeps,
  input: { legId: string; idempotencyKey: string },
): Promise<ConfirmPayoutResult> {
  try {
    const out = await executeCommand(db, confirmPayoutLeg(actor, deps), {
      name: 'payout_leg.confirm',
      actor: { type: 'USER', id: actor.userId, surface: 'OPERATOR', sessionId: actor.sessionId },
      payload: { legId: input.legId },
      idempotencyKey: input.idempotencyKey,
      financial: true,
    });
    return out.result;
  } catch (e) {
    if (e instanceof DomainError && e.code === 'ROUTE_DIRECT_PAYOUT_MISMATCH') {
      const details = (e.details ?? {}) as { legId?: string; tradeId?: string };
      if (details.legId && details.tradeId) {
        await executeCommand(db, {
          authorize: async () => {},
          handle: async (ctx) => {
            await lockTrade(ctx.tx, details.tradeId!);
            return openExceptionInTx(ctx, {
              type: 'ROUTE_DIRECT_PAYOUT_MISMATCH', subjectType: 'SETTLEMENT_LEG', subjectId: details.legId!, tradeId: details.tradeId!,
              detectedBy: 'SYSTEM', details: { message: e.message, ...details },
            });
          },
        }, { name: 'exception.route_direct_payout_mismatch', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { legId: details.legId }, idempotencyKey: randomUUID(), financial: false });
      }
    }
    throw e;
  }
}
