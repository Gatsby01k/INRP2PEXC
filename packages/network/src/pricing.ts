import { DomainError, Money, formatTrx, trxToInrMinor } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { quoteFeeSun, reservePerSendSun, reserveSends } from './estimate.ts';
import { currentNetworkCosts } from './policy.ts';

/**
 * What a quote leaves the exchange (ADR 0017 §1, FI-90): its gross margin, less the reward the trader is paid on it,
 * less the network fee of its transfer — the TRX the exchange's signer will burn, valued at the quote's own rate. The
 * client's price is the client rate; the network fee and the reward are inside it, never added on top, so what the
 * client pays and what it receives are exactly the quoted amounts. A quote that does not leave at least the policy's
 * minimum net margin is never sent, and so never accepted.
 */
export interface NetworkPricing {
  readonly funderTraderId: string | null;
  readonly snapshotId: string;
  readonly trxRateId: string;
  readonly usdtPerTrxMicro: bigint;
  readonly energyPriceSun: bigint;
  readonly sendsPriced: number;
  readonly feeSun: bigint;
  readonly feeInrMinor: bigint;
  readonly rewardInrMinor: bigint;
  /** The trader order whose reward is counted, and its basis points — frozen with the quote (IX113). */
  readonly traderOrderId: string | null;
  readonly rewardBps: number | null;
  readonly grossMarginInrMinor: bigint;
  readonly netMarginInrMinor: bigint;
  readonly minNetMarginInrMinor: bigint;
  readonly reserveSends: number;
  readonly perSendSun: bigint;
  readonly reserveSun: bigint;
}

export async function priceNetwork(
  ex: Executor,
  input: {
    direction: 'SELL_USDT' | 'BUY_USDT'; clientRateMicro: bigint; grossMarginInrMinor: bigint; funderTraderId: string | null;
    reward: { readonly orderId: string; readonly bps: number | null; readonly rewardMinor: bigint } | null;
  },
): Promise<NetworkPricing> {
  const { policy, snapshot, rate } = await currentNetworkCosts(ex);
  const feeSun = quoteFeeSun(snapshot, policy);
  // What the client is charged rounds up (FINANCIAL_INVARIANTS §1.2): the exchange never under-collects the fee.
  const feeInrMinor = trxToInrMinor(feeSun, rate.usdtPerTrxMicro, input.clientRateMicro, 'UP');
  const sends = reserveSends(input.direction, policy);
  const perSend = reservePerSendSun(snapshot, policy);
  return {
    funderTraderId: input.funderTraderId,
    snapshotId: snapshot.id,
    trxRateId: rate.id,
    usdtPerTrxMicro: rate.usdtPerTrxMicro,
    energyPriceSun: snapshot.energyPriceSun,
    sendsPriced: 1,
    feeSun,
    feeInrMinor,
    rewardInrMinor: input.reward?.rewardMinor ?? 0n,
    traderOrderId: input.reward?.orderId ?? null,
    rewardBps: input.reward?.bps ?? null,
    grossMarginInrMinor: input.grossMarginInrMinor,
    netMarginInrMinor: input.grossMarginInrMinor - (input.reward?.rewardMinor ?? 0n) - feeInrMinor,
    minNetMarginInrMinor: policy.minNetMarginInrMinor,
    reserveSends: sends,
    perSendSun: perSend,
    reserveSun: perSend * BigInt(sends),
  };
}

/** Refuses a quote that would not leave the minimum net margin, saying what it would leave and why. */
export function assertProfitable(p: NetworkPricing, extra: Record<string, unknown> = {}): void {
  if (p.netMarginInrMinor >= p.minNetMarginInrMinor) return;
  throw new DomainError('QUOTE_UNPROFITABLE', `this quote would leave ${Money.ofMinor(p.netMarginInrMinor, 'INR').toDecimalString()} INR after the trader's reward and the network fee; the minimum is ${Money.ofMinor(p.minNetMarginInrMinor, 'INR').toDecimalString()}`, {
    grossMargin: Money.ofMinor(p.grossMarginInrMinor, 'INR').toDecimalString(),
    reward: Money.ofMinor(p.rewardInrMinor, 'INR').toDecimalString(),
    networkFee: Money.ofMinor(p.feeInrMinor, 'INR').toDecimalString(),
    networkFeeTrx: formatTrx(p.feeSun),
    netMargin: Money.ofMinor(p.netMarginInrMinor, 'INR').toDecimalString(),
    minNetMargin: Money.ofMinor(p.minNetMarginInrMinor, 'INR').toDecimalString(),
    ...extra,
  });
}

export async function recordQuoteNetworkFee(ctx: TxContext, quoteId: string, p: NetworkPricing): Promise<void> {
  await ctx.tx
    .insertInto('quote_network_fee')
    .values({
      quote_id: quoteId,
      funder_trader_id: p.funderTraderId,
      snapshot_id: p.snapshotId,
      trx_rate_id: p.trxRateId,
      usdt_per_trx_micro: p.usdtPerTrxMicro,
      energy_price_sun: p.energyPriceSun,
      sends_priced: p.sendsPriced,
      fee_sun: p.feeSun,
      fee_inr_minor: p.feeInrMinor,
      trader_order_id: p.traderOrderId,
      reward_bps: p.rewardBps,
      reward_inr_minor: p.rewardInrMinor,
      net_margin_inr_minor: p.netMarginInrMinor,
      reserve_sends: p.reserveSends,
      reserve_sun: p.reserveSun,
      min_net_margin_inr_minor: p.minNetMarginInrMinor,
    })
    .execute();
}

export interface QuoteNetworkFee {
  readonly quoteId: string;
  readonly funderTraderId: string | null;
  readonly snapshotId: string;
  readonly usdtPerTrxMicro: bigint;
  readonly feeSun: bigint;
  readonly feeInrMinor: bigint;
  readonly rewardInrMinor: bigint;
  readonly traderOrderId: string | null;
  readonly rewardBps: number | null;
  readonly netMarginInrMinor: bigint;
  readonly reserveSends: number;
  readonly reserveSun: bigint;
}

export async function quoteNetworkFee(ex: Executor, quoteId: string): Promise<QuoteNetworkFee | null> {
  const r = await ex.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', quoteId).executeTakeFirst();
  if (!r) return null;
  return {
    quoteId: r.quote_id, funderTraderId: r.funder_trader_id, snapshotId: r.snapshot_id, usdtPerTrxMicro: r.usdt_per_trx_micro, feeSun: r.fee_sun,
    feeInrMinor: r.fee_inr_minor, rewardInrMinor: r.reward_inr_minor, traderOrderId: r.trader_order_id, rewardBps: r.reward_bps, netMarginInrMinor: r.net_margin_inr_minor, reserveSends: r.reserve_sends, reserveSun: r.reserve_sun,
  };
}

/** The network terms a trade was accepted with — through its quote, frozen there (FI-10). */
export async function tradeNetworkFee(ex: Executor, tradeId: string): Promise<(QuoteNetworkFee & { readonly clientRateMicro: bigint; readonly direction: 'SELL_USDT' | 'BUY_USDT' }) | null> {
  const t = await ex
    .selectFrom('trade as t')
    .innerJoin('quote as q', 'q.id', 't.quote_id')
    .select(['q.id as quote_id', 'q.client_rate_micro', 'q.direction'])
    .where('t.id', '=', tradeId)
    .executeTakeFirst();
  if (!t) return null;
  const fee = await quoteNetworkFee(ex, t.quote_id);
  return fee ? { ...fee, clientRateMicro: t.client_rate_micro, direction: t.direction } : null;
}
