import { sql } from 'kysely';
import { DomainError, Money, normalizeTronAddress, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { networkSettleJournal, postJournal } from '@inrp2p/ledger';
import { networkFeePolicy } from './policy.ts';

/**
 * GasFree (docs/adr/0022-usdt-network-fees.md): what the controller charges, the network a P2P deal carries in USDT, the
 * fee cap of each send out of a GasFree account, and the deal's allowance held and settled at cost. The worker reads the
 * fees from the chain and signs the permits; the web app only reads what was recorded.
 */

// ---- fees -------------------------------------------------------------------------------------------------------

export interface GasFreeFees {
  readonly id: string;
  readonly transferFeeMinor: bigint;
  readonly activateFeeMinor: bigint;
  readonly observedAt: Date;
  readonly ageSeconds: number;
}

/** One reading of the controller's USDT fees, as the worker read them on chain (`gasfree_fee_refresh`). */
export async function recordGasFreeFees(ctx: TxContext, input: { controller: string; token: string; transferFeeMinor: bigint; activateFeeMinor: bigint }): Promise<{ readingId: string }> {
  const row = await ctx.tx
    .insertInto('gasfree_fee_reading')
    .values({
      controller: normalizeTronAddress(input.controller), token: normalizeTronAddress(input.token), transfer_fee_minor: input.transferFeeMinor,
      activate_fee_minor: input.activateFeeMinor, observed_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'network.gasfree_fees_observed', entityType: 'gasfree_fee_reading', entityId: row.id,
    after: { transfer: Money.ofMinor(input.transferFeeMinor, 'USDT'), activation: Money.ofMinor(input.activateFeeMinor, 'USDT') },
  });
  return { readingId: row.id };
}

/** The latest reading, with its age by the business clock; null when GasFree's fees were never read. */
export async function latestGasFreeFees(ex: Executor): Promise<GasFreeFees | null> {
  const r = await sql<{ id: string; transfer_fee_minor: bigint; activate_fee_minor: bigint; observed_at: Date; age: string }>`
    select id, transfer_fee_minor, activate_fee_minor, observed_at, floor(greatest(extract(epoch from (inrp2p_now() - observed_at)), 0))::bigint::text as age
      from gasfree_fee_reading order by observed_at desc, id desc limit 1`.execute(ex);
  const x = r.rows[0];
  return x ? { id: x.id, transferFeeMinor: BigInt(x.transfer_fee_minor), activateFeeMinor: BigInt(x.activate_fee_minor), observedAt: x.observed_at, ageSeconds: Number.parseInt(x.age, 10) } : null;
}

/** The fees a quote may be priced on now: a reading within the policy's age, or `NETWORK_FEES_UNKNOWN`. */
export async function currentGasFreeFees(ex: Executor): Promise<GasFreeFees> {
  const [fees, policy] = await Promise.all([latestGasFreeFees(ex), networkFeePolicy(ex)]);
  if (!fees || fees.ageSeconds > policy.gasfreeFeeMaxAgeSeconds) {
    throw new DomainError('NETWORK_FEES_UNKNOWN', `GasFree's fees were not read in the last ${policy.gasfreeFeeMaxAgeSeconds}s: the worker reads them (gasfree_fee_refresh)`);
  }
  return fees;
}

// ---- what a deal carries -------------------------------------------------------------------------------------------

/**
 * A P2P deal's network in USDT (ADR 0022 §2.2), before its economics: its own path at the fees in force — the payout,
 * which activates the deal's GasFree account, and the sweep of INRP2P's fee. Carried by whoever owns the client: a desk's
 * deal in its USDT side (`funderTraderId` = the desk's trader), INRP2P's own deal out of its margin (null).
 */
export interface UsdtNetworkTerms {
  readonly funderTraderId: string | null;
  readonly readingId: string;
  readonly transferFeeMinor: bigint;
  readonly activateFeeMinor: bigint;
  readonly allowanceUsdtMinor: bigint;
  readonly minNetMarginInrMinor: bigint;
}

export const allowanceOf = (fees: { readonly transferFeeMinor: bigint; readonly activateFeeMinor: bigint }): bigint => fees.activateFeeMinor + 2n * fees.transferFeeMinor;

export async function usdtNetworkTerms(ex: Executor, input: { funderTraderId: string | null }): Promise<UsdtNetworkTerms> {
  const [fees, policy] = await Promise.all([currentGasFreeFees(ex), networkFeePolicy(ex)]);
  return {
    funderTraderId: input.funderTraderId, readingId: fees.id, transferFeeMinor: fees.transferFeeMinor, activateFeeMinor: fees.activateFeeMinor,
    allowanceUsdtMinor: allowanceOf(fees), minNetMarginInrMinor: policy.minNetMarginInrMinor,
  };
}

// ---- sends ------------------------------------------------------------------------------------------------------

/** The HD key that owns a deal address when it is a GasFree account; null for a plain HD address. */
export async function gasFreeOwnerOf(ex: Executor, address: string): Promise<string | null> {
  const r = await ex.selectFrom('deposit_address').select('owner_address').where('network', '=', 'TRON').where('address', '=', normalizeTronAddress(address)).executeTakeFirst();
  return r?.owner_address ?? null;
}

/**
 * The fee cap of a send out of a GasFree account (ADR 0022 §2.3): one transfer at the fees its trade was priced on, and
 * the account's activation unless one of its permits already executed. It is the permits' `maxFee`.
 */
export async function gasFreeSendCap(ex: Executor, input: { tradeId: string; fromAddress: string }): Promise<bigint> {
  const terms = await ex
    .selectFrom('trade as t')
    .innerJoin('quote_network_fee as f', 'f.quote_id', 't.quote_id')
    .select(['f.unit', 'f.transfer_fee_usdt_minor', 'f.activate_fee_usdt_minor'])
    .where('t.id', '=', requireUuid(input.tradeId, 'tradeId'))
    .executeTakeFirst();
  if (!terms || terms.unit !== 'USDT') throw new DomainError('INVALID_ARGUMENT', `trade ${input.tradeId} was not priced on GasFree: it has no USDT network terms`);
  const active = await ex.selectFrom('gasfree_permit').select('id').where('gasfree_address', '=', normalizeTronAddress(input.fromAddress)).where('status', '=', 'CONFIRMED').executeTakeFirst();
  return terms.transfer_fee_usdt_minor! + (active ? 0n : terms.activate_fee_usdt_minor!);
}

/** What a send from `fromAddress` of a trade leaves for its own network: its fee cap from a GasFree account, else nothing. */
export async function escrowSendFee(ex: Executor, input: { tradeId: string; fromAddress: string }): Promise<bigint> {
  return (await gasFreeOwnerOf(ex, input.fromAddress)) ? gasFreeSendCap(ex, input) : 0n;
}

// ---- the deal's allowance -----------------------------------------------------------------------------------------

/** Holds a GasFree-priced trade's network at acceptance (FI-103): the allowance its escrow carries — nobody else's money. */
export async function holdUsdtNetwork(ctx: TxContext, input: { tradeId: string; funderTraderId: string | null; allowanceUsdtMinor: bigint }): Promise<{ holdId: string }> {
  const row = await ctx.tx
    .insertInto('network_budget_hold')
    .values({ trade_id: requireUuid(input.tradeId, 'tradeId'), trader_id: input.funderTraderId, unit: 'USDT', sends: 2, deal_funded_usdt_minor: input.allowanceUsdtMinor })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'network.budget_held', entityType: 'trade', entityId: input.tradeId,
    after: { carried_by: input.funderTraderId ?? 'PLATFORM', unit: 'USDT', allowance_in_escrow: Money.ofMinor(input.allowanceUsdtMinor, 'USDT') },
  });
  return { holdId: row.id };
}

