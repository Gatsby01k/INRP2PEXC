import { sql } from 'kysely';
import { DomainError, Money, formatTrx, parseDecimalToMinor, requireText } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import type { ChainFeeParameters } from '@inrp2p/adapters';
import type { FeePolicy, FeeSnapshot } from './estimate.ts';

/** The policy in force: the latest row (migration 0037 seeds the defaults). */
export async function networkFeePolicy(ex: Executor): Promise<FeePolicy> {
  const p = await ex.selectFrom('network_fee_policy').selectAll().orderBy('set_at', 'desc').orderBy('id', 'desc').executeTakeFirstOrThrow();
  return {
    id: p.id,
    quoteEnergy: p.quote_energy,
    reserveEnergy: p.reserve_energy,
    bandwidthBufferSun: p.bandwidth_buffer_sun,
    topupBytes: p.topup_bytes,
    topupBufferBps: p.topup_buffer_bps,
    priceBufferBps: p.price_buffer_bps,
    refundSendsSell: p.refund_sends_sell,
    minNetMarginInrMinor: p.min_net_margin_inr_minor,
    maxSnapshotAgeSeconds: p.max_snapshot_age_seconds,
    maxTrxRateAgeSeconds: p.max_trx_rate_age_seconds,
    autoSendEnabled: p.auto_send_enabled,
    reason: p.reason,
    setBy: p.set_by,
    setAt: p.set_at,
  };
}

export interface SetNetworkFeePolicyPayload {
  readonly quoteEnergy?: number;
  readonly reserveEnergy?: number;
  readonly bandwidthBuffer?: string;
  readonly topupBufferBps?: number;
  readonly priceBufferBps?: number;
  readonly refundSendsSell?: number;
  readonly minNetMargin?: string;
  readonly autoSendEnabled?: boolean;
  readonly reason: string;
}

const wholeIn = (v: unknown, field: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new DomainError('INVALID_ARGUMENT', `${field} must be a whole number from ${min} to ${max}`);
  return v;
};

/**
 * `settings.network_fees` — `settings:network_fees` (OWNER ⧗). Moves what is priced and held for the network, the
 * minimum net margin of a quote, or switches the signer off. Append-only, with the reason; what is already quoted or
 * held keeps the terms it was made with.
 */
export function setNetworkFeePolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'settings:network_fees', async (ctx, p: SetNetworkFeePolicyPayload) => {
    const reason = requireText(p.reason, 'reason', 500);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why (at least 10 characters)');
    await sql`select pg_advisory_xact_lock(hashtext('inrp2p.network_fee_policy'))`.execute(ctx.tx);
    const before = await networkFeePolicy(ctx.tx);
    const quoteEnergy = p.quoteEnergy === undefined ? before.quoteEnergy : wholeIn(p.quoteEnergy, 'quoteEnergy', 10_000, 1_000_000);
    const reserveEnergy = p.reserveEnergy === undefined ? before.reserveEnergy : wholeIn(p.reserveEnergy, 'reserveEnergy', 10_000, 2_000_000);
    if (reserveEnergy < quoteEnergy) throw new DomainError('INVALID_ARGUMENT', 'the energy held per transfer is never below the energy priced');
    const bandwidthBuffer = p.bandwidthBuffer === undefined ? before.bandwidthBufferSun : parseDecimalToMinor(p.bandwidthBuffer, 6);
    if (bandwidthBuffer < 0n || bandwidthBuffer > 10_000_000n) throw new DomainError('INVALID_ARGUMENT', 'the bandwidth buffer is 0–10 TRX');
    const minNet = p.minNetMargin === undefined ? before.minNetMarginInrMinor : Money.parse(p.minNetMargin, 'INR').minor;
    if (minNet < 0n) throw new DomainError('INVALID_AMOUNT', 'the minimum net margin is never negative: a quote that loses money is never sent');
    const row = {
      quote_energy: quoteEnergy,
      reserve_energy: reserveEnergy,
      bandwidth_buffer_sun: bandwidthBuffer,
      topup_bytes: before.topupBytes,
      topup_buffer_bps: p.topupBufferBps === undefined ? before.topupBufferBps : wholeIn(p.topupBufferBps, 'topupBufferBps', 0, 5000),
      price_buffer_bps: p.priceBufferBps === undefined ? before.priceBufferBps : wholeIn(p.priceBufferBps, 'priceBufferBps', 0, 10_000),
      refund_sends_sell: p.refundSendsSell === undefined ? before.refundSendsSell : wholeIn(p.refundSendsSell, 'refundSendsSell', 0, 3),
      min_net_margin_inr_minor: minNet,
      max_snapshot_age_seconds: before.maxSnapshotAgeSeconds,
      max_trx_rate_age_seconds: before.maxTrxRateAgeSeconds,
      auto_send_enabled: p.autoSendEnabled === undefined ? before.autoSendEnabled : Boolean(p.autoSendEnabled),
      reason,
      set_by: ctx.actor.id ?? 'SYSTEM',
    };
    await ctx.tx.insertInto('network_fee_policy').values(row).execute();
    await appendAudit(ctx, {
      action: 'settings.network_fees_changed', entityType: 'network_fee_policy', entityId: null,
      before: { quote_energy: before.quoteEnergy, reserve_energy: before.reserveEnergy, min_net_margin: Money.ofMinor(before.minNetMarginInrMinor, 'INR'), auto_send: before.autoSendEnabled },
      after: { ...row, bandwidth_buffer_sun: formatTrx(row.bandwidth_buffer_sun), min_net_margin_inr_minor: Money.ofMinor(minNet, 'INR') },
    });
    return networkFeePolicy(ctx.tx);
  });
}

