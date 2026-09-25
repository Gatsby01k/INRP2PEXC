import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type AssetCode, type Executor, type FiatRail, type LegPayer, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, authorizeOperator, operatorCommand } from '@inrp2p/identity';
import { consumeReservation, refundConsumedCapacity, releaseReservation, reserveCapacity } from '@inrp2p/inr-accounts';
import { effectiveObligations, legTotals, lockTrade, tradeEconomics, transitionTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';
import { maskedBankDestination, recordFiatTransfer } from './movements.ts';
import { type SettlementDeps, policyOf } from './policy.ts';

export const payoutAssetOf = (direction: 'SELL_USDT' | 'BUY_USDT'): AssetCode => (direction === 'SELL_USDT' ? 'INR' : 'USDT');

export async function nextLegSeq(ctx: TxContext, tradeId: string): Promise<number> {
  const r = await ctx.tx
    .selectFrom('settlement_leg')
    .select(({ fn }) => fn.max<number | null>('seq').as('max_seq'))
    .where('trade_id', '=', tradeId)
    .executeTakeFirst();
  return (r?.max_seq ?? 0) + 1;
}

/**
 * FI-25: a trade either pays the client out or gives the client's funds back — never both at once. A refund that
 * is planned or done stops every payout, and a payout that has left (or is leaving) stops every refund; otherwise
 * the client could be sent the payout and the refund of the funds it was paid for. Callers hold the trade lock.
 */
export async function assertNoRefundUnderway(ex: Executor, tradeId: string): Promise<void> {
  const refund = await ex.selectFrom('settlement_leg').select('ref').where('trade_id', '=', tradeId).where('side', '=', 'REFUND_TO_CLIENT')
    .where('status', 'in', ['PENDING', 'PROCESSING', 'COMPLETED']).executeTakeFirst();
  if (refund) throw new DomainError('REFUND_IN_PROGRESS', `refund ${refund.ref} is planned or done for this trade; cancel it before paying out`);
}

export async function assertNoPayoutUnderway(ex: Executor, tradeId: string): Promise<void> {
  const payout = await ex.selectFrom('settlement_leg').select(['ref', 'status']).where('trade_id', '=', tradeId).where('side', '=', 'EXCHANGE_TO_CLIENT')
    .where('status', 'in', ['PROCESSING', 'COMPLETED']).executeTakeFirst();
  if (!payout) return;
  if (payout.status === 'COMPLETED') throw new DomainError('PAYOUT_ALREADY_CONFIRMED', 'a payout was already confirmed; correct it with a financial adjustment');
  throw new DomainError('PAYOUT_IN_FLIGHT', `payout ${payout.ref} is already sent; confirm or fail it before refunding`);
}

export async function lockLeg(ctx: TxContext, legId: string) {
  assertLockOrder(ctx.tx, 'settlement_leg');
  const rows = await sql<{
    id: string; trade_id: string; seq: number; ref: string; side: string; asset: AssetCode; amount_minor: bigint; status: string;
    payer: LegPayer; route_id: string | null; inr_account_id: string | null; capacity_reservation_id: string | null; treasury_wallet_id: string | null;
    destination_bank_account_id: string | null; destination_wallet_id: string | null;
  }>`select id, trade_id, seq, ref, side, asset, amount_minor, status, payer, route_id, inr_account_id, capacity_reservation_id, treasury_wallet_id,
            destination_bank_account_id, destination_wallet_id
       from settlement_leg where id = ${requireUuid(legId, 'legId')} for update`.execute(ctx.tx);
  const leg = rows.rows[0];
  if (!leg) throw new DomainError('NOT_FOUND', 'settlement leg not found');
  return leg;
}

export interface CreatePayoutLegPayload {
  readonly tradeId: string;
  /** Decimal amount in the payout asset (SELL: INR, BUY: USDT). */
  readonly amount: string;
  readonly payer: 'EXCHANGE_ACCOUNT' | 'ROUTE';
  /** Required for an INR payout from an exchange account. */
  readonly inrAccountId?: string | null;
  /** Required for a USDT payout from treasury. */
  readonly treasuryWalletId?: string | null;
  readonly notes?: string | null;
}

/**
 * `payout_leg.create` (STATE_MACHINES §4 create → PENDING) — `settlement:create_payout`. Checks D-12 (the client
 * leg must be confirmed), FI-20 (committed legs ≤ effective obligation) and, for an exchange INR payout, reserves
 * capacity on the chosen account (FI-30). A route-paid leg is allowed only in `DIRECT_TO_CLIENT` mode (FI-65).
 */
export function createPayoutLeg(actor: OperatorActor, deps: Pick<SettlementDeps, 'policy'>) {
  const policy = policyOf(deps);
  return operatorCommand(actor, 'settlement:create_payout', async (ctx, p: CreatePayoutLegPayload) => {
    const trade = await lockTrade(ctx.tx, p.tradeId);
    if (trade.hold) throw new DomainError('TRADE_ON_HOLD', 'the trade has an open blocking exception');
    if (!['FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED'].includes(trade.lifecycle_state)) {
      throw new DomainError('INVALID_TRANSITION', `payouts need a confirmed client leg (trade is ${trade.lifecycle_state})`);
    }
    await assertNoRefundUnderway(ctx.tx, trade.id);
    const econ = await tradeEconomics(ctx.tx, trade.id);
    const asset = payoutAssetOf(trade.direction);
    const amount = Money.parse(p.amount, asset);
    if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'a payout must be positive');
    if (asset === 'INR' && amount.minor < Money.parse(policy.minPayoutInr, 'INR').minor) {
      throw new DomainError('INVALID_AMOUNT', `an INR payout must be at least ${policy.minPayoutInr}`);
    }
    const payer = requireOneOf(p.payer, 'payer', ['EXCHANGE_ACCOUNT', 'ROUTE'] as const);

    const { payout } = await effectiveObligations(ctx.tx, trade.id);
    const totals = await legTotals(ctx.tx, trade.id);
    const remaining = payout.minor - totals.committed;
    if (amount.minor > remaining) {
      throw new DomainError('OVER_ALLOCATION', `only ${Money.ofMinor(remaining < 0n ? 0n : remaining, asset).toDecimalString()} ${asset} of this trade is unpaid`, {
        remaining: remaining.toString(), requested: amount.minor.toString(),
      });
    }

    // S8: the destination frozen on the trade must still be the client's active one.
    let destinationBankAccountId: string | null = null;
    let destinationWalletId: string | null = null;
    if (asset === 'INR') {
      destinationBankAccountId = econ.direction === 'SELL_USDT' ? await requireActiveBank(ctx, trade.id) : null;
    } else {
      destinationWalletId = await requireActiveWallet(ctx, trade.id);
    }

    let routeId: string | null = null;
    let inrAccountId: string | null = null;
    let treasuryWalletId: string | null = null;
    let reservationId: string | null = null;
    if (payer === 'ROUTE') {
      if (econ.executionMode !== 'DIRECT_TO_CLIENT') throw new DomainError('ROUTE_PAYER_NOT_ALLOWED', 'this trade’s route settles to the exchange, not to the client');
      const route = await ctx.tx.selectFrom('liquidity_route').select(['id', 'status']).where('id', '=', econ.routeId).forShare().executeTakeFirstOrThrow();
      if (route.status !== 'ACTIVE') throw new DomainError('ROUTE_NOT_USABLE', `route is ${route.status}`);
      routeId = route.id;
    } else if (asset === 'INR') {
      inrAccountId = requireUuid(p.inrAccountId, 'inrAccountId');
      const reserved = await reserveCapacity(ctx, { accountId: inrAccountId, amount: amount as Money<'INR'>, subject: { purpose: 'CLIENT_PAYOUT', tradeId: trade.id } });
      reservationId = reserved.reservationId;
    } else {
      treasuryWalletId = requireUuid(p.treasuryWalletId, 'treasuryWalletId');
      const w = await ctx.tx.selectFrom('treasury_wallet').select(['status', 'role']).where('id', '=', treasuryWalletId).forShare().executeTakeFirstOrThrow();
      if (w.status !== 'ACTIVE') throw new DomainError('TREASURY_WALLET_NOT_ACTIVE', `treasury wallet is ${w.status}`);
    }

    const seq = await nextLegSeq(ctx, trade.id);
    const row = await ctx.tx
      .insertInto('settlement_leg')
      .values({
        trade_id: trade.id,
        seq,
        side: 'EXCHANGE_TO_CLIENT',
        asset,
        amount_minor: amount.minor,
        payer,
        route_id: routeId,
        inr_account_id: inrAccountId,
        capacity_reservation_id: reservationId,
        treasury_wallet_id: treasuryWalletId,
        destination_bank_account_id: destinationBankAccountId,
        destination_wallet_id: destinationWalletId,
        notes: p.notes ? requireText(p.notes, 'notes', 2000) : null,
        created_by: ctx.actor.id ?? 'SYSTEM',
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'leg.created', entityType: 'settlement_leg', entityId: row.id,
      after: { ref: row.ref, trade_id: trade.id, amount, payer, asset, inr_account_id: inrAccountId, route_id: routeId, capacity_reservation_id: reservationId },
    });
    return { legId: row.id, ref: row.ref, remainingAfter: Money.ofMinor(remaining - amount.minor, asset).toDecimalString() };
  });
}

