import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { portalAccess } from '@inrp2p/portal';
import { type World, createWorld, openTrade, payClient, scenarioTrader, settleFirstLeg } from '../../../packages/settlement/test/world.ts';

vi.mock('server-only', () => ({}));
const { liveDeal } = await import('../src/server/live-deal.ts');

/**
 * The deal the workspace's bar shows as waiting on someone (`LiveDeal`): it follows the deal's own turn, step by step,
 * for the client and for its trader — never the page's guess. A SELL deal: the client funds the escrow, the trader pays
 * the rupees, the client confirms them.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld('web_live_deal');
});
afterAll(async () => w.close());

describe('the deal waiting on you', () => {
  it('follows a SELL deal’s turn between the client and its trader', async () => {
    const client = await portalAccess(w.app, w.acceptor.userId);
    const trader = await scenarioTrader(w);
    const traderMember = await portalAccess(w.app, trader.admin.userId);
    const forClient = () => liveDeal(w.app, client, w.acceptor.userId);
    const forTrader = () => liveDeal(w.app, traderMember, trader.admin.userId);

    expect(await forClient()).toBeNull();

    const opened = await openTrade(w);
    // The client sells: its USDT into the escrow first, on a clock.
    const funding = await forClient();
    expect(funding).toMatchObject({ ref: opened.tradeRef, href: `/trades/${opened.tradeRef}`, move: 'send USDT', more: 0 });
    expect(funding?.dueBy).not.toBeNull();
    expect(await forTrader()).toBeNull();

    // The escrow is funded: the rupees are the trader's to pay.
    await settleFirstLeg(w, opened.tradeId);
    expect(await forClient()).toBeNull();
    expect(await forTrader()).toMatchObject({ ref: opened.orderRef, href: `/traders/orders/${opened.orderRef}`, move: 'pay INR' });

    // The trader says it paid: the client confirms the rupees.
    await payClient(w, opened, { confirm: false });
    expect(await forClient()).toMatchObject({ ref: opened.tradeRef, move: 'confirm the INR' });
    expect(await forTrader()).toBeNull();
  });
});
