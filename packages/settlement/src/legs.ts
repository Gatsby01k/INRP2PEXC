import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type AssetCode, type Executor, type LegPayer, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { assertPayoutsOpen, effectiveObligations, isCounterpartyFunded, legTotals, lockTrade, tradeEconomics, transitionTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';
import { allocateFunding, earmarkSendNetwork, settleFunding, tronLocation } from './funding.ts';
import { assertPhysicallyAvailable } from './availability.ts';
import { type SettlementDeps, policyOf } from './policy.ts';
import { payoutNeedsSecondPerson } from './approvals.ts';
import { escrowSendFee, planChainSend, signablePathOf, tradeHold } from '@inrp2p/network';

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
  // An excess refund (D2) returns money beyond the receivable; the trade goes on, and so may its payout.
  const refund = await ex.selectFrom('settlement_leg').select('ref').where('trade_id', '=', tradeId).where('side', '=', 'REFUND_TO_CLIENT')
    .where('status', 'in', ['PENDING', 'PROCESSING', 'COMPLETED']).where((eb) => eb.or([eb('refund_kind', 'is', null), eb('refund_kind', '=', 'UNWIND')])).executeTakeFirst();
  if (refund) throw new DomainError('REFUND_IN_PROGRESS', `refund ${refund.ref} is planned or done for this trade; cancel it before paying out`);
}

export async function assertNoPayoutUnderway(ex: Executor, tradeId: string): Promise<void> {
  const payout = await ex.selectFrom('settlement_leg').select(['ref', 'status']).where('trade_id', '=', tradeId).where('side', '=', 'EXCHANGE_TO_CLIENT')
    .where('status', 'in', ['PROCESSING', 'COMPLETED']).executeTakeFirst();
  if (!payout) return;
  if (payout.status === 'COMPLETED') throw new DomainError('PAYOUT_ALREADY_CONFIRMED', 'a payout was already confirmed; correct it with a financial adjustment');
  throw new DomainError('PAYOUT_IN_FLIGHT', `payout ${payout.ref} is already sent; confirm or fail it before refunding`);
}

/** The on-chain address an exchange-paid USDT leg sends from: its source deposit address, else its treasury wallet. */
export async function legSourceAddress(ctx: TxContext, leg: { source_deposit_address_id: string | null; treasury_wallet_id: string | null }): Promise<string> {
  if (leg.source_deposit_address_id) {
    return (await ctx.tx.selectFrom('deposit_address').select('address').where('id', '=', leg.source_deposit_address_id).executeTakeFirstOrThrow()).address;
  }
  return (await ctx.tx.selectFrom('treasury_wallet').select('address').where('id', '=', leg.treasury_wallet_id!).executeTakeFirstOrThrow()).address;
}

export async function lockLeg(ctx: TxContext, legId: string) {
  assertLockOrder(ctx.tx, 'settlement_leg');
  const rows = await sql<{
    id: string; trade_id: string; seq: number; ref: string; side: string; asset: AssetCode; amount_minor: bigint; status: string;
    payer: LegPayer; route_id: string | null; treasury_wallet_id: string | null;
    source_deposit_address_id: string | null; destination_bank_account_id: string | null; destination_wallet_id: string | null;
    created_by: string; sent_by: string | null; refund_kind: 'UNWIND' | 'EXCESS' | null;
  }>`select id, trade_id, seq, ref, side, asset, amount_minor, status, payer, route_id, treasury_wallet_id,
            source_deposit_address_id, destination_bank_account_id, destination_wallet_id, created_by, sent_by, refund_kind
       from settlement_leg where id = ${requireUuid(legId, 'legId')} for update`.execute(ctx.tx);
  const leg = rows.rows[0];
  if (!leg) throw new DomainError('NOT_FOUND', 'settlement leg not found');
  return leg;
}