/**
 * What GasFree charged a trade's own allowance-funded transfers — its payout or payment, never a refund (the client's) or a
 * return (the trader's), nor the sweep that follows completion — and how many of its permits are still live.
 */
export async function tradeGasFreeCharges(ex: Executor, tradeId: string): Promise<{ spent: bigint; live: number }> {
  const r = await sql<{ spent: string; live: number }>`
    select coalesce(sum(p.fee_minor) filter (where p.status = 'CONFIRMED' and s.purpose in ('CLIENT_PAYOUT', 'ROUTE_PAYMENT')), 0)::text as spent,
           count(*) filter (where p.status in ('SIGNED', 'SUBMITTED'))::int as live
      from gasfree_permit p join chain_send s on s.id = p.send_id
     where s.trade_id = ${tradeId} and s.purpose <> 'FEE_SWEEP'`.execute(ex);
  return { spent: BigInt(r.rows[0]!.spent), live: r.rows[0]!.live };
}

/**
 * Settles a finished GasFree trade's allowance (ADR 0022 §2.5): on a completed trade, what its transfers cost is recovered
 * and the rest is INRP2P's margin — the sweep's own network is paid out of it later (`network:{trade}:settle`). A cancelled
 * trade's allowance never became INRP2P's: it went back with the escrow, less the return's own network. Waits, closing
 * nothing, while a permit of the trade may still execute. The caller has checked that no transfer of it can still happen.
 */
export async function closeUsdtNetworkHold(ctx: TxContext, tradeId: string, reason: string): Promise<{ closed: boolean; spentMinor: bigint; unusedMinor: bigint }> {
  const none = { closed: false, spentMinor: 0n, unusedMinor: 0n };
  const hold = await ctx.tx.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', tradeId).forUpdate().executeTakeFirst();
  if (!hold || hold.status !== 'ACTIVE' || hold.unit !== 'USDT') return none;
  const { spent, live } = await tradeGasFreeCharges(ctx.tx, tradeId);
  if (live > 0) return none;
  const trade = await ctx.tx.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow();
  const allowance = hold.deal_funded_usdt_minor!;
  if (trade.lifecycle_state === 'COMPLETED') {
    const journal = networkSettleJournal({ tradeId, allowance: Money.ofMinor(allowance, 'USDT'), spent: Money.ofMinor(spent, 'USDT') });
    if (journal) await postJournal(ctx, journal);
  }
  const unused = allowance > spent ? allowance - spent : 0n;
  await ctx.tx
    .updateTable('network_budget_hold')
    .set({ status: 'CLOSED', closed_at: sql<Date>`inrp2p_now()`, close_reason: reason.slice(0, 500), spent_usdt_minor: spent, unused_usdt_minor: unused })
    .where('id', '=', hold.id)
    .execute();
  await appendAudit(ctx, {
    action: 'network.budget_released', entityType: 'trade', entityId: tradeId,
    after: { carried_by: hold.trader_id ?? 'PLATFORM', unit: 'USDT', allowance: Money.ofMinor(allowance, 'USDT'), spent: Money.ofMinor(spent, 'USDT'), unused: Money.ofMinor(unused, 'USDT'), state: trade.lifecycle_state, reason },
  });
  return { closed: true, spentMinor: spent, unusedMinor: unused };
}
