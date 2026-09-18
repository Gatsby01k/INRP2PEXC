import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { AssetCode, FiatRail, ObligationSide, RouteSettlementFlow, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { consumeReservation, releaseReservation, reserveCapacity } from '@inrp2p/inr-accounts';
import { openExceptionInTx } from './exceptions.ts';
import { lockMovement, postMovement, recordCryptoTransfer, recordFiatTransfer, verifyCryptoTransfer } from './movements.ts';
import { allocateToObligation, lockObligation, obligationRemaining } from './obligations.ts';
import type { SettlementDeps } from './policy.ts';

export interface RecordRouteSettlementPayload {
  /** V1 obligations are PER_TRADE, so a settlement is always recorded against one obligation side (D-03). */
  readonly routeObligationId: string;
  readonly flow: 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE';
  readonly amount: string;
  /** INR evidence. */
  readonly rail?: FiatRail;
  readonly utr?: string;
  /** The exchange account that received (FROM_ROUTE_TO_EXCHANGE) or pays (TO_ROUTE) the INR. */
  readonly inrAccountId?: string | null;
  /** USDT evidence. */
  readonly txHash?: string;
  readonly logIndex?: number;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly treasuryWalletId?: string | null;
}

const sideOfFlow = (flow: RouteSettlementFlow): ObligationSide => (flow === 'TO_ROUTE' ? 'EXCHANGE_DELIVERS' : 'ROUTE_DELIVERS');

/**
 * `route_settlement.record` — `route_settlement:record`. Registers a real movement between the exchange and the
 * route against one obligation side, with its own evidence (FI-22/FI-23) and, for outgoing INR, a capacity
 * reservation (FI-30). Nothing is posted yet: a recorded settlement is a claim, not a movement.
 */
export function recordRouteSettlement(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'route_settlement:record', async (ctx, p: RecordRouteSettlementPayload) => {
    const flow = requireOneOf(p.flow, 'flow', ['FROM_ROUTE_TO_EXCHANGE', 'TO_ROUTE'] as const);
    const obligation = await lockObligation(ctx, p.routeObligationId);
    if (obligation.status === 'CANCELLED' || obligation.status === 'SETTLED') throw new DomainError('INVALID_TRANSITION', `obligation is ${obligation.status}`);
    const route = await ctx.tx.selectFrom('liquidity_route').select(['id', 'status', 'registered_route_address']).where('id', '=', obligation.route_id).forShare().executeTakeFirstOrThrow();
    if (route.status !== 'ACTIVE') throw new DomainError('ROUTE_NOT_USABLE', `route is ${route.status}`);

    const side = sideOfFlow(flow);
    const asset: AssetCode = side === 'ROUTE_DELIVERS' ? obligation.route_delivers_asset : obligation.exchange_delivers_asset;
    const amount = Money.parse(p.amount, asset);
    if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'a route settlement must be positive');
    const remaining = await obligationRemaining(ctx.tx, obligation.id);
    const sideRemaining = side === 'ROUTE_DELIVERS' ? remaining.routeDelivers : remaining.exchangeDelivers;
    if (amount.minor > sideRemaining.minor) {
      throw new DomainError('ROUTE_OVER_ALLOCATION', `only ${sideRemaining.toDecimalString()} ${sideRemaining.currency} remains on the ${side} side`);
    }

    let transferKind: 'FIAT' | 'CRYPTO';
    let transferId: string;
    if (asset === 'INR') {
      const inrAccountId = requireUuid(p.inrAccountId, 'inrAccountId');
      const movement = await recordFiatTransfer(ctx, {
        rail: requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const),
        utr: p.utr ?? '',
        amount: amount as Money<'INR'>,
        payerType: flow === 'TO_ROUTE' ? 'EXCHANGE_ACCOUNT' : 'ROUTE',
        payerId: flow === 'TO_ROUTE' ? inrAccountId : route.id,
        payeeType: flow === 'TO_ROUTE' ? 'ROUTE' : 'EXCHANGE_ACCOUNT',
        payeeId: flow === 'TO_ROUTE' ? route.id : inrAccountId,
        destinationMasked: flow === 'TO_ROUTE' ? 'liquidity route account' : 'exchange settlement account',
      });
      transferKind = 'FIAT';
      transferId = movement.transferId;
    } else {
      const walletId = requireUuid(p.treasuryWalletId, 'treasuryWalletId');
      const wallet = await ctx.tx.selectFrom('treasury_wallet').select(['address', 'status']).where('id', '=', walletId).forShare().executeTakeFirstOrThrow();
      if (wallet.status !== 'ACTIVE') throw new DomainError('TREASURY_WALLET_NOT_ACTIVE', `treasury wallet is ${wallet.status}`);
      const toAddress = flow === 'TO_ROUTE' ? requireText(p.toAddress ?? route.registered_route_address ?? '', 'toAddress', 64) : wallet.address;
      const fromAddress = flow === 'TO_ROUTE' ? wallet.address : requireText(p.fromAddress, 'fromAddress', 64);
      const movement = await recordCryptoTransfer(ctx, {
        txHash: p.txHash ?? '',
        logIndex: p.logIndex ?? 0,
        tokenContract: deps.chain.tokenContract,
        fromAddress,
        toAddress,
        amount: amount as Money<'USDT'>,
        payerType: flow === 'TO_ROUTE' ? 'EXCHANGE_TREASURY' : 'ROUTE',
        payerId: flow === 'TO_ROUTE' ? walletId : route.id,
        payeeType: flow === 'TO_ROUTE' ? 'ROUTE' : 'EXCHANGE_TREASURY',
        payeeId: flow === 'TO_ROUTE' ? route.id : walletId,
        source: 'OPERATOR_SUBMITTED',
      });
      transferKind = 'CRYPTO';
      transferId = movement.transferId;
    }

    const row = await ctx.tx
      .insertInto('route_settlement')
      .values({
        route_id: route.id,
        route_obligation_id: obligation.id,
        obligation_side: side,
        flow,
        asset,
        amount_minor: amount.minor,
        transfer_kind: transferKind,
        fiat_transfer_id: transferKind === 'FIAT' ? transferId : null,
        crypto_transfer_id: transferKind === 'CRYPTO' ? transferId : null,
        created_by: ctx.actor.id ?? 'SYSTEM',
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    if (flow === 'TO_ROUTE' && asset === 'INR') {
      // Outgoing INR needs capacity like any other payment out of an exchange account (FI-30).
      const reserved = await reserveCapacity(ctx, {
        accountId: requireUuid(p.inrAccountId, 'inrAccountId'),
        amount: amount as Money<'INR'>,
        subject: { purpose: 'ROUTE_SETTLEMENT', routeSettlementId: row.id },
      });
      await ctx.tx.updateTable('route_settlement').set({ capacity_reservation_id: reserved.reservationId }).where('id', '=', row.id).execute();
    }
    await ctx.tx
      .insertInto('transfer_allocation')
      .values({
        transfer_kind: transferKind,
        fiat_transfer_id: transferKind === 'FIAT' ? transferId : null,
        crypto_transfer_id: transferKind === 'CRYPTO' ? transferId : null,
        dimension: 'ROUTE',
        route_settlement_id: row.id,
        amount_minor: amount.minor,
        allocated_by: ctx.actor.id ?? 'SYSTEM',
      })
      .execute();
    await appendAudit(ctx, {
      action: 'route_settlement.recorded', entityType: 'route_settlement', entityId: row.id,
      after: { ref: row.ref, flow, asset, amount, route_obligation_id: obligation.id, side, evidence: transferKind },
    });
    return { routeSettlementId: row.id, ref: row.ref, side, obligationId: obligation.id };
  });
}

