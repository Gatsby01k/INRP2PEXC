import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { runAs } from '@inrp2p/identity/testing';
import { FakeNotificationAdapter } from '@inrp2p/adapters/testing';
import { UnconfiguredNotificationAdapter, isNotificationProviderConfigured } from '@inrp2p/adapters';
import { dispatchOutbox } from '@inrp2p/outbox';
import { createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { EMAIL_STALE_AFTER_HOURS, acknowledgedSignalHandler, clientInbox, clientNotificationEmailHandler, clientNotificationHandler, emailDeliveryId } from '../src/index.ts';
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

  it('asks the provider with the same key when a restored database delivers the event again (E4)', async () => {
    const row = await w.t.owner
      .selectFrom('client_notification')
      .select(['id', 'outbox_event_id'])
      .where('kind', '=', 'QUOTE_SENT')
      .where('email_sent_at', 'is not', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    const before = await w.t.owner.selectFrom('client_notification_email').select(['id', 'user_id']).where('notification_id', '=', row.id).orderBy('id').execute();
    expect(before.length).toBeGreaterThan(0);
    for (const d of before) expect(d.id).toBe(emailDeliveryId(row.outbox_event_id, d.user_id));
    const sentSoFar = mailbox.notifications.length;

    // A database restored to before the emails were recorded: the event and the inbox row survived, the email rows did not.
    await w.t.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`delete from client_notification_email where notification_id = ${row.id}`.execute(tx);
      await sql`update client_notification set email_sent_at = null where id = ${row.id}`.execute(tx);
    });
    const handler = clientNotificationEmailHandler(w.app, mailbox, { linkBase: 'https://app.inrp2p.test' });
    const event = await w.t.owner.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).where('id', '=', row.outbox_event_id).executeTakeFirstOrThrow();
    await handler.run({ id: event.id, type: event.type, aggregateType: event.aggregate_type, aggregateId: event.aggregate_id, payload: event.payload, correlationId: event.correlation_id });

    // The same delivery ids, so the same idempotency keys: the provider answers with the email it already sent.
    const after = await w.t.owner.selectFrom('client_notification_email').select(['id', 'status']).where('notification_id', '=', row.id).orderBy('id').execute();
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    expect(after.every((d) => d.status === 'SENT')).toBe(true);
    expect(mailbox.notifications.length).toBe(sentSoFar);
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

describe('an email that would arrive as old news is withheld; the inbox keeps it (D-18)', () => {
  /** The worker's order, with the email channel reading the business clock as it is `hoursLater` from now. */
  async function deliverLater(hoursLater: number) {
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + hoursLater * 3_600_000));
    try {
      await dispatchOutbox(w.t.worker, [
        clientNotificationHandler(w.app),
        acknowledgedSignalHandler(),
        clientNotificationEmailHandler(clock.db, mailbox, { linkBase: 'https://app.inrp2p.test' }),
      ]);
    } finally {
      await clock.set(null);
    }
    return clock.db;
  }
  const notificationOf = async (quoteId: string) => {
    const event = await w.t.owner.selectFrom('outbox_event').select('id').where('type', '=', 'quote.sent').where(sql<boolean>`payload->>'quoteId' = ${quoteId}`).executeTakeFirstOrThrow();
    return w.t.owner.selectFrom('client_notification').select(['id', 'kind', 'email_sent_at', 'outbox_event_id']).where('outbox_event_id', '=', event.id).executeTakeFirstOrThrow();
  };

  it(`more than ${EMAIL_STALE_AFTER_HOURS} h old when first dispatched: the inbox entry is written, and no email`, async () => {
    await setVerified(true);
    const sentBefore = mailbox.notifications.length;
    const quoteId = await sendAQuote('610');
    const later = await deliverLater(EMAIL_STALE_AFTER_HOURS + 1);

    const n = await notificationOf(quoteId);
    expect(n.kind).toBe('QUOTE_SENT');
    expect(n.email_sent_at).toBeNull();
    expect(await w.t.owner.selectFrom('client_notification_email').select('id').where('notification_id', '=', n.id).execute()).toEqual([]);
    expect(mailbox.notifications.length).toBe(sentBefore);
    // The inbox entry is the client's own: it is there to read.
    expect((await clientInbox(w.app, w.clientId, { limit: 100 })).some((x) => x.id === n.id)).toBe(true);

    // Delivered again (a crash, a restored database): still no email.
    const handler = clientNotificationEmailHandler(later, mailbox, { linkBase: 'https://app.inrp2p.test' });
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + (EMAIL_STALE_AFTER_HOURS + 2) * 3_600_000));
    try {
      await clientNotificationEmailHandler(clock.db, mailbox, {}).run({ id: n.outbox_event_id, type: 'quote.sent', aggregateType: 'quote', aggregateId: quoteId, payload: { quoteId }, correlationId: 'redelivery' });
    } finally {
      await clock.set(null);
    }
    expect(handler.name).toBe('client_notification_email');
    expect(mailbox.notifications.length).toBe(sentBefore);
    expect(await w.t.owner.selectFrom('client_notification_email').select('id').where('notification_id', '=', n.id).execute()).toEqual([]);
  });

  it(`less than ${EMAIL_STALE_AFTER_HOURS} h old: sent as always`, async () => {
    await setVerified(true);
    const sentBefore = mailbox.notifications.length;
    const quoteId = await sendAQuote('620');
    await deliverLater(EMAIL_STALE_AFTER_HOURS - 1);
    const n = await notificationOf(quoteId);
    expect(n.email_sent_at).not.toBeNull();
    const deliveries = await w.t.owner.selectFrom('client_notification_email').select('status').where('notification_id', '=', n.id).execute();
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.status === 'SENT')).toBe(true);
    expect(mailbox.notifications.length).toBe(sentBefore + deliveries.length);
  });
});