async function requireActiveBank(ctx: TxContext, tradeId: string): Promise<string> {
  const e = await ctx.tx.selectFrom('trade_economics').select('bank_account_id').where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
  if (!e.bank_account_id) throw new DomainError('DESTINATION_INVALID', 'the trade has no payout bank account');
  const b = await ctx.tx.selectFrom('bank_account').select('status').where('id', '=', e.bank_account_id).forShare().executeTakeFirstOrThrow();
  if (b.status !== 'ACTIVE') throw new DomainError('DESTINATION_CHANGED', 'the payout bank account was archived; confirm the new destination first');
  return e.bank_account_id;
}

async function requireActiveWallet(ctx: TxContext, tradeId: string): Promise<string> {
  const e = await ctx.tx.selectFrom('trade_economics').select('crypto_wallet_id').where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
  if (!e.crypto_wallet_id) throw new DomainError('DESTINATION_INVALID', 'the trade has no destination wallet');
  const w = await ctx.tx.selectFrom('crypto_wallet').select('status').where('id', '=', e.crypto_wallet_id).forShare().executeTakeFirstOrThrow();
  if (w.status !== 'ACTIVE') throw new DomainError('DESTINATION_CHANGED', 'the destination wallet was archived; confirm the new destination first');
  return e.crypto_wallet_id;
}