export interface CreatePayoutLegPayload {
  readonly tradeId: string;
  /** Decimal amount in the payout asset (SELL: INR, BUY: USDT). */
  readonly amount: string;
  /** `ROUTE`: the trader pays the client its rupees. `EXCHANGE_ACCOUNT`: the signer pays the client USDT out of the escrow. */
  readonly payer: 'EXCHANGE_ACCOUNT' | 'ROUTE';
  /**
   * A USDT payout (D-16): sent from the deposit address where the trader's USDT arrived. The leg's ledger account is that
   * address's treasury wallet.
   */
  readonly sourceDepositAddressId?: string | null;
  readonly notes?: string | null;
}

/** The deposit address a USDT outflow leaves from, with the treasury wallet it belongs to (its ledger account). */
export async function requireSourceDepositAddress(ctx: TxContext, depositAddressId: string): Promise<{ id: string; address: string; treasuryWalletId: string }> {
  const d = await ctx.tx
    .selectFrom('deposit_address as d')
    .innerJoin('treasury_wallet as w', 'w.id', 'd.treasury_wallet_id')
    .select(['d.id', 'd.address', 'd.treasury_wallet_id', 'w.status as wallet_status'])
    .where('d.id', '=', requireUuid(depositAddressId, 'sourceDepositAddressId'))
    .executeTakeFirst();
  if (!d) throw new DomainError('NOT_FOUND', 'source deposit address not found');
  if (d.wallet_status !== 'ACTIVE') throw new DomainError('TREASURY_WALLET_NOT_ACTIVE', `the deposit address's treasury wallet is ${d.wallet_status}`);
  return { id: d.id, address: d.address, treasuryWalletId: d.treasury_wallet_id };
}

/**
 * `payout_leg.create` (STATE_MACHINES §4 create → PENDING), with no actor policy of its own: the signer's driver as the
 * system (ADR 0017), a trader's filed payment (ADR 0019). Checks D-12 (the client leg must be confirmed) and FI-20
 * (committed legs ≤ effective obligation). A USDT leg is earmarked in full against what the trader delivered into the
 * escrow it is paid from (D-16, FI-72): no counterparty money, no payout.
 */
export async function createPayoutLegInTx(ctx: TxContext, deps: Pick<SettlementDeps, 'policy'>, p: CreatePayoutLegPayload): Promise<{ legId: string; ref: string; remainingAfter: string }> {
    const policy = policyOf(deps);
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
      destinationBankAccountId = await requireActiveBank(ctx, trade.id);
    } else {
      destinationWalletId = await requireActiveWallet(ctx, trade.id);
    }

    let routeId: string | null = null;
    let treasuryWalletId: string | null = null;
    let sourceDepositAddressId: string | null = null;
    let sourceAddress: string | null = null;
    if (payer === 'ROUTE') {
      const route = await ctx.tx.selectFrom('liquidity_route').select(['id', 'status']).where('id', '=', econ.routeId).forShare().executeTakeFirstOrThrow();
      if (route.status !== 'ACTIVE') throw new DomainError('ROUTE_NOT_USABLE', `route is ${route.status}`);
      routeId = route.id;
    } else {
      if (asset !== 'USDT') throw new DomainError('INVALID_ARGUMENT', 'INRP2P holds no rupees to pay a client with: its trader pays them');
      const source = await requireSourceDepositAddress(ctx, requireUuid(p.sourceDepositAddressId, 'sourceDepositAddressId'));
      sourceDepositAddressId = source.id;
      sourceAddress = source.address;
      treasuryWalletId = source.treasuryWalletId;
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
        treasury_wallet_id: treasuryWalletId,
        source_deposit_address_id: sourceDepositAddressId,
        destination_bank_account_id: destinationBankAccountId,
        destination_wallet_id: destinationWalletId,
        notes: p.notes ? requireText(p.notes, 'notes', 2000) : null,
        created_by: ctx.actor.id ?? 'SYSTEM',
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    if (payer === 'EXCHANGE_ACCOUNT' && (await isCounterpartyFunded(ctx.tx, trade.id))) {
      await allocateFunding(ctx, {
        tradeId: trade.id,
        use: { kind: 'CLIENT_PAYOUT', legId: row.id },
        asset,
        amount,
        location: tronLocation(sourceAddress!),
      });
    }
    await appendAudit(ctx, {
      action: 'leg.created', entityType: 'settlement_leg', entityId: row.id,
      after: { ref: row.ref, trade_id: trade.id, amount, payer, asset, route_id: routeId, source_deposit_address_id: sourceDepositAddressId },
    });
    return { legId: row.id, ref: row.ref, remainingAfter: Money.ofMinor(remaining - amount.minor, asset).toDecimalString() };
}

