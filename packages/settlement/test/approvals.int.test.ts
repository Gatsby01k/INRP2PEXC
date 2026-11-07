import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import { approveChainSend } from '@inrp2p/network';
import { payoutApprovalPolicy, setPayoutApprovalPolicy } from '../src/index.ts';
import { type RailsWorld, completeDeal, createRailsWorld, railsSettle, railsTrade, railsTrader } from '../../../test/integration/rails-world.ts';

/**
 * C1 (SECURITY §4): above a threshold — ₹2,500,000 by default, a USDT payout valued at its deal's frozen client rate — USDT
 * does not leave an escrow on the system's word alone: the signer's send waits for a person, and only an approved send's
 * leg can be confirmed. Rupees a trader pays a client are the trader's own and are confirmed by the client who got them.
 */
let w: RailsWorld;
let trader: Awaited<ReturnType<typeof railsTrader>>;

beforeAll(async () => {
  w = await createRailsWorld('approvals');
  trader = await railsTrader(w, 'Large Desk', {
    buy: { capacity: '1000000000', rate: '103.00', min: '100', max: '1000000000' },
    sell: { capacity: '10000000', rate: '105.00', min: '1', max: '10000000' },
  });
});
afterAll(async () => w.close());

/** A client buying `amount` at ₹106, through to the signer's turn: the escrow funded, the rupees confirmed by the trader. */
async function purchase(amount: string) {
  const trade = await railsTrade(w, trader, { direction: 'BUY_USDT', amount, clientRate: '106.000000', plannedClientRate: '106.000000' });
  await completeDeal(w, trader, trade);
  const send = await w.app.selectFrom('chain_send').selectAll().where('trade_id', '=', trade.tradeId).where('purpose', '=', 'CLIENT_PAYOUT').executeTakeFirstOrThrow();
  const state = (await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state;
  return { trade, send, state };
}

describe('a large payout out of an escrow waits for a person (C1)', () => {
  it('measures it in rupees at the deal’s frozen rate: below the threshold it goes, a paisa above it waits', async () => {
    // ₹2,499,480 at ₹106: the system sends it.
    const below = await purchase('23580');
    expect(below.send).toMatchObject({ status: 'CONFIRMED', needs_approval: false });
    expect(below.state).toBe('COMPLETED');

    // ₹2,500,540: nothing is signed until someone says so.
    const above = await purchase('23590');
    expect(above.send).toMatchObject({ status: 'AWAITING_APPROVAL', needs_approval: true, approved_by: null });
    expect(above.state).not.toBe('COMPLETED');
    expect(await w.app.selectFrom('chain_send_attempt').select('id').where('send_id', '=', above.send.id).execute()).toEqual([]);

    // Not by a role without the permission.
    await expect(runAs(w.app, approveChainSend(w.dealer.actor), w.dealer.ref, 'chain_send.approve', { sendId: above.send.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, approveChainSend(w.finance.actor), w.finance.ref, 'chain_send.approve', { sendId: above.send.id });
    await railsSettle(w, above.trade.tradeId);
    const after = await w.app.selectFrom('chain_send').select(['status', 'approved_by']).where('id', '=', above.send.id).executeTakeFirstOrThrow();
    expect(after).toEqual({ status: 'CONFIRMED', approved_by: w.finance.ref.id });
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', above.trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
  });

  it('the database refuses a confirmation that breaks the rule, whatever code writes it (IX090)', async () => {
    const { send } = await purchase('30000');
    const legId = send.settlement_leg_id!;
    const complete = (by: string) => sql`update settlement_leg set status = 'COMPLETED', confirmed_at = now(), confirmed_by = ${by} where id = ${legId}`.execute(w.app);
    await expect(complete('SYSTEM:payout_leg.confirm')).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
    await expect(sql`update settlement_leg set status = 'COMPLETED', confirmed_at = now() where id = ${legId}`.execute(w.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
    await expect(sql`update settlement_leg set sent_by = ${w.settlementOp2.ref.id} where id = ${legId}`.execute(w.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
  });

  it('asks no second person for rupees a trader paid: the client who received them confirms them, whatever the amount', async () => {
    const trade = await railsTrade(w, trader, { direction: 'SELL_USDT', amount: '50000', clientRate: '102.000000', plannedClientRate: '102.000000' });
    await completeDeal(w, trader, trade);
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
  });
});

describe('the threshold', () => {
  it('is the OWNER’s to move or switch off, with a reason, on the record', async () => {
    const set = (who: TestOperator, payload: { enabled: boolean; threshold: string; reason: string }) => runAs(w.app, setPayoutApprovalPolicy(who.actor), who.ref, 'settings.payout_approval', payload);
    await expect(set(w.settlementOp, { enabled: false, threshold: '2500000.00', reason: 'single-person desk this week' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set(w.owner, { enabled: false, threshold: '2500000.00', reason: 'short' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await set(w.owner, { enabled: false, threshold: '2500000.00', reason: 'single-person desk this week' });
    expect(await payoutApprovalPolicy(w.app)).toMatchObject({ enabled: false, threshold: '2500000.00', setBy: w.owner.ref.id });

    const off = await purchase('30000'); // switched off: the system sends it
    expect(off.send).toMatchObject({ status: 'CONFIRMED', needs_approval: false });

    await set(w.owner, { enabled: true, threshold: '1000000.00', reason: 'second person back on the desk' });
    const history = await w.app.selectFrom('payout_approval_policy').select(['enabled', 'threshold_inr_minor']).orderBy('set_at').orderBy('id').execute();
    expect(history.map((h) => [h.enabled, h.threshold_inr_minor])).toEqual([[true, 250000000n], [false, 250000000n], [true, 100000000n]]);
    const audits = await w.app.selectFrom('audit_event').select('after').where('action', '=', 'settings.payout_approval_changed').orderBy('seq').execute();
    expect(audits.map((a) => (a.after as { enabled: boolean }).enabled)).toEqual([false, true]);
    await expect(sql`delete from payout_approval_policy`.execute(w.app)).rejects.toThrow();
    await set(w.owner, { enabled: true, threshold: '2500000.00', reason: 'back to the SECURITY §4 default' });
  });
});
