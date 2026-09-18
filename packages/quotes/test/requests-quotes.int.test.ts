import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import {
  cancelQuote, createQuote, createQuoteLink, createRequest, declineRequest, dueQuoteIds, expireQuote, revokeQuoteLink,
  sendQuote, viewQuoteForClient, viewQuoteLink, withdrawRequest, assertClientSafe, FORBIDDEN_CLIENT_KEY,
} from '../src/index.ts';
import { createScenario, ipHash, type Scenario } from './scenario.ts';

let s: Scenario;
beforeAll(async () => { s = await createScenario('quotes_requests'); });
afterAll(async () => s.close());

const sellRequest = (extra: Record<string, unknown> = {}) =>
  runAs(s.app, createRequest(s.acceptor.actor, {}), s.acceptor.ref, 'request.create', { clientId: s.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '10000', bankAccountId: s.bankAccountId, ...extra });

const quoteFor = (requestId: string, extra: Record<string, unknown> = {}) =>
  runAs(s.app, createQuote(s.dealer.actor, {}), s.dealer.ref, 'quote.create', { requestId, routeId: s.routeId, clientRate: '92.000000', validitySeconds: 300, ...extra });

async function sendWithLink(quoteId: string, withLink = true): Promise<{ token: string | null; result: Awaited<ReturnType<ReturnType<typeof sendQuote>['handle']>> }> {
  let token: string | null = null;
  const result = await runAs(s.app, sendQuote(s.dealer.actor, {}, (x) => { token = x; }), s.dealer.ref, 'quote.send', { quoteId, withLink });
  return { token, result };
}