/**
 * Where a trade pays now (D1): its latest approved destination change, else what it was accepted with
 * (`trade_economics` stays as it was). The database applies the same rule to every payout leg (IX092).
 */
export async function tradePayoutDestination(ex: Executor, tradeId: string): Promise<{ bankAccountId: string | null; walletId: string | null }> {
  const r = await sql<{ bank_account_id: string | null; wallet_id: string | null }>`select bank_account_id, wallet_id from inrp2p_trade_payout_destination(${tradeId}::uuid)`.execute(ex);
  return { bankAccountId: r.rows[0]?.bank_account_id ?? null, walletId: r.rows[0]?.wallet_id ?? null };
}

async function requireActiveBank(ctx: TxContext, tradeId: string): Promise<string> {
  const { bankAccountId } = await tradePayoutDestination(ctx.tx, tradeId);
  if (!bankAccountId) throw new DomainError('DESTINATION_INVALID', 'the trade has no payout bank account');
  const b = await ctx.tx.selectFrom('bank_account').select('status').where('id', '=', bankAccountId).forShare().executeTakeFirstOrThrow();
  if (b.status !== 'ACTIVE') throw new DomainError('DESTINATION_CHANGED', 'the payout bank account was archived; confirm the new destination first');
  return bankAccountId;
}

async function requireActiveWallet(ctx: TxContext, tradeId: string): Promise<string> {
  const { walletId } = await tradePayoutDestination(ctx.tx, tradeId);
  if (!walletId) throw new DomainError('DESTINATION_INVALID', 'the trade has no destination wallet');
  const w = await ctx.tx.selectFrom('crypto_wallet').select('status').where('id', '=', walletId).forShare().executeTakeFirstOrThrow();
  if (w.status !== 'ACTIVE') throw new DomainError('DESTINATION_CHANGED', 'the destination wallet was archived; confirm the new destination first');
  return walletId;
}

/**
 * The sending itself (PENDING → PROCESSING, the trade enters SETTLING on its first payout, T5), with no actor policy of
 * its own. A USDT payout from an address the
 * exchange's signer holds is not sent by hand: marking it sent plans the signer's send (ADR 0017 §4) — waiting for a
 * second person first when the payout is above the approval threshold (C1) — and the chain's answer confirms it.
 */