/**
 * `payout_leg.send` (PENDING → PROCESSING). `settlement:send_payout` for an exchange-paid leg, or
 * `settlement:record_route_payout_sent` when the route reports it sent the client directly. Exchange INR
 * consumes the reservation (reserved → used); the trade enters SETTLING on its first payout (T5).
 */
export function sendPayoutLeg(actor: OperatorActor) {
  return {
    authorize: async (ctx: TxContext, p: { legId: string }) => {
      const leg = await ctx.tx.selectFrom('settlement_leg').select('payer').where('id', '=', requireUuid(p.legId, 'legId')).executeTakeFirst();
      if (!leg) throw new DomainError('NOT_FOUND', 'settlement leg not found');
      await authorizeOperator(ctx.tx, actor, leg.payer === 'ROUTE' ? 'settlement:record_route_payout_sent' : 'settlement:send_payout');
    },
    handle: async (ctx: TxContext, p: { legId: string }) => {
      const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', p.legId).executeTakeFirstOrThrow();
      const trade = await lockTrade(ctx.tx, legPeek.trade_id);
      if (trade.hold) throw new DomainError('TRADE_ON_HOLD', 'the trade has an open blocking exception');
      const leg = await lockLeg(ctx, p.legId);
      if (leg.status !== 'PENDING') throw new DomainError('INVALID_TRANSITION', `leg is ${leg.status}`);
      if (leg.side === 'EXCHANGE_TO_CLIENT') await assertNoRefundUnderway(ctx.tx, trade.id);
      if (leg.payer === 'EXCHANGE_ACCOUNT' && leg.asset === 'INR') {
        const account = await ctx.tx.selectFrom('inr_settlement_account').select('status').where('id', '=', leg.inr_account_id!).forShare().executeTakeFirstOrThrow();
        if (account.status !== 'ACTIVE') throw new DomainError('ACCOUNT_NOT_ACTIVE', `INR account is ${account.status}`);
        await consumeReservation(ctx, leg.capacity_reservation_id!, Money.ofMinor(leg.amount_minor, 'INR'));
      }
      await ctx.tx.updateTable('settlement_leg').set({ status: 'PROCESSING', sent_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
      if (trade.lifecycle_state === 'FIRST_LEG_CONFIRMED') await transitionTrade(ctx, trade, 'SETTLING');
      await appendAudit(ctx, { action: 'leg.sent', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PENDING' }, after: { status: 'PROCESSING', payer: leg.payer } });
      return { status: 'PROCESSING' as const, ref: leg.ref };
    },
  };
}

export interface RecordLegEvidencePayload {
  readonly legId: string;
  /** INR legs: the bank reference. */
  readonly rail?: FiatRail;
  readonly utr?: string;
  readonly valueDate?: string | null;
  /** USDT legs: the on-chain transfer. */
  readonly txHash?: string;
  readonly logIndex?: number;
  readonly fromAddress?: string;
  /** Replacing an evidence that was entered wrong needs `settlement:change_utr` and a reason. */
  readonly replaceReason?: string | null;
}

/**
 * `payout_leg.record_evidence` — `settlement:record_utr` (a correction additionally needs `settlement:change_utr`
 * with step-up). Creates the movement and links it to the leg in the CLIENT dimension; a correction voids the
 * previous link (audited) and fails the mis-entered movement, so no UTR is silently reused.
 */
export function recordLegEvidence(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'settlement:record_utr', async (ctx, p: RecordLegEvidencePayload) => {
    const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', requireUuid(p.legId, 'legId')).executeTakeFirstOrThrow();
    const trade = await lockTrade(ctx.tx, legPeek.trade_id);
    const leg = await lockLeg(ctx, p.legId);
    if (leg.status !== 'PENDING' && leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `leg is ${leg.status}`);

    const existing = await ctx.tx
      .selectFrom('transfer_allocation')
      .select(['id', 'transfer_kind', 'fiat_transfer_id', 'crypto_transfer_id'])
      .where('settlement_leg_id', '=', leg.id)
      .where('voided_at', 'is', null)
      .executeTakeFirst();
    if (existing) {
      const reason = requireText(p.replaceReason, 'replaceReason', 500);
      await authorizeOperator(ctx.tx, actor, 'settlement:change_utr');
      await ctx.tx
        .updateTable('transfer_allocation')
        .set({ voided_at: sql<Date>`inrp2p_now()`, voided_by: ctx.actor.id ?? 'SYSTEM', void_reason: reason })
        .where('id', '=', existing.id)
        .execute();
      if (existing.fiat_transfer_id) {
        await ctx.tx
          .updateTable('fiat_transfer')
          .set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: `replaced: ${reason}` })
          .where('id', '=', existing.fiat_transfer_id)
          .where('status', '=', 'RECORDED')
          .execute();
      }
      await appendAudit(ctx, { action: 'utr.changed', entityType: 'settlement_leg', entityId: leg.id, before: { allocation_id: existing.id }, after: { reason } });
    }

    let transferKind: 'FIAT' | 'CRYPTO';
    let transferId: string;
    if (leg.asset === 'INR') {
      const clientId = trade.client_id;
      const destination = await maskedBankDestination(ctx.tx, leg.destination_bank_account_id!);
      const recorded = await recordFiatTransfer(ctx, {
        rail: requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const),
        utr: p.utr ?? '',
        amount: Money.ofMinor(leg.amount_minor, 'INR'),
        payerType: leg.payer === 'ROUTE' ? 'ROUTE' : 'EXCHANGE_ACCOUNT',
        payerId: leg.payer === 'ROUTE' ? leg.route_id! : leg.inr_account_id!,
        payeeType: 'CLIENT_BANK',
        payeeId: clientId,
        destinationMasked: destination,
        valueDate: p.valueDate ?? null,
      });
      transferKind = 'FIAT';
      transferId = recorded.transferId;
    } else {
      const { recordCryptoTransfer } = await import('./movements.ts');
      const wallet = await ctx.tx.selectFrom('crypto_wallet').select('address').where('id', '=', leg.destination_wallet_id!).executeTakeFirstOrThrow();
      // An exchange-paid leg is paid by its own treasury wallet — that is the account the journal will credit — so
      // the sender is that wallet's address, not whatever the screen had selected. Verification then holds the
      // chain to it (FI-24). A route-paid leg names the route's sending address, which the chain also checks.
      const fromAddress = leg.payer === 'EXCHANGE_ACCOUNT'
        ? (await ctx.tx.selectFrom('treasury_wallet').select('address').where('id', '=', leg.treasury_wallet_id!).executeTakeFirstOrThrow()).address
        : requireText(p.fromAddress, 'fromAddress', 64);
      const recorded = await recordCryptoTransfer(ctx, {
        txHash: p.txHash ?? '',
        logIndex: p.logIndex ?? 0,
        tokenContract: deps.chain.tokenContract,
        fromAddress,
        toAddress: wallet.address,
        amount: Money.ofMinor(leg.amount_minor, 'USDT'),
        payerType: leg.payer === 'ROUTE' ? 'ROUTE' : 'EXCHANGE_TREASURY',
        payerId: leg.payer === 'ROUTE' ? leg.route_id : leg.treasury_wallet_id,
        payeeType: 'CLIENT_WALLET',
        payeeId: trade.client_id,
        source: 'OPERATOR_SUBMITTED',
      });
      transferKind = 'CRYPTO';
      transferId = recorded.transferId;
    }

    await ctx.tx
      .insertInto('transfer_allocation')
      .values({
        transfer_kind: transferKind,
        fiat_transfer_id: transferKind === 'FIAT' ? transferId : null,
        crypto_transfer_id: transferKind === 'CRYPTO' ? transferId : null,
        dimension: 'CLIENT',
        settlement_leg_id: leg.id,
        amount_minor: leg.amount_minor,
        allocated_by: ctx.actor.id ?? 'SYSTEM',
      })
      .execute();
    return { legId: leg.id, transferKind, transferId };
  });
}

