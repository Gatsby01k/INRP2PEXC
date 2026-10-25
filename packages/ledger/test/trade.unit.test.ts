import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Money, type TradeEconomics } from '@inrp2p/kernel';
import { tradeCompleteJournal } from '../src/rules/trade.ts';
import { networkFeeJournal, networkSettleJournal } from '../src/rules/network.ts';
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

/** ADR 0022 §2.6: a deal's network, priced in USDT, settled at the providers' actual charge. */
describe('a deal’s network in USDT', () => {
  const tradeId = randomUUID();
  const usdt = (d: string) => Money.parse(d, 'USDT');
  const lines = (j: { entries: readonly { direction: string; account: { code: string }; amount: Money }[] } | null) =>
    j!.entries.map((e) => `${e.direction} ${e.account.code} ${e.amount.toDecimalString()}`);

  it('on completion, moves the allowance its escrow carries out of the margin — never realized as revenue', () => {
    const econ: TradeEconomics = {
      direction: 'SELL_USDT', fixedSide: 'BASE', base: usdt('1000'), clientInr: Money.parse('100900.00', 'INR'), routeInr: Money.parse('100900.00', 'INR'),
      grossMargin: Money.parse('0', 'INR'), routeBase: usdt('996.6'), grossMarginBase: usdt('3.4'), platformFeeBase: usdt('2.5'), networkFeeBase: usdt('0.9'),
    };
    const j = tradeCompleteJournal(econ, { tradeId });
    expect(lines(j)).toEqual(['DR LIAB:DEFERRED_MARGIN 3.400000', 'CR REVENUE:PLATFORM_FEE 2.500000', 'CR LIAB:NETWORK_ALLOWANCE 0.900000']);
    // INRP2P's own deal: the allowance is out of its margin.
    const { platformFeeBase: _fee, ...house } = econ;
    const own = tradeCompleteJournal({ ...house, grossMarginBase: usdt('11.46') }, { tradeId });
    expect(lines(own)).toEqual(['DR LIAB:DEFERRED_MARGIN 11.460000', 'CR LIAB:NETWORK_ALLOWANCE 0.900000', 'CR REVENUE:GROSS_MARGIN 10.560000']);
    expect(() => tradeCompleteJournal({ ...econ, networkFeeBase: usdt('1') }, { tradeId })).toThrow(/part of its margin/);
  });

  it('books what GasFree charged a transfer out of its deal address, borne by the allowance, the refunded client or the returning trader', () => {
    const walletId = randomUUID();
    const permitId = randomUUID();
    const payout = networkFeeJournal({ permitId, tradeId, walletId, fee: usdt('3'), bearer: { kind: 'ALLOWANCE' } })!;
    expect(payout.postingKey).toBe(`gasfree:${permitId}:fee`);
    expect(lines(payout)).toEqual(['DR EXPENSE:NETWORK_FEES 3.000000', `CR ASSET:TREASURY_USDT:${walletId} 3.000000`]);
    assertBalanced(payout.entries);
    const clientId = randomUUID();
    expect(lines(networkFeeJournal({ permitId, tradeId, walletId, fee: usdt('3'), bearer: { kind: 'CLIENT', clientId } })))
      .toEqual([`DR ASSET:CLIENT_RECEIVABLE:${clientId} 3.000000`, `CR ASSET:TREASURY_USDT:${walletId} 3.000000`]);
    const routeId = randomUUID();
    const ro = randomUUID();
    const back = networkFeeJournal({ permitId, tradeId, walletId, fee: usdt('3'), bearer: { kind: 'ROUTE', routeId, routeObligationId: ro } })!;
    expect(back.entries[0]).toMatchObject({ direction: 'DR', account: { code: `ASSET:ROUTE_RECEIVABLE:${routeId}` }, routeObligationId: ro });
    expect(networkFeeJournal({ permitId, tradeId, walletId, fee: usdt('0'), bearer: { kind: 'ALLOWANCE' } })).toBeNull();
  });

  it('settles a completed deal’s allowance: what its transfers cost recovered, the rest INRP2P’s margin — never less than nothing', () => {
    const settle = networkSettleJournal({ tradeId, allowance: usdt('4.5'), spent: usdt('3') })!;
    expect(settle.postingKey).toBe(`network:${tradeId}:settle`);
    expect(lines(settle)).toEqual(['DR LIAB:NETWORK_ALLOWANCE 4.500000', 'CR REVENUE:NETWORK_RECOVERED 3.000000', 'CR REVENUE:GROSS_MARGIN 1.500000']);
    assertBalanced(settle.entries);
    // Fees that rose past the allowance: all of it recovers what was spent; the rest stays INRP2P's booked expense.
    expect(lines(networkSettleJournal({ tradeId, allowance: usdt('4.5'), spent: usdt('5') }))).toEqual(['DR LIAB:NETWORK_ALLOWANCE 4.500000', 'CR REVENUE:NETWORK_RECOVERED 4.500000']);
    expect(networkSettleJournal({ tradeId, allowance: usdt('0'), spent: usdt('3') })).toBeNull();
  });
});