export async function sendPayoutLegInTx(ctx: TxContext, deps: Pick<SettlementDeps, 'policy'>, legId: string): Promise<{ status: 'PROCESSING'; ref: string; sendRef: string | null }> {
      const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', requireUuid(legId, 'legId')).executeTakeFirstOrThrow();
      const trade = await lockTrade(ctx.tx, legPeek.trade_id);
      if (trade.hold) throw new DomainError('TRADE_ON_HOLD', 'the trade has an open blocking exception');
      const leg = await lockLeg(ctx, legId);
      if (leg.status !== 'PENDING') throw new DomainError('INVALID_TRANSITION', `leg is ${leg.status}`);
      // E4: after a restore the exchange pays nothing until the records are reconciled (migration 0034, IX100). A trader
      // reporting its own payment is evidence, not an instruction, and is recorded as usual.
      if (leg.payer === 'EXCHANGE_ACCOUNT') await assertPayoutsOpen(ctx.tx);
      if (leg.side === 'EXCHANGE_TO_CLIENT') await assertNoRefundUnderway(ctx.tx, trade.id);
      let sourceAddress: string | null = null;
      if (leg.payer === 'EXCHANGE_ACCOUNT' && leg.asset === 'USDT') {
        // B2: USDT leaves only an address a fresh reading of the chain shows holding it, after every outflow from that
        // address the reading does not show yet.
        sourceAddress = await legSourceAddress(ctx, leg);
        // Out of a GasFree account the payout's own network leaves with it (ADR 0022).
        const network = await escrowSendFee(ctx.tx, { tradeId: trade.id, fromAddress: sourceAddress });
        await assertPhysicallyAvailable(ctx, deps, { address: sourceAddress, amount: Money.ofMinor(leg.amount_minor + network, 'USDT'), excludeLegId: leg.id });
      }
      // C1: who marked it sent is recorded from the verified actor — the person who may not confirm it above the
      // approval threshold.
      const sentBy = ctx.actor.id ?? `SYSTEM:${ctx.commandName}`;
      await ctx.tx.updateTable('settlement_leg').set({ status: 'PROCESSING', sent_at: sql<Date>`inrp2p_now()`, sent_by: sentBy }).where('id', '=', leg.id).execute();
      if (trade.lifecycle_state === 'FIRST_LEG_CONFIRMED') await transitionTrade(ctx, trade, 'SETTLING');
      let sendRef: string | null = null;
      if (sourceAddress && leg.side === 'EXCHANGE_TO_CLIENT' && (await signablePathOf(ctx.tx, sourceAddress)) && (await tradeHold(ctx.tx, trade.id))) {
        const hold = (await tradeHold(ctx.tx, trade.id))!;
        const wallet = await ctx.tx.selectFrom('crypto_wallet').select('address').where('id', '=', leg.destination_wallet_id!).executeTakeFirstOrThrow();
        // Whoever owns the client paid for its payout: the trader (0040, a desk: ADR 0022), or INRP2P on its own deal.
        const planned = await planChainSend(ctx, {
          purpose: 'CLIENT_PAYOUT', asset: 'USDT', tradeId: trade.id, legId: leg.id, fromAddress: sourceAddress, toAddress: wallet.address, amountMinor: leg.amount_minor,
          funder: hold.trader_id, bearer: hold.trader_id ? 'TRADER' : 'PLATFORM', needsApproval: await payoutNeedsSecondPerson(ctx.tx, leg), requestedBy: sentBy,
        });
        await earmarkSendNetwork(ctx, planned.sendId);
        sendRef = planned.ref;
      }
      await appendAudit(ctx, { action: 'leg.sent', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PENDING' }, after: { status: 'PROCESSING', payer: leg.payer, sent_by: sentBy, chain_send: sendRef } });
      return { status: 'PROCESSING' as const, ref: leg.ref, sendRef };
}

/**
 * The failing itself (PROCESSING → FAILED): the money provably never left. A case asks for a replacement leg — unless
 * nothing replaces it: a P2P trader's payment INRP2P found never arrived unwinds the deal instead (`replacement: false`).
 */
export async function failPayoutLegInTx(ctx: TxContext, legId: string, reason: string, opts: { readonly replacement?: boolean } = {}): Promise<{ status: 'FAILED' }> {
    const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', requireUuid(legId, 'legId')).executeTakeFirstOrThrow();
    await lockTrade(ctx.tx, legPeek.trade_id);
    const leg = await lockLeg(ctx, legId);
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
    // The bank (or the chain) says the money did not leave: its earmark is free for a replacement leg.
    await settleFunding(ctx, { kind: leg.side === 'REFUND_TO_CLIENT' ? 'REFUND' : 'CLIENT_PAYOUT', legId: leg.id }, 'RELEASED', `leg failed: ${reason}`);
    await appendAudit(ctx, { action: 'leg.failed', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PROCESSING' }, after: { status: 'FAILED', reason } });
    if (opts.replacement ?? true) {
      await openExceptionInTx(ctx, {
        type: 'BANK_TRANSFER_FAILED', subjectType: 'SETTLEMENT_LEG', subjectId: leg.id, tradeId: leg.trade_id,
        detectedBy: 'OPERATOR', details: { reason, amount: Money.ofMinor(leg.amount_minor, leg.asset).toDecimalString(), ref: leg.ref },
      });
    }
    await enqueueOutbox(ctx, { type: 'desk.leg_failed', aggregateType: 'settlement_leg', aggregateId: leg.id, payload: { legId: leg.id, tradeId: leg.trade_id } });
    return { status: 'FAILED' as const };
}
