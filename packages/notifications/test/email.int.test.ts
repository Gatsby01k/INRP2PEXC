import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { runAs } from '@inrp2p/identity/testing';
import { FakeNotificationAdapter } from '@inrp2p/adapters/testing';
import { UnconfiguredNotificationAdapter, isNotificationProviderConfigured } from '@inrp2p/adapters';
import { dispatchOutbox } from '@inrp2p/outbox';
import { createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { acknowledgedSignalHandler, clientInbox, clientNotificationEmailHandler, clientNotificationHandler } from '../src/index.ts';
import { type World, createWorld } from '../../settlement/test/world.ts';

/**
 * The email channel carries the inbox's own words, once, to the people the desk actually knows.
 *
 * Everything worth asserting here is about restraint: the same message, not a second one written for email; one
 * send per event however often the event is redelivered; nothing at all to an address nobody has verified.
 */
let w: World;
let mailbox: FakeNotificationAdapter;

beforeAll(async () => {
  w = await createWorld('client_email', { capacityInr: '500000000.00' });
  mailbox = new FakeNotificationAdapter();
});
afterAll(async () => w.close());

/** The worker's order: the inbox row is written first, and the email channel reads it. */
const deliver = () =>
  dispatchOutbox(w.t.worker, [
    clientNotificationHandler(w.app),
    acknowledgedSignalHandler(),
    clientNotificationEmailHandler(w.app, mailbox, { linkBase: 'https://app.inrp2p.test' }),
  ]);

/** Every login of this client at once: the channel picks its recipients from the client, not from one person. */
const setVerified = (verified: boolean) =>
  sql`update auth_user set email_verified = ${verified} where id in (select user_id from client_user where client_id = ${w.clientId})`.execute(w.t.owner);

async function sendAQuote(amount: string) {
  const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount, bankAccountId: w.bankAccountId,
  });
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', {
    requestId: request.requestId, routeId: w.routeId, clientRate: '90.000000', validitySeconds: 300,
  });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  return quote.quoteId;
}