/** The latest reading of what the chain charges, with its age by the business clock; null when none was ever made. */
export async function latestFeeSnapshot(ex: Executor): Promise<FeeSnapshot | null> {
  const r = await sql<{ id: string; energy_price_sun: bigint; bandwidth_price_sun: bigint; create_account_fee_sun: bigint; create_new_account_fee_sun: bigint; free_net_limit: number; observed_at: Date; age: string }>`
    select id, energy_price_sun, bandwidth_price_sun, create_account_fee_sun, create_new_account_fee_sun, free_net_limit, observed_at,
           floor(greatest(extract(epoch from (inrp2p_now() - observed_at)), 0))::bigint::text as age
      from network_fee_snapshot order by observed_at desc, id desc limit 1`.execute(ex);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, energyPriceSun: row.energy_price_sun, bandwidthPriceSun: row.bandwidth_price_sun, createAccountFeeSun: row.create_account_fee_sun,
    createNewAccountFeeSun: row.create_new_account_fee_sun, freeNetLimit: row.free_net_limit, observedAt: row.observed_at, ageSeconds: Number.parseInt(row.age, 10),
  };
}

export interface TrxRate {
  readonly id: string;
  readonly usdtPerTrxMicro: bigint;
  readonly source: string;
  readonly effectiveAt: Date;
  readonly ageSeconds: number;
}

export async function latestTrxRate(ex: Executor): Promise<TrxRate | null> {
  const r = await sql<{ id: string; usdt_per_trx_micro: bigint; source: string; effective_at: Date; age: string }>`
    select id, usdt_per_trx_micro, source, effective_at, floor(greatest(extract(epoch from (inrp2p_now() - effective_at)), 0))::bigint::text as age
      from network_trx_rate order by effective_at desc, id desc limit 1`.execute(ex);
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, usdtPerTrxMicro: row.usdt_per_trx_micro, source: row.source, effectiveAt: row.effective_at, ageSeconds: Number.parseInt(row.age, 10) };
}

/**
 * What the network costs right now, or the reason nothing can be priced or held: no reading of the chain, or one too
 * old; no TRX price, or one too old. Without both, no quote is sent and no trade accepted — a fee nobody can state is
 * a fee nobody covers.
 */
