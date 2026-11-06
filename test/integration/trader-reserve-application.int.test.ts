import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAs } from '@inrp2p/identity/testing';
import { approveReserveApplication, endReserveApplication, requestReserveApplication, reserveFigures } from '@inrp2p/traders';
import { type World, createWorld, openTrade, scenarioTrader, settleFirstLeg } from '../../packages/settlement/test/world.ts';

/** D3: rupees a trader owes and has not paid. The reserve is USDT: it is only held, on two people's word, never converted. */
let w: World;
beforeAll(async () => { w = await createWorld('trader_reserve_hold'); });
afterAll(async () => w.close());

describe('holding a trader’s Security Reserve against rupees it did not pay', () => {
  it('needs a named amount and a second person, stays within the free reserve, and is released on the record', async () => {
    const trader = await scenarioTrader(w);
    const trade = await openTrade(w, { baseUsdt: '100' });
    await settleFirstLeg(w, trade.tradeId);
    const request = (amount?: string) => runAs(w.app, requestReserveApplication(w.financeOp.actor), w.financeOp.ref, 'trader_reserve.request_application', { orderId: trade.orderId, reason: 'the trader stopped answering after the client paid', ...(amount ? { amount } : {}) });
    await expect(request()).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(request('500.000001')).rejects.toMatchObject({ code: 'TRADER_RESERVE_SHORT' });
    const hold = await request('200');
    expect(hold.kind).toBe('HOLD');
    const approve = (who: typeof w.financeOp) => runAs(w.app, approveReserveApplication(who.actor), who.ref, 'trader_reserve.approve_application', { applicationId: hold.applicationId });
    await expect(approve(w.financeOp)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await approve(w.financeOp2);
    const held = await reserveFigures(w.app, trader.traderId);
    expect({ applying: held.applying.toDecimalString(), balance: held.balance.toDecimalString() }).toEqual({ applying: '200.000000', balance: '500.000000' });
    await runAs(w.app, endReserveApplication(w.finance.actor), w.finance.ref, 'trader_reserve.end_application', { applicationId: hold.applicationId, reason: 'the trader paid after all' });
    expect((await reserveFigures(w.app, trader.traderId)).applying.isZero()).toBe(true);
  });

  it('is not asked for on an order that funds an escrow: the client pays only once that is there', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', baseUsdt: '10' });
    await expect(runAs(w.app, requestReserveApplication(w.financeOp.actor), w.financeOp.ref, 'trader_reserve.request_application', { orderId: trade.orderId, amount: '5', reason: 'the trader never funded the escrow' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