/** `payout_leg.cancel` (PENDING → CANCELLED) — `settlement:cancel_payout` (⧗). Releases the reservation. */
export function cancelPayoutLeg(actor: OperatorActor) {
  return operatorCommand(actor, 'settlement:cancel_payout', async (ctx, p: { legId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', requireUuid(p.legId, 'legId')).executeTakeFirstOrThrow();
    await lockTrade(ctx.tx, legPeek.trade_id);
    const leg = await lockLeg(ctx, p.legId);
    if (leg.status !== 'PENDING') throw new DomainError('INVALID_TRANSITION', `only a PENDING leg can be cancelled (leg is ${leg.status})`);
    await ctx.tx.updateTable('settlement_leg').set({ status: 'CANCELLED', cancelled_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
    if (leg.capacity_reservation_id) await releaseReservation(ctx, leg.capacity_reservation_id, 'LEG_CANCELLED');
    await appendAudit(ctx, { action: 'leg.cancelled', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PENDING' }, after: { status: 'CANCELLED', reason } });
    return { status: 'CANCELLED' as const };
  });
}

/**
 * `payout_leg.fail` (PROCESSING → FAILED) — `settlement:fail_payout` (⧗). The money never left: the movement is
 * marked FAILED, consumed capacity is returned to the day, and a `BANK_TRANSFER_FAILED` case asks for a
 * replacement leg. No journal is posted — a failed movement never had one (FI-27).
 */
export function failPayoutLeg(actor: OperatorActor) {
  return operatorCommand(actor, 'settlement:fail_payout', async (ctx, p: { legId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', requireUuid(p.legId, 'legId')).executeTakeFirstOrThrow();
    await lockTrade(ctx.tx, legPeek.trade_id);
    const leg = await lockLeg(ctx, p.legId);
    if (leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `leg is ${leg.status}`);
    const allocation = await ctx.tx
      .selectFrom('transfer_allocation')
      .select(['fiat_transfer_id', 'crypto_transfer_id'])
      .where('settlement_leg_id', '=', leg.id)
      .where('voided_at', 'is', null)
      .executeTakeFirst();
    if (allocation?.fiat_transfer_id) {
      const { markFiatFailed } = await import('./movements.ts');
      await markFiatFailed(ctx, allocation.fiat_transfer_id, reason);
    }
    if (allocation?.crypto_transfer_id) {
      // A transfer the chain has already made final did leave the treasury: failing its leg would leave that money
      // with no journal and invite a replacement payout on top of it (FI-25). It is confirmed, not failed.
      const c = await ctx.tx.selectFrom('crypto_transfer').select('state').where('id', '=', allocation.crypto_transfer_id).executeTakeFirstOrThrow();
      if (c.state === 'CONFIRMED') throw new DomainError('TRANSFER_ALREADY_CONFIRMED', 'the chain has confirmed this payout; confirm the leg instead of failing it');
    }
    await ctx.tx
      .updateTable('settlement_leg')
      .set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: reason })
      .where('id', '=', leg.id)
      .execute();
    if (leg.capacity_reservation_id) {
      await refundConsumedCapacity(ctx, { reservationId: leg.capacity_reservation_id, amount: Money.ofMinor(leg.amount_minor, 'INR'), reason: 'LEG_FAILED' });
    }
    await appendAudit(ctx, { action: 'leg.failed', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PROCESSING' }, after: { status: 'FAILED', reason } });
    await openExceptionInTx(ctx, {
      type: 'BANK_TRANSFER_FAILED', subjectType: 'SETTLEMENT_LEG', subjectId: leg.id, tradeId: leg.trade_id,
      detectedBy: 'OPERATOR', details: { reason, amount: Money.ofMinor(leg.amount_minor, leg.asset).toDecimalString(), ref: leg.ref },
    });
    await enqueueOutbox(ctx, { type: 'desk.leg_failed', aggregateType: 'settlement_leg', aggregateId: leg.id, payload: { legId: leg.id, tradeId: leg.trade_id } });
    return { status: 'FAILED' as const };
  });
}
