import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeNotificationAdapter } from '@inrp2p/adapters/testing';
import { NotificationDeliveryError, type OtpEmail } from '@inrp2p/adapters';
import { dispatchOutbox } from '@inrp2p/outbox';
import { runAs } from '@inrp2p/identity/testing';
import { acceptanceCodeHandler, createQuote, createRequest, deliverAcceptanceCode, requestLinkOtp, sendQuote } from '../src/index.ts';
import { createScenario, ipHash, type Scenario } from './scenario.ts';

/**
 * E1 (TD-04): an acceptance code is sent once, only while its challenge is open and unexpired, and a provider that
 * fails or answers ambiguously never turns into "delivered" — the code stays sealed until it really went.
 */
let s: Scenario;
beforeAll(async () => {
  s = await createScenario('quotes_delivery');
});
afterAll(async () => s.close());

async function linkedQuote(): Promise<string> {
  const r = await runAs(s.app, createRequest(s.dealer.actor, {}), s.dealer.ref, 'request.create', { clientId: s.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: s.bankAccountId });
  const q = await runAs(s.app, createQuote(s.dealer.actor, {}), s.dealer.ref, 'quote.create', { requestId: r.requestId, routeId: s.routeId, clientRate: '92.000000', validitySeconds: 300 });
  let token: string | null = null;
  await runAs(s.app, sendQuote(s.dealer.actor, {}, (x) => { token = x; }), s.dealer.ref, 'quote.send', { quoteId: q.quoteId, withLink: true });
  return token!;
}

const ask = (token: string) => requestLinkOtp(s.app, s.deps, { token, clientUserId: s.acceptor.clientUserId, ipHash: ipHash(`delivery-${randomUUID()}`) });
const deliveryOf = async (challengeId: string) =>
  s.app.selectFrom('otp_delivery').select(['id', 'code_sealed', 'erased_reason', 'delivered_at', 'provider_message_id']).where('challenge_id', '=', challengeId).executeTakeFirstOrThrow();

/** A provider that takes its time: the send starts, and finishes when the test says so. */
class SlowProvider extends FakeNotificationAdapter {
  started!: Promise<void>;
  #start!: () => void;
  #release!: () => void;
  #gate!: Promise<void>;
  constructor() {
    super();
    this.reset();
  }
  reset(): void {
    this.started = new Promise((r) => (this.#start = r));
    this.#gate = new Promise((r) => (this.#release = r));
  }
  release(): void {
    this.#release();
  }
  override async sendAcceptanceCode(message: OtpEmail) {
    this.#start();
    await this.#gate;
    return super.sendAcceptanceCode(message);
  }
}

describe('acceptance code delivery (E1)', () => {
  it('a provider outage leaves the code sealed and undelivered; the retry sends it once, under the same delivery', async () => {
    const mail = new FakeNotificationAdapter();
    const handlers = [acceptanceCodeHandler(s.app, s.deps, mail), { name: 'sink', handles: () => true, run: async () => {} }];
    const challenge = await ask(await linkedQuote());
    mail.failNext = true;
    await dispatchOutbox(s.t.worker, handlers);
    const waiting = await deliveryOf(challenge.challengeId);
    expect(waiting).toMatchObject({ erased_reason: null, delivered_at: null, provider_message_id: null });
    expect(waiting.code_sealed).not.toBeNull();
    const event = await s.app.selectFrom('outbox_event').select(['attempts', 'last_error', 'dispatched_at']).where('type', '=', 'acceptance_otp.deliver').where('aggregate_id', '=', challenge.challengeId).executeTakeFirstOrThrow();
    expect(event).toMatchObject({ attempts: 1, dispatched_at: null });
    // What is recorded about the failure is a code — never the code being delivered.
    expect(event.last_error).toMatch(/^PROVIDER_UNAVAILABLE/);
    expect(mail.sent).toHaveLength(0);

    await dispatchOutbox(s.t.worker, handlers);
    const sent = await deliveryOf(challenge.challengeId);
    expect(sent).toMatchObject({ code_sealed: null, erased_reason: 'DELIVERED', provider_message_id: 'fake-1' });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.deliveryId).toBe(sent.id);
  });

  it('a refusal is not a delivery either, and a code past its expiry is erased instead of sent', async () => {
    const mail = new FakeNotificationAdapter();
    const refused = await ask(await linkedQuote());
    mail.failNext = 'PERMANENT';
    const id = (await deliveryOf(refused.challengeId)).id;
    await expect(deliverAcceptanceCode(s.app, s.deps, mail, { deliveryId: id })).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect((await deliveryOf(refused.challengeId)).code_sealed).not.toBeNull();

    const late = await ask(await linkedQuote());
    const clock = await s.t.pinnedClock();
    try {
      await clock.set(new Date(Date.now() + 10 * 60_000));
      expect(await deliverAcceptanceCode(clock.db, s.deps, mail, { deliveryId: (await deliveryOf(late.challengeId)).id })).toBe('CHALLENGE_CLOSED');
    } finally {
      await clock.set(null);
    }
    expect(await deliveryOf(late.challengeId)).toMatchObject({ code_sealed: null, erased_reason: 'CHALLENGE_CLOSED', delivered_at: null });
    expect(mail.sent).toHaveLength(0);
  });

  it('a new code waits for a send already under way, and a code superseded first is never sent', async () => {
    const token = await linkedQuote();
    const first = await ask(token);
    const slow = new SlowProvider();
    const firstDelivery = (await deliveryOf(first.challengeId)).id;
    const sending = deliverAcceptanceCode(s.app, s.deps, slow, { deliveryId: firstDelivery });
    await slow.started;
    // The recipient asks for another code while the first is still on its way: closing the first waits for its send.
    let replaced = false;
    const replacing = ask(token).then((c) => {
      replaced = true;
      return c;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(replaced).toBe(false);
    slow.release();
    expect(await sending).toBe('SENT');
    const second = await replacing;
    expect((await s.app.selectFrom('acceptance_challenge').select('status').where('id', '=', first.challengeId).executeTakeFirstOrThrow()).status).toBe('SUPERSEDED');
    expect(slow.sent.map((m) => m.deliveryId)).toEqual([firstDelivery]);

    // The other order: superseded before its send began — erased, and nothing goes out.
    const third = await ask(token);
    expect(await deliverAcceptanceCode(s.app, s.deps, slow, { deliveryId: (await deliveryOf(second.challengeId)).id })).toBe('ALREADY_ERASED');
    expect((await deliveryOf(second.challengeId)).erased_reason).toBe('CHALLENGE_CLOSED');
    expect(slow.sent).toHaveLength(1);
    void third;
  });
});
