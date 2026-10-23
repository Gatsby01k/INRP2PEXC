import { sql } from 'kysely';
import { DomainError, Money, normalizeTronAddress, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { planChainSend, signablePathOf } from '@inrp2p/network';
import { assertPayoutsOpen, lockTrade } from '@inrp2p/trades';
import { assertPhysicallyAvailable } from './availability.ts';
import { fundingSources, settleFunding, tronLocation } from './funding.ts';
import { locateTransferLog, lockMovement, postMovement, recordCryptoTransfer, verifyCryptoTransfer } from './movements.ts';
import type { SettlementDeps } from './policy.ts';

/**
 * INRP2P's earnings off the deal addresses (block 10, TD-36; ADR 0020 §2.16). A completed trade leaves its USDT margin —
 * a desk's deal, the platform fee — at the deal address its money moved through. Once no trade uses the address and what
 * completed trades earned there is worth a transfer, the signer sweeps it, in one send, to the platform's revenue wallet:
 * each trade's part earmarked from its own sources (never beyond its margin, never a cancelled trade's money, IX130), the
 * TRX from the platform's own budget. The books move it between two of the exchange's own treasury accounts.
 */

export interface SweepableTrade {
  readonly tradeId: string;
  readonly completedAt: Date | null;
  readonly sweepableMinor: bigint;
}

/** What each completed trade earned at an address and may give up now, latest completed first. */
export async function sweepableTradesAt(ex: Executor, address: string): Promise<SweepableTrade[]> {
  const location = tronLocation(normalizeTronAddress(address));
  const r = await sql<{ trade_id: string; completed_at: Date | null; n: string }>`
    select t.id as trade_id, t.completed_at, inrp2p_trade_sweepable(t.id, ${location})::text as n
      from trade t
     where t.id in (select s.trade_id from funding_source s where s.asset = 'USDT' and s.location = ${location})
     order by t.completed_at desc nulls last, t.id`.execute(ex);
  return r.rows.map((x) => ({ tradeId: x.trade_id, completedAt: x.completed_at, sweepableMinor: BigInt(x.n) })).filter((x) => x.sweepableMinor > 0n);
}

/** The platform's revenue wallet, if one is registered and active. */
export async function revenueWallet(ex: Executor): Promise<{ id: string; address: string; label: string } | null> {
  return (await ex.selectFrom('treasury_wallet').select(['id', 'address', 'label']).where('role', '=', 'REVENUE').where('status', '=', 'ACTIVE').executeTakeFirst()) ?? null;
}

/**
 * Plans the sweep of an address: every completed trade's earnings there, when they add up to at least `minMinor`. Null
 * when there is nothing to do yet (too little, a send of the address still open). The caller has just observed the
 * address (B2). Refused when no revenue wallet is registered, the address is in use or the signer does not hold it.
 */
export async function planFeeSweepInTx(ctx: TxContext, deps: Pick<SettlementDeps, 'policy'>, input: { readonly address: string; readonly minMinor: bigint; readonly requestedBy: string }): Promise<{ sendId: string; ref: string; amount: string } | null> {
  await assertPayoutsOpen(ctx.tx);
  const address = normalizeTronAddress(input.address);
  const deposit = await ctx.tx.selectFrom('deposit_address').select(['id', 'status', 'treasury_wallet_id']).where('network', '=', 'TRON').where('address', '=', address).executeTakeFirst();
  if (!deposit) throw new DomainError('NOT_FOUND', 'not a deal address');
  if (deposit.status === 'ASSIGNED') throw new DomainError('INVALID_TRANSITION', 'a trade is using this address; it is swept once it is free');
  if (!(await signablePathOf(ctx.tx, address))) throw new DomainError('CUSTODY_PATH_REFUSED', `${address} is not an address the exchange's signer holds`);
  const wallet = await revenueWallet(ctx.tx);
  if (!wallet) throw new DomainError('WALLET_NOT_ACTIVE', 'no revenue wallet is registered: earnings stay at their deal addresses until one is');
  const live = await ctx.tx.selectFrom('chain_send').select('ref').where('from_address', '=', address).where('status', 'not in', ['CONFIRMED', 'CANCELLED']).executeTakeFirst();
  if (live) return null;

  const trades = await sweepableTradesAt(ctx.tx, address);
  const total = trades.reduce((t, x) => t + x.sweepableMinor, 0n);
  if (total <= 0n || total < input.minMinor) return null;
  const amount = Money.ofMinor(total, 'USDT');
  await assertPhysicallyAvailable(ctx, deps, { address, amount });
  // The send names the latest trade it carries the earnings of: the lock its signing takes, the key it is planned under.
  const anchor = trades[0]!;
  const send = await planChainSend(ctx, {
    purpose: 'FEE_SWEEP', asset: 'USDT', tradeId: anchor.tradeId, fromAddress: address, toAddress: wallet.address, amountMinor: total,
    funder: null, bearer: 'PLATFORM', needsApproval: false, requestedBy: input.requestedBy,
  });

  // Each trade's part, from its own sources at the address, oldest money first.
  const location = tronLocation(address);
  for (const t of trades) {
    let left = t.sweepableMinor;
    for (const s of await fundingSources(ctx.tx, t.tradeId, { asset: 'USDT' })) {
      if (left === 0n) break;
      if (s.location !== location || s.availableMinor <= 0n) continue;
      const take = s.availableMinor < left ? s.availableMinor : left;
      await ctx.tx
        .insertInto('funding_allocation')
        .values({
          trade_id: t.tradeId, source_kind: s.kind,
          source_leg_id: s.kind === 'CLIENT_FUNDS' ? s.sourceId : null,
          source_route_settlement_id: s.kind === 'COUNTERPARTY_FUNDS' ? s.sourceId : null,
          use_kind: 'FEE_SWEEP', use_chain_send_id: send.sendId, asset: 'USDT', amount_minor: take, location,
          created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
        })
        .execute();
      left -= take;
    }
    if (left !== 0n) throw new DomainError('FUNDING_INSUFFICIENT', `trade ${t.tradeId} has less free at ${address} than it earned there`);
  }
  await appendAudit(ctx, {
    action: 'fee_sweep.planned', entityType: 'chain_send', entityId: send.sendId,
    after: { ref: send.ref, from: address, to: wallet.address, amount, trades: trades.map((t) => ({ trade_id: t.tradeId, amount: Money.ofMinor(t.sweepableMinor, 'USDT') })) },
  });
  return { sendId: send.sendId, ref: send.ref, amount: amount.toDecimalString() };
}

/**
 * `fee_sweep.plan` — `network:manage` (⧗). A person sweeps one address now, whatever it holds of earnings: the
 * threshold is the worker's economy, not a rule. The platform's budget must have the TRX.
 */
export function sweepAddressNow(actor: OperatorActor, deps: Pick<SettlementDeps, 'policy'>) {
  return operatorCommand(actor, 'network:manage', async (ctx, p: { address: string }) => {
    const out = await planFeeSweepInTx(ctx, deps, { address: p.address, minMinor: 1n, requestedBy: ctx.actor.id ?? 'SYSTEM' });
    if (!out) throw new DomainError('INVALID_TRANSITION', 'nothing of INRP2P\'s is free at this address now, or a send of it is still open');
    return out;
  });
}

/** A sweep the chain made final: its own movement, the earmarks consumed, and the one journal between treasury accounts. */
export async function settleFeeSweepInTx(
  ctx: TxContext,
  deps: SettlementDeps,
  send: { readonly id: string; readonly ref: string; readonly trade_id: string | null; readonly from_address: string; readonly to_address: string; readonly amount_minor: bigint },
  txid: string,
): Promise<{ readonly transferId: string }> {
  await lockTrade(ctx.tx, requireUuid(send.trade_id, 'tradeId'));
  const deposit = await ctx.tx.selectFrom('deposit_address').select('treasury_wallet_id').where('network', '=', 'TRON').where('address', '=', send.from_address).executeTakeFirstOrThrow();
  const wallet = await ctx.tx.selectFrom('treasury_wallet').select(['id', 'role']).where('network', '=', 'TRON').where('address', '=', send.to_address).executeTakeFirstOrThrow();
  if (wallet.role !== 'REVENUE') throw new DomainError('INVALID_ARGUMENT', 'a fee sweep lands only in the revenue wallet');
  const located = await locateTransferLog(deps, { txHash: txid, from: send.from_address, to: [send.to_address], amountMinor: send.amount_minor });
  const amount = Money.ofMinor(send.amount_minor, 'USDT');
  const recorded = await recordCryptoTransfer(ctx, {
    txHash: txid, logIndex: located.logIndex, tokenContract: deps.chain.tokenContract, fromAddress: send.from_address, toAddress: send.to_address,
    amount, payerType: 'EXCHANGE_TREASURY', payerId: deposit.treasury_wallet_id, payeeType: 'EXCHANGE_TREASURY', payeeId: wallet.id, source: 'CUSTODY_SIGNER',
  });
  await ctx.tx.updateTable('chain_send').set({ crypto_transfer_id: recorded.transferId, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
  await lockMovement(ctx, 'CRYPTO', recorded.transferId);
  const verified = await verifyCryptoTransfer(ctx, deps, recorded.transferId);
  if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason ?? 'the sweep is not final on chain');
  await postMovement(ctx, {
    kind: 'CRYPTO', movementId: recorded.transferId, amount,
    from: { kind: 'EXCHANGE_TREASURY', walletId: deposit.treasury_wallet_id }, to: { kind: 'EXCHANGE_TREASURY', walletId: wallet.id },
    tradeId: null, purpose: 'FEE_SWEEP',
  });
  await settleFunding(ctx, { kind: 'FEE_SWEEP', chainSendId: send.id }, 'CONSUMED', `fee sweep ${send.ref} confirmed on chain`);
  await appendAudit(ctx, { action: 'fee_sweep.confirmed', entityType: 'chain_send', entityId: send.id, after: { ref: send.ref, amount, transfer_id: recorded.transferId, to: send.to_address } });
  return { transferId: recorded.transferId };
}
