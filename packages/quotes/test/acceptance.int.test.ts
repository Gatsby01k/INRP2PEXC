import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { FakeNotificationAdapter } from '@inrp2p/adapters/testing';
import { dispatchOutbox, type OutboxHandler } from '@inrp2p/outbox';
import { archiveBankAccount } from '@inrp2p/clients';
import { runAs } from '@inrp2p/identity/testing';
import { publishRouteRate } from '@inrp2p/pricing';
import {
  acceptQuote, acceptQuoteViaLink, acceptanceCodeHandler, assertClientSafe, createQuote, createRequest, deliverAcceptanceCode, rejectQuote,
  rejectQuoteViaLink, requestLinkOtp, sendQuote, viewQuoteLink,
} from '../src/index.ts';
import { createScenario, ipHash, useExchangeExecution, type ClientPerson, type Scenario } from './scenario.ts';

let s: Scenario;
let mail: FakeNotificationAdapter;
let handlers: OutboxHandler[];

beforeAll(async () => {
  s = await createScenario('quotes_acceptance');
  mail = new FakeNotificationAdapter();
  handlers = [
    acceptanceCodeHandler(s.app, s.deps, mail),
    // Every other Phase 3 event has its consumer in later phases; the sink keeps the dispatcher honest here.
    { name: 'test-sink', handles: () => true, run: async () => {} },
  ];
});
afterAll(async () => s.close());

interface LiveQuote {
  readonly requestId: string;
  readonly quoteId: string;
  readonly token: string;
}

async function liveQuote(opts: { direction?: 'SELL_USDT' | 'BUY_USDT'; validitySeconds?: number; clientRate?: string; scenario?: Scenario } = {}): Promise<LiveQuote> {
  const sc = opts.scenario ?? s;
  const direction = opts.direction ?? 'SELL_USDT';
  const r = await runAs(sc.app, createRequest(sc.dealer.actor, {}), sc.dealer.ref, 'request.create', {
    clientId: sc.clientId, direction, fixedSide: 'BASE' as const, amount: '1000',
    ...(direction === 'SELL_USDT' ? { bankAccountId: sc.bankAccountId } : { walletId: sc.walletId }),
  });
  const q = await runAs(sc.app, createQuote(sc.dealer.actor, {}), sc.dealer.ref, 'quote.create', {
    requestId: r.requestId, routeId: sc.routeId, clientRate: opts.clientRate ?? (direction === 'SELL_USDT' ? '92.000000' : '94.000000'), validitySeconds: opts.validitySeconds ?? 300,
  });
  let token: string | null = null;
  await runAs(sc.app, sendQuote(sc.dealer.actor, {}, (x) => { token = x; }), sc.dealer.ref, 'quote.send', { quoteId: q.quoteId, withLink: true });
  return { requestId: r.requestId, quoteId: q.quoteId, token: token! };
}

/** Requests a code and runs the delivery handler, returning the code exactly as the recipient would receive it. */
async function otp(link: LiveQuote, person: ClientPerson = s.acceptor, ip = `otp-${randomUUID()}`): Promise<{ challengeId: string; code: string }> {
  const challenge = await requestLinkOtp(s.app, s.deps, { token: link.token, clientUserId: person.clientUserId, ipHash: ipHash(ip) });
  await dispatchOutbox(s.t.worker, handlers);
  const code = mail.lastCodeFor(person.email);
  expect(code).toMatch(/^[0-9]{6}$/);
  return { challengeId: challenge.challengeId, code: code! };
}

const otherCode = (code: string) => String((Number.parseInt(code, 10) + 1) % 1_000_000).padStart(6, '0');

