import { DomainError, divRound } from '@inrp2p/kernel';

/**
 * What a USDT transfer from a deal address costs in TRX (ADR 0017 §2), as pure arithmetic over what the chain charges
 * (`FeeSnapshot`) and how much the exchange prices and holds (`FeePolicy`). No rounding works against the budget:
 * every step rounds up.
 *
 * A deal address is new: the chain has never seen TRX there, so before it can send its USDT the budget wallet sends it
 * TRX — a transfer that creates (activates) the account, which burns the account-creation fee and the transfer's own
 * bandwidth at the budget wallet. Then the USDT transfer burns energy at the deal address: ~65,000 to a holder of
 * USDT, about twice that to an address that has never held it, more when the contract's energy factor is up. Its
 * bandwidth is usually covered by the activated account's free daily bandwidth; the buffer is there when it is not.
 */
export interface FeeSnapshot {
  readonly id: string;
  readonly energyPriceSun: bigint;
  readonly bandwidthPriceSun: bigint;
  readonly createAccountFeeSun: bigint;
  readonly createNewAccountFeeSun: bigint;
  readonly freeNetLimit: number;
  readonly observedAt: Date;
  readonly ageSeconds: number;
}

export interface FeePolicy {
  readonly id: string;
  /** Energy units and basis points are counts, not money. */
  readonly quoteEnergy: number;
  readonly reserveEnergy: number;
  readonly bandwidthBufferSun: bigint;
  readonly topupBytes: number;
  readonly topupBufferBps: number;
  readonly priceBufferBps: number;
  readonly refundSendsSell: number;
  readonly minNetMarginInrMinor: bigint;
  readonly maxSnapshotAgeSeconds: number;
  readonly maxTrxRateAgeSeconds: number;
  readonly autoSendEnabled: boolean;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: Date;
}

const BPS = 10_000n;
const withBps = (sun: bigint, bps: number): bigint => divRound(sun * (BPS + BigInt(bps)), BPS, 'UP');

export interface SendCost {
  /** Burned at the budget wallet by the top-up: account creation (a new address) and the top-up's bandwidth. */
  readonly topupFeeSun: bigint;
  /** Sent to the deal address for its transfer: energy with the top-up buffer, and the bandwidth buffer. */
  readonly transferSun: bigint;
  readonly totalSun: bigint;
}

/** The TRX one transfer of `energy` needs, from an address that is (`activation: true`) or is not yet activated. */
export function sendCost(s: Pick<FeeSnapshot, 'energyPriceSun' | 'bandwidthPriceSun' | 'createAccountFeeSun' | 'createNewAccountFeeSun'>, p: Pick<FeePolicy, 'topupBytes' | 'topupBufferBps' | 'bandwidthBufferSun'>, energy: bigint, opts: { activation: boolean }): SendCost {
  if (energy < 0n) throw new DomainError('INVALID_ARGUMENT', 'energy is never negative');
  const topupFeeSun = (opts.activation ? s.createNewAccountFeeSun + s.createAccountFeeSun : 0n) + BigInt(p.topupBytes) * s.bandwidthPriceSun;
  const transferSun = withBps(energy * s.energyPriceSun, p.topupBufferBps) + p.bandwidthBufferSun;
  return { topupFeeSun, transferSun, totalSun: topupFeeSun + transferSun };
}

/** The TRX the client's price covers for the trade's one transfer, with the price buffer. */
export function quoteFeeSun(s: FeeSnapshot, p: FeePolicy): bigint {
  return withBps(sendCost(s, p, BigInt(p.quoteEnergy), { activation: true }).totalSun, p.priceBufferBps);
}

/** The worst case of one transfer, held from acceptance on. */
export function reservePerSendSun(s: FeeSnapshot, p: FeePolicy): bigint {
  return sendCost(s, p, BigInt(p.reserveEnergy), { activation: true }).totalSun;
}

/**
 * Transfers a trade may need: one for what it pays out (USDT to the client of a BUY, or to the counterparty of a
 * SELL), and for a SELL the return of the client's USDT if the counterparty never pays — whichever happens, it is held.
 */
export function reserveSends(direction: 'SELL_USDT' | 'BUY_USDT', p: Pick<FeePolicy, 'refundSendsSell'>): number {
  return direction === 'SELL_USDT' ? 1 + p.refundSendsSell : 1;
}

/**
 * The top-up a transfer needs now: the energy the chain simulated, with the buffer, and the bandwidth buffer, less the
 * TRX already at the address. Its fee limit is what the energy may burn at most.
 */
export function topupFor(input: { energy: bigint; energyPriceSun: bigint; balanceSun: bigint; policy: Pick<FeePolicy, 'topupBufferBps' | 'bandwidthBufferSun'> }): { readonly needSun: bigint; readonly topupSun: bigint; readonly feeLimitSun: bigint } {
  const feeLimitSun = withBps(input.energy * input.energyPriceSun, input.policy.topupBufferBps);
  const needSun = feeLimitSun + input.policy.bandwidthBufferSun;
  const topupSun = needSun > input.balanceSun ? needSun - input.balanceSun : 0n;
  return { needSun, topupSun, feeLimitSun: feeLimitSun > 0n ? feeLimitSun : 1n };
}