describe('the email channel', () => {
  it('sends the inbox’s own message, with a link back into the client product', async () => {
    await setVerified(true);
    await sendAQuote('500');
    await deliver();

    const inbox = (await clientInbox(w.app, w.clientId, { limit: 50 })).find((n) => n.kind === 'QUOTE_SENT');
    expect(inbox).toBeDefined();
    const sent = mailbox.notifications.find((m) => m.body === inbox!.body);
    expect(sent, 'the quote email').toBeDefined();
    expect(sent!.subject).toBe(inbox!.title);
    expect(sent!.link).toBe('https://app.inrp2p.test/exchange');
    expect(sent!.to).toContain('@');
  });

  it('records that it went, and never sends the same message twice', async () => {
    const before = mailbox.notifications.length;
    const row = await w.t.owner
      .selectFrom('client_notification')
      .select(['id', 'outbox_event_id', 'email_sent_at'])
      .where('kind', '=', 'QUOTE_SENT')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.email_sent_at).not.toBeNull();

    // At-least-once at the outbox boundary: the handler is invoked again with the same event, exactly as it
    // would be after a crash between the external effect and the delivery record.
    const handler = clientNotificationEmailHandler(w.app, mailbox, { linkBase: 'https://app.inrp2p.test' });
    const event = await w.t.owner
      .selectFrom('outbox_event')
      .select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id'])
      .where('id', '=', row.outbox_event_id)
      .executeTakeFirstOrThrow();
    for (let i = 0; i < 3; i++) {
      await handler.run({ id: event.id, type: event.type, aggregateType: event.aggregate_type, aggregateId: event.aggregate_id, payload: event.payload, correlationId: event.correlation_id });
    }
    expect(mailbox.notifications.length).toBe(before);
  });

  it('says nothing to an address nobody verified', async () => {
    await setVerified(false);
    const before = mailbox.notifications.length;
    await sendAQuote('600');
    await deliver();
    expect(mailbox.notifications.length).toBe(before);
    // The inbox still has it: the in-app channel is the one of record.
    expect((await clientInbox(w.app, w.clientId, { limit: 50 })).filter((n) => n.kind === 'QUOTE_SENT').length).toBeGreaterThan(1);
    await setVerified(true);
  });

  it('an outage is not a delivery: the recipient stays pending, the event is retried, and it goes once when the provider is back (E1)', async () => {
    await setVerified(true);
    const before = mailbox.notifications.length;
    mailbox.failNext = true;
    await sendAQuote('700');
    await deliver();
    const row = await w.t.owner.selectFrom('client_notification').select(['id', 'outbox_event_id', 'email_sent_at']).where('kind', '=', 'QUOTE_SENT').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    // Every verified user of the client is a recipient of its own; the outage hit the first send only.
    const rows = await w.t.owner.selectFrom('client_notification_email').select(['status', 'attempts', 'last_error', 'provider_message_id']).where('notification_id', '=', row.id).orderBy('id').execute();
    const recipients = rows.length;
    expect(recipients).toBeGreaterThan(1);
    expect(rows.filter((r) => r.status === 'PENDING')).toEqual([{ status: 'PENDING', attempts: 1, last_error: 'PROVIDER_UNAVAILABLE', provider_message_id: null }]);
    expect(rows.filter((r) => r.status === 'SENT')).toHaveLength(recipients - 1);
    expect(row.email_sent_at).toBeNull();
    const event = await w.t.owner.selectFrom('outbox_event').select(['dispatched_at', 'last_error']).where('id', '=', row.outbox_event_id).executeTakeFirstOrThrow();
    expect(event.dispatched_at).toBeNull();
    expect(event.last_error).toMatch(/^EMAIL_DELIVERY_PENDING/);
    expect(mailbox.notifications.length).toBe(before + recipients - 1);

    await deliver();
    const sent = await w.t.owner.selectFrom('client_notification_email').select(['status', 'provider_message_id']).where('notification_id', '=', row.id).execute();
    expect(sent.every((r) => r.status === 'SENT' && r.provider_message_id?.startsWith('fake-notification-'))).toBe(true);
    expect((await w.t.owner.selectFrom('client_notification').select('email_sent_at').where('id', '=', row.id).executeTakeFirstOrThrow()).email_sent_at).not.toBeNull();
    // Each recipient got it once: the retry sent only the one that had not gone.
    expect(mailbox.notifications.length).toBe(before + recipients);
  });

  it('a refusal is recorded as FAILED with its code, never as sent, and is not retried', async () => {
    const before = mailbox.notifications.length;
    mailbox.failNext = 'PERMANENT';
    await sendAQuote('800');
    await deliver();
    const row = await w.t.owner.selectFrom('client_notification').select(['id', 'outbox_event_id', 'email_sent_at']).where('kind', '=', 'QUOTE_SENT').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    const rows = await w.t.owner.selectFrom('client_notification_email').select(['status', 'last_error', 'failed_at']).where('notification_id', '=', row.id).execute();
    expect(rows.filter((r) => r.status === 'FAILED')).toEqual([{ status: 'FAILED', last_error: 'PROVIDER_REJECTED_422', failed_at: expect.any(Date) }]);
    expect(rows.filter((r) => r.status === 'SENT')).toHaveLength(rows.length - 1);
    expect(row.email_sent_at).toBeNull();
    // The event is done — nothing more can be sent for it — and the refusal stays visible on its own row.
    expect((await w.t.owner.selectFrom('outbox_event').select('dispatched_at').where('id', '=', row.outbox_event_id).executeTakeFirstOrThrow()).dispatched_at).not.toBeNull();
    const afterFirst = mailbox.notifications.length;
    expect(afterFirst).toBe(before + rows.length - 1);
    await deliver();
    expect(mailbox.notifications.length).toBe(afterFirst);
  });

  it('is not registered at all when there is no provider, so one channel cannot take the other down', () => {
    expect(isNotificationProviderConfigured(new UnconfiguredNotificationAdapter())).toBe(false);
    expect(isNotificationProviderConfigured(mailbox)).toBe(true);
  });
});