describe('trade requests (STATE_MACHINES §1)', () => {
  it('a client user creates a request against an active destination; bad destinations are refused', async () => {
    const r = await sellRequest();
    expect(r.ref).toMatch(/^RQ-\d{6}-\d{4}$/);
    const row = await s.app.selectFrom('trade_request').selectAll().where('id', '=', r.requestId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'OPEN', channel: 'CLIENT_APP', requested_base_minor: 10_000_000_000n, requested_quote_minor: null });
    await expect(sellRequest({ bankAccountId: s.walletId })).rejects.toMatchObject({ code: 'DESTINATION_INVALID' });
    await expect(sellRequest({ bankAccountId: randomUUID() })).rejects.toMatchObject({ code: 'DESTINATION_INVALID' });
    await expect(sellRequest({ amount: '0' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(sellRequest({ amount: '6000000' })).rejects.toMatchObject({ code: 'AMOUNT_ABOVE_LIMIT' });
  });

  it('a BUY request needs a destination wallet; a disabled direction is refused', async () => {
    const buy = await runAs(s.app, createRequest(s.dealer.actor, {}), s.dealer.ref, 'request.create', { clientId: s.clientId, direction: 'BUY_USDT' as const, fixedSide: 'QUOTE' as const, amount: '930000.00', walletId: s.walletId });
    const row = await s.app.selectFrom('trade_request').select(['channel', 'requested_quote_minor', 'crypto_wallet_id']).where('id', '=', buy.requestId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ channel: 'OPERATOR', requested_quote_minor: 93_000_000n, crypto_wallet_id: s.walletId });
    await expect(runAs(s.app, createRequest(s.dealer.actor, { policy: { enabledDirections: ['SELL_USDT'] } }), s.dealer.ref, 'request.create', { clientId: s.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '1', walletId: s.walletId })).rejects.toMatchObject({ code: 'DIRECTION_DISABLED' });
  });

  it('a user of another client cannot create or withdraw a request for this client', async () => {
    const other = await createScenario('quotes_other_client');
    try {
      await expect(runAs(s.app, createRequest(other.acceptor.actor, {}), other.acceptor.ref, 'request.create', { clientId: s.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1', bankAccountId: s.bankAccountId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await other.close();
    }
  });

  it('decline and withdraw close the request and cancel its live quote', async () => {
    const declined = await sellRequest();
    const dq = await quoteFor(declined.requestId);
    await sendWithLink(dq.quoteId, false);
    await runAs(s.app, declineRequest(s.dealer.actor), s.dealer.ref, 'request.decline', { requestId: declined.requestId, reason: 'no capacity today' });
    expect(await s.app.selectFrom('quote').select(['status', 'cancel_reason']).where('id', '=', dq.quoteId).executeTakeFirstOrThrow()).toEqual({ status: 'CANCELLED', cancel_reason: 'DECLINED_BY_DESK' });

    const withdrawn = await sellRequest();
    const wq = await quoteFor(withdrawn.requestId);
    await sendWithLink(wq.quoteId, false);
    await runAs(s.app, withdrawRequest(s.acceptor.actor), s.acceptor.ref, 'request.withdraw', { requestId: withdrawn.requestId, reason: 'changed my mind' });
    expect((await s.app.selectFrom('trade_request').select('status').where('id', '=', withdrawn.requestId).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
    expect((await s.app.selectFrom('quote').select('cancel_reason').where('id', '=', wq.quoteId).executeTakeFirstOrThrow()).cancel_reason).toBe('WITHDRAWN');
    await expect(runAs(s.app, withdrawRequest(s.acceptor.actor), s.acceptor.ref, 'request.withdraw', { requestId: withdrawn.requestId })).rejects.toMatchObject({ code: 'REQUEST_NOT_OPEN' });
  });
});

describe('quotes (STATE_MACHINES §2, FI-02..FI-06)', () => {
  it('computes economics from the current route snapshot and stores a derived margin', async () => {
    const r = await sellRequest();
    const q = await quoteFor(r.requestId);
    expect(q).toMatchObject({ base: '10000.000000', clientInr: '920000.00', grossMarginInr: '5000.00' });
    const row = await s.app.selectFrom('quote').selectAll().where('id', '=', q.quoteId).executeTakeFirstOrThrow();
    expect(row.status).toBe('DRAFT');
    expect(row.route_value_inr_minor - row.quote_inr_minor).toBe(row.gross_margin_inr_minor);
    await expect(sql`update quote set quote_inr_minor = 1 where id = ${q.quoteId}`.execute(s.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX041');
  });

  it('a negative margin needs a reason at creation and a step-up permission at send', async () => {
    const r = await sellRequest();
    await expect(quoteFor(r.requestId, { clientRate: '93.000000' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const q = await quoteFor(r.requestId, { clientRate: '93.000000', negativeMarginReason: 'relationship trade approved by the desk head' });
    await expect(sendWithLink(q.quoteId, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    let token: string | null = null;
    await runAs(s.app, sendQuote(s.owner.actor, {}, (x) => { token = x; }), s.owner.ref, 'quote.send', { quoteId: q.quoteId, withLink: false });
    expect(token).toBeNull();
    expect((await s.app.selectFrom('quote').select('status').where('id', '=', q.quoteId).executeTakeFirstOrThrow()).status).toBe('SENT');
  });

  it('validity bounds hold, a link needs at least 120 s and only one quote of a request is SENT', async () => {
    const r = await sellRequest();
    await expect(quoteFor(r.requestId, { validitySeconds: 10 })).rejects.toMatchObject({ code: 'QUOTE_VALIDITY_INVALID' });
    await expect(quoteFor(r.requestId, { validitySeconds: 3600 })).rejects.toMatchObject({ code: 'QUOTE_VALIDITY_INVALID' });
    await expect(quoteFor(r.requestId, { validitySeconds: 60.5 })).rejects.toMatchObject({ code: 'QUOTE_VALIDITY_INVALID' });
    const short = await quoteFor(r.requestId, { validitySeconds: 60 });
    await expect(sendWithLink(short.quoteId)).rejects.toMatchObject({ code: 'LINK_VALIDITY_TOO_SHORT' });
    // Without an explicit validity a quote takes the shareable-link default of 180 s (D-01 rev 3).
    const defaulted = await quoteFor(r.requestId, { validitySeconds: undefined });
    expect((await s.app.selectFrom('quote').select('valid_for_seconds').where('id', '=', defaulted.quoteId).executeTakeFirstOrThrow()).valid_for_seconds).toBe(180);

    const first = await quoteFor(r.requestId);
    await sendWithLink(first.quoteId, false);
    const second = await quoteFor(r.requestId, { clientRate: '92.100000' });
    const sent = await sendWithLink(second.quoteId, false);
    expect(sent.result.supersededQuoteId).toBe(first.quoteId);
    expect((await s.app.selectFrom('quote').select(['status', 'cancel_reason']).where('id', '=', first.quoteId).executeTakeFirstOrThrow())).toEqual({ status: 'CANCELLED', cancel_reason: 'SUPERSEDED' });
    const live = await s.app.selectFrom('quote').select('id').where('trade_request_id', '=', r.requestId).where('status', '=', 'SENT').execute();
    expect(live).toHaveLength(1);
    await expect(sql`update quote set status = 'SENT' where id = ${first.quoteId}`.execute(s.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX040');
  });

  it('refuses to send on a stale route snapshot and fixes expiry from database time', async () => {
    const r = await sellRequest();
    const q = await quoteFor(r.requestId);
    const clock = await s.t.pinnedClock();
    await clock.set(new Date(Date.now() + 3_600_000));
    try {
      await expect(runAs(clock.db, sendQuote(s.dealer.actor, {}), s.dealer.ref, 'quote.send', { quoteId: q.quoteId })).rejects.toMatchObject({ code: 'ROUTE_RATE_STALE' });
    } finally {
      await clock.set(null);
    }
    const sent = await sendWithLink(q.quoteId, false);
    const row = await s.app.selectFrom('quote').select(['sent_at', 'expires_at', 'valid_for_seconds']).where('id', '=', q.quoteId).executeTakeFirstOrThrow();
    expect(row.expires_at!.getTime() - row.sent_at!.getTime()).toBe(row.valid_for_seconds * 1000);
    expect(sent.result.expiresAt).toBe(row.expires_at!.toISOString());
    // The send timestamp is fixed once: a second write of expiry is rejected by the database.
    await expect(sql`update quote set expires_at = now() + interval '1 day' where id = ${q.quoteId}`.execute(s.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX041');
  });
});

describe('shareable links (SECURITY §2.3, S2)', () => {
  async function linkedQuote() {
    const r = await sellRequest();
    const q = await quoteFor(r.requestId);
    const { token } = await sendWithLink(q.quoteId);
    return { requestId: r.requestId, quoteId: q.quoteId, token: token! };
  }

  it('exit: the view never mutates the quote, records telemetry and leaks no internal keys', async () => {
    const { quoteId, token } = await linkedQuote();
    const before = await s.app.selectFrom('quote').selectAll().where('id', '=', quoteId).executeTakeFirstOrThrow();
    const view = await viewQuoteLink(s.app, {}, { token, ipHash: ipHash('198.51.100.7') });
    expect(view.quote).toMatchObject({ direction: 'SELL_USDT', network: 'TRON', status: 'SENT', clientRate: '92.000000' });
    expect(view.quote.destination).toMatch(/HDFC Bank •••• 8219/);
    expect(view.recipients.map((x) => x.destination)).toEqual([expect.stringMatching(/^.•••@/)]);
    expect(view.codeRequired).toBe(true);
    assertClientSafe(view);
    for (const key of Object.keys(view.quote)) expect(FORBIDDEN_CLIENT_KEY.test(key)).toBe(false);
    expect(JSON.stringify(view)).not.toContain(token);

    const after = await s.app.selectFrom('quote').selectAll().where('id', '=', quoteId).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    await viewQuoteLink(s.app, {}, { token, ipHash: ipHash('198.51.100.7') });
    const link = await s.app.selectFrom('quote_link').select(['open_count', 'first_opened_at']).where('quote_id', '=', quoteId).executeTakeFirstOrThrow();
    expect(link.open_count).toBe(2);
    expect(link.first_opened_at).not.toBeNull();
    expect((await s.app.selectFrom('audit_event').select('action').where('action', '=', 'quote_link.opened').execute()).length).toBeGreaterThanOrEqual(2);
  });

  it('exit: lookup is by token hash only — unknown, malformed and revoked tokens answer the same', async () => {
    const { token } = await linkedQuote();
    const expected = { code: 'LINK_NOT_FOUND' };
    await expect(viewQuoteLink(s.app, {}, { token: 'ZZZZZZZZZZZZZZZZZZZZZZ', ipHash: ipHash('198.51.100.8') })).rejects.toMatchObject(expected);
    await expect(viewQuoteLink(s.app, {}, { token: 'short', ipHash: ipHash('198.51.100.8') })).rejects.toMatchObject(expected);
    await expect(viewQuoteLink(s.app, {}, { token: `${token.slice(0, 21)}%`, ipHash: ipHash('198.51.100.8') })).rejects.toMatchObject(expected);
    const linkId = (await s.app.selectFrom('quote_link').select('id').where('token_hash', 'is not', null).orderBy('created_at', 'desc').executeTakeFirstOrThrow()).id;
    await runAs(s.app, revokeQuoteLink(s.owner.actor), s.owner.ref, 'quote_link.revoke', { linkId, reason: 'shared with the wrong person' });
    await expect(viewQuoteLink(s.app, {}, { token, ipHash: ipHash('198.51.100.8') })).rejects.toMatchObject(expected);
    // Only the hash is stored: the plaintext token appears nowhere.
    const linkRow = await s.t.owner.selectFrom('quote_link').selectAll().where('id', '=', linkId).executeTakeFirstOrThrow();
    expect(JSON.stringify(linkRow)).not.toContain(token);
  });

  it('exit: link opens are rate limited per IP', async () => {
    const { token } = await linkedQuote();
    const ip = ipHash(`rate-${randomUUID()}`);
    for (let i = 0; i < 3; i++) await viewQuoteLink(s.app, { policy: { linkOpensPerIpPerMinute: 3 } }, { token, ipHash: ip });
    await expect(viewQuoteLink(s.app, { policy: { linkOpensPerIpPerMinute: 3 } }, { token, ipHash: ip })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // A different IP is unaffected.
    await viewQuoteLink(s.app, { policy: { linkOpensPerIpPerMinute: 3 } }, { token, ipHash: ipHash(`rate-other-${randomUUID()}`) });
  });

  it('a link can be attached to a live quote once, and a cancelled quote keeps no live link', async () => {
    const r = await sellRequest();
    const q = await quoteFor(r.requestId);
    await sendWithLink(q.quoteId, false);
    let token: string | null = null;
    await runAs(s.app, createQuoteLink(s.dealer.actor, {}, (x) => { token = x; }), s.dealer.ref, 'quote_link.create', { quoteId: q.quoteId });
    await expect(runAs(s.app, createQuoteLink(s.dealer.actor, {}, () => {}), s.dealer.ref, 'quote_link.create', { quoteId: q.quoteId })).rejects.toMatchObject({ code: 'LINK_EXISTS' });
    await runAs(s.app, cancelQuote(s.dealer.actor), s.dealer.ref, 'quote.cancel', { quoteId: q.quoteId, reason: 'client asked to stop' });
    const view = await viewQuoteLink(s.app, {}, { token: token!, ipHash: ipHash('198.51.100.9') });
    expect(view.quote.status).toBe('CANCELLED');
    expect(view.recipients).toEqual([]);
    expect((await s.app.selectFrom('trade_request').select('status').where('id', '=', r.requestId).executeTakeFirstOrThrow()).status).toBe('OPEN');
  });

  it('the in-app view requires membership of the quote’s client', async () => {
    const { quoteId } = await linkedQuote();
    expect(await viewQuoteForClient(s.app, s.viewer.actor, quoteId)).toMatchObject({ status: 'SENT' });
    const other = await createScenario('quotes_view_other');
    try {
      await expect(viewQuoteForClient(s.app, other.acceptor.actor, quoteId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await other.close();
    }
  });
});

describe('expiry (STATE_MACHINES §2)', () => {
  it('does nothing before the expiry instant, then closes the quote and reopens the request', async () => {
    const r = await sellRequest();
    const q = await quoteFor(r.requestId);
    await sendWithLink(q.quoteId, false);
    expect(await expireQuote(s.app, q.quoteId)).toBe(false);
    expect(await dueQuoteIds(s.app)).not.toContain(q.quoteId);

    const clock = await s.t.pinnedClock();
    const expiresAt = (await s.app.selectFrom('quote').select('expires_at').where('id', '=', q.quoteId).executeTakeFirstOrThrow()).expires_at!;
    await clock.set(new Date(expiresAt.getTime() + 1));
    try {
      expect(await dueQuoteIds(clock.db)).toContain(q.quoteId);
      expect(await expireQuote(clock.db, q.quoteId)).toBe(true);
      // Idempotent: a second run of the same job is a no-op.
      expect(await expireQuote(clock.db, q.quoteId)).toBe(false);
    } finally {
      await clock.set(null);
    }
    expect((await s.app.selectFrom('quote').select(['status', 'closed_at']).where('id', '=', q.quoteId).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
    expect((await s.app.selectFrom('trade_request').select('status').where('id', '=', r.requestId).executeTakeFirstOrThrow()).status).toBe('OPEN');
    const events = await s.app.selectFrom('outbox_event').select('type').where('aggregate_id', '=', q.quoteId).execute();
    expect(events.map((e) => e.type)).toContain('client.quote_expired');
  });

  it('an inactive OPEN request expires after its TTL', async () => {
    const r = await sellRequest();
    await sql`update trade_request set last_activity_at = inrp2p_now() - interval '2 days' where id = ${r.requestId}`.execute(s.t.owner);
    const { pruneRateLimitCounters, runExpirySweep } = await import('../src/index.ts');
    const report = await runExpirySweep(s.t.worker, {});
    expect(report.requests).toBeGreaterThanOrEqual(1);
    expect((await s.app.selectFrom('trade_request').select(['status', 'status_reason']).where('id', '=', r.requestId).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
    // Rate-limit windows are maintenance data: only the worker role may delete them.
    await expect(pruneRateLimitCounters(s.app)).rejects.toThrow(/permission denied/);
  });
});