export async function currentNetworkCosts(ex: Executor): Promise<{ policy: FeePolicy; snapshot: FeeSnapshot; rate: TrxRate }> {
  const policy = await networkFeePolicy(ex);
  const snapshot = await latestFeeSnapshot(ex);
  if (!snapshot) throw new DomainError('NETWORK_FEES_UNKNOWN', 'the chain\'s fees have never been read: the worker records them (network_fee_refresh)');
  if (snapshot.ageSeconds > policy.maxSnapshotAgeSeconds) {
    throw new DomainError('NETWORK_FEES_UNKNOWN', `the chain's fees were last read ${snapshot.ageSeconds}s ago (limit ${policy.maxSnapshotAgeSeconds}s)`);
  }
  const rate = await latestTrxRate(ex);
  if (!rate) throw new DomainError('NETWORK_FEES_UNKNOWN', 'no TRX price is published: publish one on the desk (Network budget)');
  if (rate.ageSeconds > policy.maxTrxRateAgeSeconds) {
    throw new DomainError('NETWORK_FEES_UNKNOWN', `the TRX price is ${rate.ageSeconds}s old (limit ${policy.maxTrxRateAgeSeconds}s): publish a current one`);
  }
  return { policy, snapshot, rate };
}

/** Records what the chain charges (the worker's `network_fee_refresh`, from its providers). */
export async function recordFeeSnapshot(ctx: TxContext, params: ChainFeeParameters, providers: readonly string[]): Promise<{ snapshotId: string }> {
  const row = await ctx.tx
    .insertInto('network_fee_snapshot')
    .values({
      energy_price_sun: params.energyPriceSun,
      bandwidth_price_sun: params.bandwidthPriceSun,
      create_account_fee_sun: params.createAccountFeeSun,
      create_new_account_fee_sun: params.createNewAccountFeeSun,
      free_net_limit: params.freeNetLimit,
      providers: providers.join(',').slice(0, 300) || 'unknown',
      observed_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'network.fees_observed', entityType: 'network_fee_snapshot', entityId: row.id,
    after: { energy_price_sun: params.energyPriceSun.toString(), bandwidth_price_sun: params.bandwidthPriceSun.toString(), create_account_fee: formatTrx(params.createAccountFeeSun), create_new_account_fee: formatTrx(params.createNewAccountFeeSun), providers },
  });
  return { snapshotId: row.id };
}

/**
 * `network.publish_trx_rate` — `network:manage` (⧗). What one TRX is worth in USDT, with where it was read. The client's
 * network fee is priced with it, and a trader's TRX is paid back at the rate its trade was quoted with.
 */
export function publishTrxRate(actor: OperatorActor) {
  return operatorCommand(actor, 'network:manage', async (ctx, p: { usdtPerTrx: string; source: string; confirmLargeChange?: boolean }) => {
    const micro = parseDecimalToMinor(p.usdtPerTrx, 6);
    if (micro <= 0n || micro > 1_000_000_000n) throw new DomainError('INVALID_RATE', 'a TRX price is a positive number of USDT');
    const source = requireText(p.source, 'source', 200);
    const before = await latestTrxRate(ctx.tx);
    // A price ten times off is a typo far more often than a market: it is refused rather than quoted.
    if (before && !p.confirmLargeChange && (micro * 10n < before.usdtPerTrxMicro || micro > before.usdtPerTrxMicro * 10n)) {
      throw new DomainError('INVALID_RATE', `${p.usdtPerTrx} is more than ten times away from the last price; check it, and confirm it if it is right`);
    }
    const row = await ctx.tx.insertInto('network_trx_rate').values({ usdt_per_trx_micro: micro, source, published_by: ctx.actor.id ?? 'SYSTEM' }).returning(['id', 'effective_at']).executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'network.trx_rate_published', entityType: 'network_trx_rate', entityId: row.id, before: before ? { usdt_per_trx: formatTrx(before.usdtPerTrxMicro) } : null, after: { usdt_per_trx: formatTrx(micro), source } });
    return { rateId: row.id, effectiveAt: row.effective_at.toISOString() };
  });
}