describe('acceptance codes (D-01, SECURITY §2.3)', () => {
  it('exit: a link holder cannot accept or reject without a code, and viewing changes nothing', async () => {
    const link = await liveQuote();
    await viewQuoteLink(s.app, {}, { token: link.token, ipHash: ipHash('view-1') });
    await expect(acceptQuoteViaLink(s.app, s.deps, { token: link.token, challengeId: randomUUID(), code: '000000', idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'OTP_INVALID', message: 'The code is invalid or has expired.' });
    await expect(rejectQuoteViaLink(s.app, s.deps, { token: link.token, challengeId: randomUUID(), code: '000000', idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect((await s.app.selectFrom('quote').select('status').where('id', '=', link.quoteId).executeTakeFirstOrThrow()).status).toBe('SENT');
    // A local "decline" on the page is never a server call, so nothing is audited for it.
    expect(await s.app.selectFrom('audit_event').select('action').where('action', 'like', '%local_decline%').execute()).toEqual([]);
  });

  it('exit: the code reaches the recipient only; it is absent from the outbox, audit and idempotency store', async () => {
    const link = await liveQuote();
    const { challengeId, code } = await otp(link);
    expect(mail.sent.at(-1)).toMatchObject({ to: s.acceptor.email, quoteRef: expect.stringMatching(/^QT-/) });
    expect(JSON.stringify(mail.sent.at(-1))).not.toContain('HDFC');

    const delivery = await s.t.owner.selectFrom('otp_delivery').selectAll().where('challenge_id', '=', challengeId).executeTakeFirstOrThrow();
    expect(delivery).toMatchObject({ code_sealed: null, erased_reason: 'DELIVERED', provider_message_id: expect.stringContaining('fake-') });
    expect(delivery.delivered_at).not.toBeNull();

    const outbox = await s.t.owner.selectFrom('outbox_event').select('payload').where('aggregate_id', '=', challengeId).execute();
    const audits = await s.t.owner.selectFrom('audit_event').select(['action', 'after']).where('entity_id', '=', challengeId).execute();
    const idem = await s.t.owner.selectFrom('idempotency_key').select('response').where('scope', '=', 'quote_link.request_otp').execute();
    for (const blob of [outbox, audits, idem]) expect(JSON.stringify(blob)).not.toContain(code);
    expect(audits.map((a) => a.action)).toContain('acceptance_otp.sent');
    // The challenge stores only a salted hash of the code.
    const challenge = await s.t.owner.selectFrom('acceptance_challenge').selectAll().where('id', '=', challengeId).executeTakeFirstOrThrow();
    expect(JSON.stringify(challenge)).not.toContain(code);
    expect(challenge.destination_masked).toMatch(/^.•••@/);
  });

  it('delivery is at-least-once safe: a repeat never resends and never regenerates a code', async () => {
    const link = await liveQuote();
    const { challengeId } = await otp(link);
    const deliveryId = (await s.t.owner.selectFrom('otp_delivery').select('id').where('challenge_id', '=', challengeId).executeTakeFirstOrThrow()).id;
    const before = mail.sent.length;
    expect(await deliverAcceptanceCode(s.app, s.deps, mail, { deliveryId })).toBe('ALREADY_ERASED');
    expect(mail.sent.length).toBe(before);
    // An erased code can never be restored, so no path can resurrect it.
    await expect(sql`update otp_delivery set code_sealed = 'v1.x.x.x.x.x', erased_reason = null where id = ${deliveryId}`.execute(s.t.owner)).rejects.toThrow(/erased OTP code cannot be restored/);
  });

  it('exit: wrong codes are counted and the challenge locks after 5 attempts; every failure reads the same', async () => {
    const link = await liveQuote();
    const { challengeId, code } = await otp(link);
    const wrong = otherCode(code);
    // The per-token decision limit is exercised separately; here the attempt counter is what must stop the guessing.
    const deps = { ...s.deps, policy: { decisionsPerTokenPerMinute: 50 } };
    for (let i = 1; i <= 4; i++) {
      await expect(acceptQuoteViaLink(s.app, deps, { token: link.token, challengeId, code: wrong, idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ code: 'OTP_INVALID', message: 'The code is invalid or has expired.', details: { attemptsRemaining: 5 - i } });
    }
    await expect(acceptQuoteViaLink(s.app, deps, { token: link.token, challengeId, code: wrong, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'OTP_ATTEMPTS_EXCEEDED', message: 'The code is invalid or has expired.' });
    // Even the correct code is dead once the challenge is locked.
    await expect(acceptQuoteViaLink(s.app, deps, { token: link.token, challengeId, code, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'OTP_ATTEMPTS_EXCEEDED' });
    const challenge = await s.t.owner.selectFrom('acceptance_challenge').select(['status', 'attempts']).where('id', '=', challengeId).executeTakeFirstOrThrow();
    expect(challenge).toEqual({ status: 'FAILED', attempts: 5 });
    expect((await s.app.selectFrom('quote').select('status').where('id', '=', link.quoteId).executeTakeFirstOrThrow()).status).toBe('SENT');
  });

  it('exit: a new code supersedes the previous one, and a consumed code cannot be reused', async () => {
    const link = await liveQuote();
    const first = await otp(link);
    const second = await otp(link);
    expect(second.code).not.toBe(first.code);
    await expect(acceptQuoteViaLink(s.app, s.deps, { token: link.token, challengeId: first.challengeId, code: first.code, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect((await s.t.owner.selectFrom('acceptance_challenge').select('status').where('id', '=', first.challengeId).executeTakeFirstOrThrow()).status).toBe('SUPERSEDED');

    const accepted = await acceptQuoteViaLink(s.app, s.deps, { token: link.token, challengeId: second.challengeId, code: second.code, idempotencyKey: randomUUID() });
    expect(accepted.tradeRef).toMatch(/^IX-\d{6}-\d{4}$/);
    // Replaying the same code on the decided quote fails at verification, without disclosing who decided it.
    await expect(acceptQuoteViaLink(s.app, s.deps, { token: link.token, challengeId: second.challengeId, code: second.code, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'QUOTE_NOT_SENT' });
    const consumed = await s.t.owner.selectFrom('acceptance_challenge').select(['status', 'consumed_for']).where('id', '=', second.challengeId).executeTakeFirstOrThrow();
    expect(consumed).toEqual({ status: 'CONSUMED', consumed_for: 'ACCEPT' });
  });

  it('exit: sends are limited per quote and per IP, and decisions are limited per token', async () => {
    const link = await liveQuote();
    const ip = `limit-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await requestLinkOtp(s.app, s.deps, { token: link.token, clientUserId: s.acceptor.clientUserId, ipHash: ipHash(ip) });
    await expect(requestLinkOtp(s.app, s.deps, { token: link.token, clientUserId: s.acceptor.clientUserId, ipHash: ipHash(ip) })).rejects.toMatchObject({ code: 'OTP_SEND_LIMIT' });
    // A different quote from the same IP hits the hourly IP budget instead.
    const other = await liveQuote();
    await expect(requestLinkOtp(s.app, { ...s.deps, policy: { otpSendsPerIpPerHour: 4 } }, { token: other.token, clientUserId: s.acceptor.clientUserId, ipHash: ipHash(ip) }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const decisions = { ...s.deps, policy: { decisionsPerTokenPerMinute: 2 } };
    const attempt = () => acceptQuoteViaLink(s.app, decisions, { token: other.token, challengeId: randomUUID(), code: '123456', idempotencyKey: randomUUID() });
    await expect(attempt()).rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(attempt()).rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(attempt()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('only authorized, email-verified recipients can be sent a code', async () => {
    const link = await liveQuote();
    const view = await viewQuoteLink(s.app, {}, { token: link.token, ipHash: ipHash('recipients') });
    expect(view.recipients.map((r) => r.clientUserId)).toEqual([s.acceptor.clientUserId]);
    for (const person of [s.viewer, s.unverified]) {
      await expect(requestLinkOtp(s.app, s.deps, { token: link.token, clientUserId: person.clientUserId, ipHash: ipHash(`rec-${randomUUID()}`) }))
        .rejects.toMatchObject({ code: 'OTP_RECIPIENT_INVALID' });
    }
    const other = await createScenario('quotes_otp_other');
    try {
      await expect(requestLinkOtp(s.app, s.deps, { token: link.token, clientUserId: other.acceptor.clientUserId, ipHash: ipHash(`rec-${randomUUID()}`) }))
        .rejects.toMatchObject({ code: 'OTP_RECIPIENT_INVALID' });
    } finally {
      await other.close();
    }
  });

  it('exit: a code never outlives the quote, and a valid code cannot accept an expired quote', async () => {
    const link = await liveQuote({ validitySeconds: 130 });
    const { challengeId, code } = await otp(link);
    const challenge = await s.t.owner.selectFrom('acceptance_challenge').select(['expires_at', 'sent_at']).where('id', '=', challengeId).executeTakeFirstOrThrow();
    const quote = await s.app.selectFrom('quote').select('expires_at').where('id', '=', link.quoteId).executeTakeFirstOrThrow();
    expect(challenge.expires_at.getTime()).toBeLessThanOrEqual(quote.expires_at!.getTime());
    expect(challenge.expires_at.getTime() - challenge.sent_at.getTime()).toBeLessThanOrEqual(300_000);

    const clock = await s.t.pinnedClock();
    await clock.set(new Date(quote.expires_at!.getTime() + 1));
    try {
      await expect(acceptQuoteViaLink(clock.db, s.deps, { token: link.token, challengeId, code, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
      await expect(requestLinkOtp(clock.db, s.deps, { token: link.token, clientUserId: s.acceptor.clientUserId, ipHash: ipHash(`exp-${randomUUID()}`) })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    } finally {
      await clock.set(null);
    }
  });
});

describe('quote decisions (STATE_MACHINES §2, FI-04..FI-07)', () => {
  const accept = (db: Scenario['app'], quoteId: string, person: ClientPerson = s.acceptor) =>
    runAs(db, acceptQuote(person.actor, s.deps), person.ref, 'quote.accept', { quoteId });

  it('exit: acceptance at T−1 ms succeeds and at T+1 ms fails, judged by database time', async () => {
    const early = await liveQuote();
    const late = await liveQuote();
    const expiry = async (quoteId: string) => (await s.app.selectFrom('quote').select('expires_at').where('id', '=', quoteId).executeTakeFirstOrThrow()).expires_at!;
    const clock = await s.t.pinnedClock();
    try {
      await clock.set(new Date((await expiry(early.quoteId)).getTime() - 1));
      const ok = await accept(clock.db, early.quoteId);
      expect(ok.trade.status).toBe('AWAITING_FIRST_LEG');
      await clock.set(new Date((await expiry(late.quoteId)).getTime() + 1));
      await expect(accept(clock.db, late.quoteId)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    } finally {
      await clock.set(null);
    }
    expect((await s.app.selectFrom('quote').select('status').where('id', '=', late.quoteId).executeTakeFirstOrThrow()).status).toBe('SENT');
  });

  it('exit: a quote can be accepted once — a second attempt and a concurrent attempt cannot double-open a trade', async () => {
    const link = await liveQuote();
    const first = await accept(s.app, link.quoteId);
    await expect(accept(s.app, link.quoteId)).rejects.toMatchObject({ code: 'QUOTE_ALREADY_ACCEPTED' });

    const race = await liveQuote();
    const results = await Promise.allSettled([accept(s.app, race.quoteId), accept(s.app, race.quoteId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const trades = await s.app.selectFrom('trade').select('id').where('quote_id', 'in', [link.quoteId, race.quoteId]).execute();
    expect(trades).toHaveLength(2);
    expect((await s.app.selectFrom('trade_request').select('status').where('id', '=', link.requestId).executeTakeFirstOrThrow()).status).toBe('ACCEPTED');
    expect(first.trade.ref).toMatch(/^IX-\d{6}-\d{4}$/);
  });

  it('exit: a superseded, cancelled or rejected quote can never be accepted', async () => {
    const link = await liveQuote();
    const replacement = await runAs(s.app, createQuote(s.dealer.actor, {}), s.dealer.ref, 'quote.create', { requestId: link.requestId, routeId: s.routeId, clientRate: '92.250000', validitySeconds: 300 });
    await runAs(s.app, sendQuote(s.dealer.actor, {}), s.dealer.ref, 'quote.send', { quoteId: replacement.quoteId });
    await expect(accept(s.app, link.quoteId)).rejects.toMatchObject({ code: 'QUOTE_NOT_SENT' });

    const rejected = await liveQuote();
    await runAs(s.app, rejectQuote(s.acceptor.actor), s.acceptor.ref, 'quote.reject', { quoteId: rejected.quoteId });
    await expect(accept(s.app, rejected.quoteId)).rejects.toMatchObject({ code: 'QUOTE_NOT_SENT' });
    expect((await s.app.selectFrom('trade_request').select('status').where('id', '=', rejected.requestId).executeTakeFirstOrThrow()).status).toBe('OPEN');
  });

  it('only a client user with acceptance authority may decide, and never for another client', async () => {
    const link = await liveQuote();
    await expect(accept(s.app, link.quoteId, s.viewer)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED_TO_ACCEPT' });
    const other = await createScenario('quotes_accept_other');
    try {
      await expect(accept(s.app, link.quoteId, other.acceptor)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED_TO_ACCEPT' });
    } finally {
      await other.close();
    }
    expect((await s.app.selectFrom('quote').select('status').where('id', '=', link.quoteId).executeTakeFirstOrThrow()).status).toBe('SENT');
  });

  it('a link rejection consumes a challenge, reopens the request and records the challenge on the quote (FI-07)', async () => {
    const link = await liveQuote();
    const { challengeId, code } = await otp(link);
    expect(await rejectQuoteViaLink(s.app, s.deps, { token: link.token, challengeId, code, idempotencyKey: randomUUID() })).toEqual({ status: 'REJECTED' });
    const quote = await s.app.selectFrom('quote').select(['status', 'rejected_via', 'acceptance_challenge_id', 'rejected_by_user_id']).where('id', '=', link.quoteId).executeTakeFirstOrThrow();
    expect(quote).toMatchObject({ status: 'REJECTED', rejected_via: 'LINK', acceptance_challenge_id: challengeId, rejected_by_user_id: s.acceptor.userId });
    expect((await s.app.selectFrom('trade_request').select('status').where('id', '=', link.requestId).executeTakeFirstOrThrow()).status).toBe('OPEN');
  });

  it('the destination captured on the quote must still be active at acceptance (S8)', async () => {
    // Archiving is one-way (archive-not-edit), so this runs in its own world.
    const sc = await createScenario('quotes_destination_changed');
    try {
      const link = await liveQuote({ scenario: sc });
      await runAs(sc.app, archiveBankAccount(sc.owner.actor), sc.owner.ref, 'client_bank.archive', { bankAccountId: sc.bankAccountId, reason: 'account closed by the bank' });
      await expect(runAs(sc.app, acceptQuote(sc.acceptor.actor, sc.deps), sc.acceptor.ref, 'quote.accept', { quoteId: link.quoteId })).rejects.toMatchObject({ code: 'DESTINATION_CHANGED' });
      expect((await sc.app.selectFrom('quote').select('status').where('id', '=', link.quoteId).executeTakeFirstOrThrow()).status).toBe('SENT');
    } finally {
      await sc.close();
    }
  });
});

describe('trade opening (T1, FI-03, FI-33, D-02)', () => {
  it('freezes the quote economics onto the trade, opens the obligation and posts a balanced accept journal', async () => {
    const link = await liveQuote();
    const result = await runAs(s.app, acceptQuote(s.acceptor.actor, s.deps), s.acceptor.ref, 'quote.accept', { quoteId: link.quoteId });
    const quote = await s.app.selectFrom('quote').selectAll().where('id', '=', link.quoteId).executeTakeFirstOrThrow();
    const econ = await s.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', result.tradeId).executeTakeFirstOrThrow();
    expect({ base: econ.base_minor, inr: econ.quote_inr_minor, rate: econ.client_rate_micro, route: econ.route_value_inr_minor, margin: econ.gross_margin_inr_minor })
      .toEqual({ base: quote.base_minor, inr: quote.quote_inr_minor, rate: quote.client_rate_micro, route: quote.route_value_inr_minor, margin: quote.gross_margin_inr_minor });
    const obligation = await s.app.selectFrom('route_obligation').selectAll().where('trade_id', '=', result.tradeId).executeTakeFirstOrThrow();
    // SELL: the exchange delivers the client's USDT to the route, the route delivers the route INR value.
    expect(obligation).toMatchObject({ status: 'OPEN', direction: 'SELL_USDT', exchange_delivers_asset: 'USDT', exchange_delivers_minor: econ.base_minor, route_delivers_asset: 'INR', route_delivers_minor: econ.route_value_inr_minor, execution_mode: 'DIRECT_TO_CLIENT' });

    const entries = await s.app
      .selectFrom('ledger_entry as e')
      .innerJoin('ledger_journal as j', 'j.id', 'e.journal_id')
      .select(['e.direction', 'e.amount_minor', 'e.currency'])
      .where('j.posting_key', '=', `trade:${result.tradeId}:accept`)
      .execute();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const currency of new Set(entries.map((e) => e.currency))) {
      const sum = (d: 'DR' | 'CR') => entries.filter((e) => e.currency === currency && e.direction === d).reduce((a, e) => a + e.amount_minor, 0n);
      expect({ currency, balanced: sum('DR') === sum('CR') }).toEqual({ currency, balanced: true });
    }

    // SELL acceptance assigns a deposit address for the client's USDT (D-02).
    const assignment = await s.app.selectFrom('deposit_assignment').select(['deposit_address_id', 'released_at']).where('trade_id', '=', result.tradeId).executeTakeFirstOrThrow();
    expect(assignment.released_at).toBeNull();
    expect(result.trade.depositInstructions).toMatchObject({ network: 'TRON', amount: '1000.000000', address: expect.stringMatching(/^T[1-9A-HJ-NP-Za-km-z]{33}$/) });
    assertClientSafe(result.trade);
    expect(JSON.stringify(result.trade)).not.toContain(String(quote.route_value_inr_minor));
  });

  it('exit: a rate change after acceptance never changes an open trade', async () => {
    const link = await liveQuote();
    const result = await runAs(s.app, acceptQuote(s.acceptor.actor, s.deps), s.acceptor.ref, 'quote.accept', { quoteId: link.quoteId });
    const before = await s.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', result.tradeId).executeTakeFirstOrThrow();
    await runAs(s.app, publishRouteRate(s.dealer.actor), s.dealer.ref, 'rates.publish_route', { routeId: s.routeId, direction: 'SELL_USDT' as const, rate: '80.000000' });
    const after = await s.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', result.tradeId).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    await runAs(s.app, publishRouteRate(s.dealer.actor), s.dealer.ref, 'rates.publish_route', { routeId: s.routeId, direction: 'SELL_USDT' as const, rate: '92.500000' });
  });

  it('a BUY trade on a TO_EXCHANGE route reserves treasury USDT at acceptance (FI-33)', async () => {
    const buy = await createScenario('quotes_buy_exchange');
    try {
      await useExchangeExecution(buy);
      const r = await runAs(buy.app, createRequest(buy.dealer.actor, {}), buy.dealer.ref, 'request.create', { clientId: buy.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', walletId: buy.walletId });
      const q = await runAs(buy.app, createQuote(buy.dealer.actor, {}), buy.dealer.ref, 'quote.create', { requestId: r.requestId, routeId: buy.routeId, clientRate: '94.000000', validitySeconds: 300 });
      await runAs(buy.app, sendQuote(buy.dealer.actor, {}), buy.dealer.ref, 'quote.send', { quoteId: q.quoteId });
      const accepted = await runAs(buy.app, acceptQuote(buy.acceptor.actor, buy.deps), buy.acceptor.ref, 'quote.accept', { quoteId: q.quoteId });
      const reservation = await buy.app.selectFrom('treasury_reservation').selectAll().where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
      expect(reservation).toMatchObject({ status: 'ACTIVE', amount_minor: Money.parse('1000', 'USDT').minor });
      const wallet = await buy.app.selectFrom('treasury_wallet').select(['reserved_minor', 'observed_balance_minor']).where('id', '=', reservation.treasury_wallet_id).executeTakeFirstOrThrow();
      expect(wallet.reserved_minor).toBe(reservation.amount_minor);
      expect(wallet.reserved_minor).toBeLessThanOrEqual(wallet.observed_balance_minor);
      // BUY has no deposit address: the client receives USDT, it does not send any.
      expect(await buy.app.selectFrom('deposit_assignment').select('id').where('trade_id', '=', accepted.tradeId).execute()).toEqual([]);
      expect(accepted.trade.depositInstructions).toBeNull();
    } finally {
      await buy.close();
    }
  });

  it('exit: SELL acceptance is refused while the custody deposit-address capability is UNSUPPORTED (D-02)', async () => {
    const gated = await createScenario('quotes_custody_gate', { custody: 'UNSUPPORTED' });
    try {
      const link = await liveQuote({ scenario: gated });
      await expect(runAs(gated.app, acceptQuote(gated.acceptor.actor, gated.deps), gated.acceptor.ref, 'quote.accept', { quoteId: link.quoteId }))
        .rejects.toMatchObject({ code: 'CUSTODY_CAPABILITY_UNSUPPORTED' });
      expect((await gated.app.selectFrom('quote').select('status').where('id', '=', link.quoteId).executeTakeFirstOrThrow()).status).toBe('SENT');
      expect(await gated.app.selectFrom('trade').select('id').execute()).toEqual([]);
    } finally {
      await gated.close();
    }
  });
});
