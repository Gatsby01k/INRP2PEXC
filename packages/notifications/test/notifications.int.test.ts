import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAs } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import { createQuote, createRequest, declineRequest, sendQuote } from '@inrp2p/quotes';
import { confirmPayout, createPayoutLeg, recordLegEvidence, sendPayoutLeg } from '@inrp2p/settlement';
import { clientInbox, clientNotificationHandler, markNotificationsRead, unreadCount } from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from '../../settlement/test/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld('client_notifications', { capacityInr: '500000000.00' });
});
afterAll(async () => w.close());

/** Runs the outbox the way the worker does — as the worker role — with only the handler under test registered. */
const deliver = () => dispatchOutbox(w.t.worker, [clientNotificationHandler(w.app)]);

const inbox = () => clientInbox(w.app, w.clientId, { limit: 100 });

async function payLeg(tradeId: string, amount: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
  });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
  await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

describe('what a client is told', () => {
  it('tells them a quote is ready, with the figure they will act on', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '500', bankAccountId: w.bankAccountId,
    });
    const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', {
      requestId: request.requestId, routeId: w.routeId, clientRate: '90.000000', validitySeconds: 120,
    });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
    await deliver();

    const sent = (await inbox()).find((n) => n.kind === 'QUOTE_SENT');
    expect(sent).toBeDefined();
    expect(sent!.body).toContain('₹45000.00');
    expect(sent!.subjectRef).toMatch(/^QT-\d{6}-\d{4}$/);
    expect(sent!.href).toBe('/exchange');
    expect(sent!.read).toBe(false);
  });

  it('tells them the desk could not price a request, in the desk’s own words', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '13', bankAccountId: w.bankAccountId,
    });
    await runAs(w.app, declineRequest(w.dealer.actor), w.dealer.ref, 'request.decline', { requestId: request.requestId, reason: 'Too small for today' });
    await deliver();
    expect((await inbox()).find((n) => n.kind === 'REQUEST_DECLINED')?.body).toContain('Too small for today');
  });

  it('follows one trade from open to settled, and says "complete" only when it is', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });
    await deliver();
    const opened = (await inbox()).find((n) => n.subjectRef === trade.tradeRef && n.kind === 'TRADE_OPENED');
    expect(opened?.body).toContain('100.000000 USDT');
    expect(opened?.href).toBe(`/trades/${trade.tradeRef}`);

    await settleFirstLeg(w, trade.tradeId);
    await payLeg(trade.tradeId, '4000.00');
    await deliver();
    const partial = (await inbox()).filter((n) => n.subjectRef === trade.tradeRef);
    expect(partial.some((n) => n.kind === 'PAYOUT_CONFIRMED')).toBe(true);
    expect(partial.some((n) => n.kind === 'TRADE_COMPLETED')).toBe(false);

    await payLeg(trade.tradeId, '5000.00');
    await deliver();
    const settled = (await inbox()).filter((n) => n.subjectRef === trade.tradeRef);
    expect(settled.some((n) => n.kind === 'TRADE_COMPLETED')).toBe(true);
  });

  it('never carries the desk’s own vocabulary into a client’s inbox', async () => {
    const rows = await inbox();
    expect(rows.length).toBeGreaterThan(0);
    for (const n of rows) {
      expect(`${n.title} ${n.body}`).not.toMatch(/route|margin|spread|provider|custody|dealer|obligation|liquidity|suspense/i);
    }
  });
});

describe('delivery is at-least-once, the inbox is not', () => {
  it('says the same thing once however often the event is redelivered', async () => {
    const before = await inbox();
    const event = await w.t.owner
      .selectFrom('outbox_event')
      .select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id'])
      .where('type', '=', 'trade.opened')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

    // At-least-once at the outbox boundary: the handler is invoked again with the same event, exactly as it
    // would be after a crash between the external effect and the delivery record.
    const handler = clientNotificationHandler(w.app);
    for (let i = 0; i < 3; i++) {
      await handler.run({
        id: event.id,
        type: event.type,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        payload: event.payload,
        correlationId: event.correlation_id,
      });
    }
    expect((await inbox()).length).toBe(before.length);
  });
});

describe('reading the inbox', () => {
  it('counts what is unread, and stops counting what has been read', async () => {
    const before = await unreadCount(w.app, w.clientId);
    expect(before).toBeGreaterThan(0);

    const first = (await inbox()).filter((n) => !n.read).slice(0, 2);
    const marked = await markNotificationsRead(w.app, w.clientId, first.map((n) => n.id));
    expect(marked).toBe(first.length);
    expect(await unreadCount(w.app, w.clientId)).toBe(before - first.length);

    // Marking again changes nothing: a read receipt is not an event.
    expect(await markNotificationsRead(w.app, w.clientId, first.map((n) => n.id))).toBe(0);
  });

  it('cannot be read or marked by another client', async () => {
    const stranger = randomUUID();
    expect(await clientInbox(w.app, stranger)).toEqual([]);
    const mine = (await inbox())[0]!;
    expect(await markNotificationsRead(w.app, stranger, [mine.id])).toBe(0);
  });

  it('refuses an unreasonable request rather than scanning the table', async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID());
    await expect(markNotificationsRead(w.app, w.clientId, ids)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
