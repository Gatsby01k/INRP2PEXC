import { describe, expect, it } from 'vitest';
import { formatTrx, parseTrx, trxToInrMinor } from '@inrp2p/kernel';
import { type FeePolicy, type FeeSnapshot, quoteFeeSun, reservePerSendSun, reserveSends, sendCost, topupFor } from '../src/estimate.ts';

/**
 * The arithmetic of a transfer's network cost (ADR 0017 §2): what the client's price carries, what a trade holds, and
 * what a top-up sends. Every step rounds against the budget running short — up — and the INR value of a fee rounds up
 * when the client is charged and down when the exchange pays a trader back.
 */
const snapshot: FeeSnapshot = {
  id: 's', energyPriceSun: 100n, bandwidthPriceSun: 1000n, createAccountFeeSun: 100_000n, createNewAccountFeeSun: 1_000_000n, freeNetLimit: 600, observedAt: new Date(0), ageSeconds: 0,
};
const policy: FeePolicy = {
  id: 'p', quoteEnergy: 131_000, reserveEnergy: 160_000, bandwidthBufferSun: 400_000n, topupBytes: 300, topupBufferBps: 1000, priceBufferBps: 1000, refundSendsSell: 1,
  minNetMarginInrMinor: 1n, maxSnapshotAgeSeconds: 86_400, maxTrxRateAgeSeconds: 259_200, autoSendEnabled: true, reason: 'test', setBy: 'test', setAt: new Date(0),
};

describe('network cost of a transfer', () => {
  it('activates a new deal address and pays its energy with the buffers', () => {
    const c = sendCost(snapshot, policy, 131_000n, { activation: true });
    // 1 TRX + 0.1 TRX to create the account, 300 bytes of the top-up's bandwidth at 1000 sun.
    expect(c.topupFeeSun).toBe(1_400_000n);
    // 131,000 energy × 100 sun, +10 %, + the 0.4 TRX bandwidth buffer.
    expect(c.transferSun).toBe(14_810_000n);
    expect(c.totalSun).toBe(16_210_000n);
    expect(sendCost(snapshot, policy, 131_000n, { activation: false }).topupFeeSun).toBe(300_000n);
  });

  it('prices the quoted fee with the price buffer and holds the worst case', () => {
    expect(formatTrx(quoteFeeSun(snapshot, policy))).toBe('17.831000');
    expect(formatTrx(reservePerSendSun(snapshot, policy))).toBe('19.400000');
  });

  it('holds two transfers for a SELL (pay the counterparty, or return the client’s USDT) and one for a BUY', () => {
    expect(reserveSends('SELL_USDT', policy)).toBe(2);
    expect(reserveSends('BUY_USDT', policy)).toBe(1);
    expect(reserveSends('SELL_USDT', { refundSendsSell: 0 })).toBe(1);
  });

  it('rounds every buffer up, never down', () => {
    expect(sendCost({ ...snapshot, energyPriceSun: 1n }, { ...policy, topupBufferBps: 1, bandwidthBufferSun: 0n }, 1n, { activation: false }).transferSun).toBe(2n);
  });

  it('refuses negative energy', () => {
    expect(() => sendCost(snapshot, policy, -1n, { activation: false })).toThrow(/never negative/);
  });

  it('tops up only what the address lacks', () => {
    const t = topupFor({ energy: 65_000n, energyPriceSun: 100n, balanceSun: 0n, policy });
    expect(t.feeLimitSun).toBe(7_150_000n);
    expect(t.needSun).toBe(7_550_000n);
    expect(t.topupSun).toBe(7_550_000n);
    expect(topupFor({ energy: 65_000n, energyPriceSun: 100n, balanceSun: 5_000_000n, policy }).topupSun).toBe(2_550_000n);
    expect(topupFor({ energy: 65_000n, energyPriceSun: 100n, balanceSun: 8_000_000n, policy }).topupSun).toBe(0n);
    // A fee limit is never zero: the chain reads 0 as "no limit".
    expect(topupFor({ energy: 0n, energyPriceSun: 100n, balanceSun: 0n, policy }).feeLimitSun).toBe(1n);
  });

  it('values TRX in INR: up when the client pays, down when the exchange pays back', () => {
    const fee = parseTrx('17.831');
    // 17.831 TRX × 0.3 USDT/TRX × 92.5 INR/USDT = ₹494.81025
    expect(trxToInrMinor(fee, 300_000n, 92_500_000n, 'UP')).toBe(49_482n);
    expect(trxToInrMinor(fee, 300_000n, 92_500_000n, 'DOWN')).toBe(49_481n);
    expect(() => trxToInrMinor(fee, 0n, 92_500_000n, 'UP')).toThrow();
  });
});
