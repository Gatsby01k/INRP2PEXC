import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Money, type TradeEconomics } from '@inrp2p/kernel';
import { tradeCompleteJournal } from '../src/rules/trade.ts';
import { assertBalanced } from '../src/posting.ts';

/** `trade:{t}:complete` (FINANCIAL_INVARIANTS §3.3): what a completed trade's margin is realized as. */
describe('completing a trade', () => {
  const tradeId = randomUUID();
  const usdt = (d: string) => Money.parse(d, 'USDT');
  const p2p = (margin: string, fee?: string): TradeEconomics => ({
    direction: 'SELL_USDT', fixedSide: 'BASE', base: usdt('10000'), clientInr: Money.parse('1009000.00', 'INR'), routeInr: Money.parse('1009000.00', 'INR'),
    grossMargin: Money.parse('0', 'INR'), routeBase: usdt('10000').sub(usdt(margin)), grossMarginBase: usdt(margin), ...(fee ? { platformFeeBase: usdt(fee) } : {}),
  });
  const lines = (j: ReturnType<typeof tradeCompleteJournal>) => j!.entries.map((e) => `${e.direction} ${e.account.code} ${e.amount.toDecimalString()} ${e.amount.currency}`);

  it('a desk’s own deal: its whole margin is the platform’s fee, realized as REVENUE:PLATFORM_FEE, never as gross margin', () => {
    const j = tradeCompleteJournal(p2p('25', '25'), { tradeId });
    expect(j!.postingKey).toBe(`trade:${tradeId}:complete`);
    expect(lines(j)).toEqual(['DR LIAB:DEFERRED_MARGIN 25.000000 USDT', 'CR REVENUE:PLATFORM_FEE 25.000000 USDT']);
    expect(() => assertBalanced(j!.entries)).not.toThrow();
  });

  it('a desk deal with more margin than the fee: the fee is the platform’s revenue, only the rest is gross margin', () => {
    const j = tradeCompleteJournal(p2p('74', '25'), { tradeId });
    expect(lines(j)).toEqual(['DR LIAB:DEFERRED_MARGIN 74.000000 USDT', 'CR REVENUE:PLATFORM_FEE 25.000000 USDT', 'CR REVENUE:GROSS_MARGIN 49.000000 USDT']);
    expect(() => assertBalanced(j!.entries)).not.toThrow();
  });

  it('a desk deal at a zero fee posts nothing', () => {
    expect(tradeCompleteJournal(p2p('0', '0'), { tradeId })).toBeNull();
  });

  it('a desk deal whose fee is more than its margin is refused', () => {
    expect(() => tradeCompleteJournal(p2p('10', '25'), { tradeId })).toThrow(/part of its margin/);
  });

  it('a P2P deal of the INRP2P desk keeps realizing its USDT margin as gross margin', () => {
    expect(lines(tradeCompleteJournal(p2p('15'), { tradeId }))).toEqual(['DR LIAB:DEFERRED_MARGIN 15.000000 USDT', 'CR REVENUE:GROSS_MARGIN 15.000000 USDT']);
  });
});
