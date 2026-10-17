import { DomainError, Money, Rate, formatTrx, inrToUsdt, trxToInrMinor, trxToUsdtMinor, usdtToInr } from '@inrp2p/kernel';
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
  /** P2P (ADR 0019): what the quote leaves in USDT — its margin is USDT, the platform pays the TRX, no reward is counted. */
  readonly p2p?: { readonly grossMarginBaseMinor: bigint; readonly feeUsdtMinor: bigint; readonly netMarginUsdtMinor: bigint; readonly minNetMarginUsdtMinor: bigint };
}

/**
 * A P2P quote (ADR 0019, FI-97): no rupee passes the exchange, so what it keeps is USDT — the USDT between the client's
 * amount and the trader's — and from that it pays the network fee of the transfers out of the escrow, which the
 * platform's TRX budget funds. No trader reward is counted: the trader earns on its own rate. The minimum net margin is
 * the policy's rupee minimum, valued in USDT at the client's rate (rounded up). The hold covers the transfer and a return
 * of the escrow (whoever funded it), whichever direction.
 */
export async function priceNetworkP2p(
  ex: Executor,
  input: { direction: 'SELL_USDT' | 'BUY_USDT'; clientRateMicro: bigint; grossMarginBaseMinor: bigint; traderOrderId: string },
): Promise<NetworkPricing> {
  const { policy, snapshot, rate } = await currentNetworkCosts(ex);
  const feeSun = quoteFeeSun(snapshot, policy);
  const feeUsdtMinor = trxToUsdtMinor(feeSun, rate.usdtPerTrxMicro, 'UP');
  const feeInrMinor = trxToInrMinor(feeSun, rate.usdtPerTrxMicro, input.clientRateMicro, 'UP');
  const minNetMarginUsdtMinor = inrToUsdt(Money.ofMinor(policy.minNetMarginInrMinor, 'INR'), Rate.ofMicro(input.clientRateMicro, 'CLIENT'), 'UP').minor;
  const netMarginUsdtMinor = input.grossMarginBaseMinor - feeUsdtMinor;
  const asInr = (usdtMinor: bigint) => {
    const v = usdtToInr(Money.ofMinor(usdtMinor < 0n ? -usdtMinor : usdtMinor, 'USDT'), Rate.ofMicro(input.clientRateMicro, 'CLIENT'), 'DOWN').minor;
    return usdtMinor < 0n ? -v : v;
  };
  const sends = 1 + policy.refundSendsSell;
  const perSend = reservePerSendSun(snapshot, policy);
  return {
    funderTraderId: null,
    snapshotId: snapshot.id,
    trxRateId: rate.id,
    usdtPerTrxMicro: rate.usdtPerTrxMicro,
    energyPriceSun: snapshot.energyPriceSun,
    sendsPriced: 1,
    feeSun,
    feeInrMinor,
    rewardInrMinor: 0n,
    traderOrderId: input.traderOrderId,
    rewardBps: 0,
    grossMarginInrMinor: asInr(input.grossMarginBaseMinor),
    netMarginInrMinor: asInr(netMarginUsdtMinor),
    minNetMarginInrMinor: policy.minNetMarginInrMinor,
    reserveSends: sends,
    perSendSun: perSend,
    reserveSun: perSend * BigInt(sends),
    p2p: { grossMarginBaseMinor: input.grossMarginBaseMinor, feeUsdtMinor, netMarginUsdtMinor, minNetMarginUsdtMinor },
  };
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
  if (p.p2p) {
    if (p.p2p.netMarginUsdtMinor >= p.p2p.minNetMarginUsdtMinor) return;
    throw new DomainError('QUOTE_UNPROFITABLE', `this quote would leave ${Money.ofMinor(p.p2p.netMarginUsdtMinor, 'USDT').toDecimalString()} USDT after the network fee; the minimum is ${Money.ofMinor(p.p2p.minNetMarginUsdtMinor, 'USDT').toDecimalString()}`, {
      grossMarginUsdt: Money.ofMinor(p.p2p.grossMarginBaseMinor, 'USDT').toDecimalString(),
      networkFeeUsdt: Money.ofMinor(p.p2p.feeUsdtMinor, 'USDT').toDecimalString(),
      networkFeeTrx: formatTrx(p.feeSun),
      netMarginUsdt: Money.ofMinor(p.p2p.netMarginUsdtMinor, 'USDT').toDecimalString(),
      minNetMarginUsdt: Money.ofMinor(p.p2p.minNetMarginUsdtMinor, 'USDT').toDecimalString(),
      ...extra,
    });
  }
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
      fee_usdt_minor: p.p2p?.feeUsdtMinor ?? null,
      net_margin_usdt_minor: p.p2p?.netMarginUsdtMinor ?? null,
      min_net_margin_usdt_minor: p.p2p?.minNetMarginUsdtMinor ?? null,
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
  /** P2P (ADR 0019): the fee and the net margin in USDT; null through the exchange. */
  readonly feeUsdtMinor: bigint | null;
  readonly netMarginUsdtMinor: bigint | null;
}

export async function quoteNetworkFee(ex: Executor, quoteId: string): Promise<QuoteNetworkFee | null> {
  const r = await ex.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', quoteId).executeTakeFirst();
  if (!r) return null;
  return {
    quoteId: r.quote_id, funderTraderId: r.funder_trader_id, snapshotId: r.snapshot_id, usdtPerTrxMicro: r.usdt_per_trx_micro, feeSun: r.fee_sun,
    feeInrMinor: r.fee_inr_minor, rewardInrMinor: r.reward_inr_minor, traderOrderId: r.trader_order_id, rewardBps: r.reward_bps, netMarginInrMinor: r.net_margin_inr_minor, reserveSends: r.reserve_sends, reserveSun: r.reserve_sun,
    feeUsdtMinor: r.fee_usdt_minor, netMarginUsdtMinor: r.net_margin_usdt_minor,
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