/**
 * `route_settlement.confirm` — `route_settlement:confirm` (⧗). The movement posts its single journal with the
 * obligation dimension (FI-64) and the obligation side is allocated in the same transaction; outgoing INR
 * consumes its reservation.
 */
export function confirmRouteSettlement(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'route_settlement:confirm', async (ctx, p: { routeSettlementId: string }) => {
    const s = await ctx.tx.selectFrom('route_settlement').selectAll().where('id', '=', requireUuid(p.routeSettlementId, 'routeSettlementId')).executeTakeFirst();
    if (!s) throw new DomainError('NOT_FOUND', 'route settlement not found');
    if (s.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `route settlement is ${s.status}`);
    const obligation = await lockObligation(ctx, s.route_obligation_id);
    const side = s.obligation_side;
    const amount = Money.ofMinor(s.amount_minor, s.asset);
    const movementId = (s.fiat_transfer_id ?? s.crypto_transfer_id)!;
    await lockMovement(ctx, s.transfer_kind, movementId);

    if (s.transfer_kind === 'FIAT') {
      const f = await ctx.tx.selectFrom('fiat_transfer').select('status').where('id', '=', movementId).executeTakeFirstOrThrow();
      if (f.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payment reference is ${f.status}`);
      await ctx.tx.updateTable('fiat_transfer').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', movementId).execute();
    } else {
      const verified = await verifyCryptoTransfer(ctx, deps, movementId);
      if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason ?? 'the transfer is not final on chain');
    }

    const routeParty = { kind: 'ROUTE' as const, routeId: s.route_id, routeObligationId: obligation.id };
    const exchangeParty =
      s.asset === 'INR'
        ? { kind: 'EXCHANGE_ACCOUNT' as const, inrAccountId: await counterpartyAccount(ctx, s.transfer_kind, movementId, s.flow) }
        : { kind: 'EXCHANGE_TREASURY' as const, walletId: await counterpartyAccount(ctx, s.transfer_kind, movementId, s.flow) };
    await postMovement(ctx, {
      kind: s.transfer_kind,
      movementId,
      amount,
      from: s.flow === 'TO_ROUTE' ? exchangeParty : routeParty,
      to: s.flow === 'TO_ROUTE' ? routeParty : exchangeParty,
      tradeId: obligation.trade_id,
      purpose: 'ROUTE_SETTLEMENT',
    });
    await ctx.tx.updateTable('route_settlement').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', s.id).execute();
    if (s.capacity_reservation_id) await consumeReservation(ctx, s.capacity_reservation_id, amount as Money<'INR'>);
    const allocated = await allocateToObligation(ctx, { obligation, side, routeSettlementId: s.id, amount });
    await appendAudit(ctx, {
      action: 'route_settlement.confirmed', entityType: 'route_settlement', entityId: s.id,
      before: { status: 'RECORDED' }, after: { status: 'CONFIRMED', amount, side, obligation_status: allocated.status },
    });
    return { status: 'CONFIRMED' as const, obligationStatus: allocated.status };
  });
}

/** The exchange-side account or wallet of a route movement, read from the evidence row. */
async function counterpartyAccount(ctx: TxContext, kind: 'FIAT' | 'CRYPTO', movementId: string, flow: RouteSettlementFlow): Promise<string> {
  if (kind === 'FIAT') {
    const f = await ctx.tx.selectFrom('fiat_transfer').select(['payer_id', 'payee_id']).where('id', '=', movementId).executeTakeFirstOrThrow();
    return flow === 'TO_ROUTE' ? f.payer_id : f.payee_id;
  }
  const c = await ctx.tx.selectFrom('crypto_transfer').select(['payer_id', 'payee_id']).where('id', '=', movementId).executeTakeFirstOrThrow();
  const id = flow === 'TO_ROUTE' ? c.payer_id : c.payee_id;
  if (!id) throw new DomainError('INVALID_ARGUMENT', 'the transfer has no treasury side');
  return id;
}

/** `route_settlement.fail` — `route_settlement:confirm` (⧗). The claimed movement never happened. */
export function failRouteSettlement(actor: OperatorActor) {
  return operatorCommand(actor, 'route_settlement:confirm', async (ctx, p: { routeSettlementId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const s = await ctx.tx.selectFrom('route_settlement').selectAll().where('id', '=', requireUuid(p.routeSettlementId, 'routeSettlementId')).executeTakeFirstOrThrow();
    if (s.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `route settlement is ${s.status}`);
    await ctx.tx.updateTable('route_settlement').set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: reason }).where('id', '=', s.id).execute();
    if (s.fiat_transfer_id) {
      await ctx.tx.updateTable('fiat_transfer').set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: reason }).where('id', '=', s.fiat_transfer_id).where('status', '=', 'RECORDED').execute();
    }
    if (s.capacity_reservation_id) await releaseReservation(ctx, s.capacity_reservation_id, 'ROUTE_SETTLEMENT_FAILED');
    const allocation = await ctx.tx.selectFrom('transfer_allocation').select('id').where('route_settlement_id', '=', s.id).where('voided_at', 'is', null).executeTakeFirst();
    if (allocation) {
      await ctx.tx
        .updateTable('transfer_allocation')
        .set({ voided_at: sql<Date>`inrp2p_now()`, voided_by: ctx.actor.id ?? 'SYSTEM', void_reason: reason })
        .where('id', '=', allocation.id)
        .execute();
    }
    await appendAudit(ctx, { action: 'route_settlement.failed', entityType: 'route_settlement', entityId: s.id, before: { status: 'RECORDED' }, after: { status: 'FAILED', reason } });
    await openExceptionInTx(ctx, {
      type: 'ROUTE_SETTLEMENT_MISMATCH', subjectType: 'ROUTE_SETTLEMENT', subjectId: s.id, tradeId: null,
      detectedBy: 'OPERATOR', details: { reason, ref: s.ref },
    });
    await enqueueOutbox(ctx, { type: 'desk.route_settlement_failed', aggregateType: 'route_settlement', aggregateId: s.id, payload: { routeSettlementId: s.id } });
    return { status: 'FAILED' as const };
  });
}
