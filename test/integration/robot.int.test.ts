import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Rate } from '@inrp2p/kernel';
import { executeCommand } from '@inrp2p/commands';
import { createTestClientLogin, runAs } from '@inrp2p/identity/testing';
import { addBankAccount, createClient, linkClientUser } from '@inrp2p/clients';
import { currentPricingPolicy, setPricingPolicy } from '@inrp2p/pricing';
import { requestInstantQuote, runMarketReferenceRefresh, runWaitingSweep, setPeerPolicy } from '@inrp2p/quotes';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { clientInbox } from '@inrp2p/notifications';
import { FakeRobotMind } from '@inrp2p/adapters';
import { FakeNotificationAdapter, FakeTelegram } from '@inrp2p/adapters/testing';
import type { OutboxEvent } from '@inrp2p/outbox';
import {
  answerRobotCase, askRobot, closeRobotCase, currentRobotPolicy, quietByEmailLink, robotBriefOf, robotDeliveryHandler, robotIntel, runRobotSweep, setRobotConsent, setRobotPolicy,
} from '@inrp2p/robot';
import { applyAs, traderClient } from './traders-world.ts';
import { type RailsWorld, completeDeal, createRailsWorld, railsTrade, railsTrader } from './rails-world.ts';

/**
 * The robot at INRP2P's front line (ADR 0034), end to end on a real database: it starts as a dry run that decides and
 * sends nothing; switched on, it writes to people stuck on their way in — once, in the inbox and on one channel, with a
 * way to stop it — never while they are in the app, never twice a day, never at night; it notices when they act; it tells
 * a client whose request nobody priced when a trader for it comes online, and someone who sold before when a buyer waits;
 * and it answers questions by rule, by a model whose figures are checked, or by passing them to a person.
 */
let w: RailsWorld;
const email = new FakeNotificationAdapter();
const telegram = new FakeTelegram();
const LINK = 'https://app.inrp2p.test';

const r = (d: string) => Rate.parse(d, 'ROUTE').micro;
const books = (bid: string, ask: string) => runMarketReferenceRefresh(w.app, async () => ({ bidMicro: r(bid), askMicro: r(ask), source: 'market: test books' }));
const touchesOf = (userId: string) => w.app.selectFrom('robot_touch').selectAll().where('user_id', '=', userId).orderBy('created_at').execute();
const policy = async (change: Record<string, unknown>) =>
  runAs(w.app, setRobotPolicy(w.owner.actor), w.owner.ref, 'robot_policy.set', { expectedPolicyId: (await currentRobotPolicy(w.app)).id, reason: 'the robot in this test', ...change });
const deliver = async () => {
  const handler = robotDeliveryHandler(w.app, { email, telegram, linkBase: LINK });
  const events = await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id'])
    .where('type', 'in', ['robot.note', 'robot.case_answered']).orderBy('created_at').execute();
  for (const e of events) await handler.run({ id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id } as OutboxEvent);
};
/** Moves a row's time back, as if it happened `hours` ago — past the guards that keep such columns as they were written. */
const age = async (table: 'auth_user' | 'client' | 'trader_profile' | 'robot_touch', column: string, id: string, hours: number) => {
  await w.t.owner.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`update ${sql.table(table)} set ${sql.ref(column)} = inrp2p_now() - make_interval(hours => ${hours}) where id = ${id}::uuid`.execute(tx);
  });
};

/** A client the desk opened, with one administrator and nowhere to be paid yet. */
async function bareClient(name: string) {
  const c = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: `${name} Pvt Ltd`, displayName: name, type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const });
  const login = await createTestClientLogin(w.t.owner, { emailVerified: true, stepUp: 'fresh' });
  await runAs(w.app, linkClientUser(w.owner.actor), w.owner.ref, 'client_user.link', { clientId: c.clientId, userId: login.userId, role: 'CLIENT_ADMIN' as const });
  const address = (await w.app.selectFrom('auth_user').select('email').where('id', '=', login.userId).executeTakeFirstOrThrow()).email;
  return { clientId: c.clientId, userId: login.userId, sessionId: login.sessionId, email: address };
}

beforeAll(async () => {
  w = await createRailsWorld('robot', { resourceMode: 'GASFREE' });
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, reason: 'no INR account: P2P escrow' });
  await books('101.00', '102.00');
  // Whatever hour the suite runs at, it is not India's night for the robot unless a test says so.
  await policy({ quietFrom: 0, quietTo: 0 });
}, 180_000);
afterAll(async () => w.close());

describe('on its way in, a person is never left alone', () => {
  let newbie: { userId: string };

  it('starts as a dry run: it decides and records what it would send, and sends nothing', async () => {
    newbie = await createTestClientLogin(w.t.owner, { emailVerified: true, stepUp: 'none' });
    await age('auth_user', 'created_at', newbie.userId, 3);
    const out = await runRobotSweep(w.app);
    expect(out.mode).toBe('DRY_RUN');
    expect(await touchesOf(newbie.userId)).toMatchObject([{ playbook: 'open_account', mode: 'DRY_RUN', channel: 'EMAIL', delivery: 'NONE', attempt: 1, title: 'Your account is one step away' }]);
    expect((await touchesOf(newbie.userId))[0]!.body).toContain("Today's market: sell at ₹101.00, buy at ₹102.00 per USDT.");
    expect(await w.app.selectFrom('outbox_event').select('id').where('type', '=', 'robot.note').execute()).toEqual([]);
  });

  it('only the owner switches it on, with a reason and a fresh code', async () => {
    await expect(runAs(w.app, setRobotPolicy(w.dealer.actor), w.dealer.ref, 'robot_policy.set', { expectedPolicyId: (await currentRobotPolicy(w.app)).id, reason: 'go', outreach: 'ON' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(policy({ outreach: 'ON', reason: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await policy({ outreach: 'ON' });
    expect((await currentRobotPolicy(w.app)).outreach).toBe('ON');
  });

  let bare: Awaited<ReturnType<typeof bareClient>>;
  it('writes once — in the inbox and on one channel — with a way to stop it', async () => {
    bare = await bareClient('Anaya Traders');
    await age('client', 'created_at', bare.clientId, 2);
    await runRobotSweep(w.app);
    expect(await touchesOf(bare.userId)).toMatchObject([{ playbook: 'add_destination', mode: 'LIVE', channel: 'EMAIL', delivery: 'PENDING', title: 'Add where you get paid', href: '/destinations' }]);
    // The rehearsal did not use up the real message: the person who signed in hears it now, live.
    expect((await touchesOf(newbie.userId)).map((t) => [t.mode, t.attempt])).toEqual([['DRY_RUN', 1], ['LIVE', 1]]);

    await deliver();
    const inbox = await clientInbox(w.app, bare.clientId, { userId: bare.userId });
    expect(inbox).toMatchObject([{ kind: 'ROBOT_NOTE', title: 'Add where you get paid', href: '/destinations' }]);
    const mail = email.notifications.find((n) => n.to === bare.email)!;
    expect(mail.subject).toBe('Add where you get paid');
    expect(mail.link).toBe(`${LINK}/destinations`);
    expect(mail.body).toMatch(/Stop Bhai's messages: https:\/\/app\.inrp2p\.test\/robot-quiet\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/);
    expect((await touchesOf(bare.userId))[0]).toMatchObject({ delivery: 'SENT' });

    // Delivered again (an outbox retry), nothing is sent twice; swept again, nothing new is decided.
    const sent = email.notifications.length;
    await deliver();
    await runRobotSweep(w.app);
    expect(email.notifications.length).toBe(sent);
    expect(await touchesOf(bare.userId)).toHaveLength(1);
  });

  it('the email’s own link stops the robot writing to that person — and nothing else', async () => {
    const mail = email.notifications.find((n) => n.subject === 'Your account is one step away')!;
    const link = /\/robot-quiet\/(\S+)$/.exec(mail.body)![1]!;
    const stop = (l: string) => executeCommand(w.app, quietByEmailLink(), { name: 'robot.quiet_link', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { link: l }, idempotencyKey: null, financial: false }).then((o) => o.result);
    expect(await stop(`${link.slice(0, -1)}x`)).toEqual({ stopped: false });
    expect(await stop(link)).toEqual({ stopped: true });
    expect(await w.app.selectFrom('robot_preference').select(['outreach', 'set_via']).where('user_id', '=', newbie.userId).executeTakeFirst()).toEqual({ outreach: 'NONE', set_via: 'EMAIL' });
    // Three days on, the second attempt would be due — but not to someone who said stop.
    await age('auth_user', 'created_at', newbie.userId, 80);
    for (const t of await touchesOf(newbie.userId)) await age('robot_touch', 'created_at', t.id, 75);
    await runRobotSweep(w.app);
    expect(await touchesOf(newbie.userId)).toHaveLength(2);
  });

  it('notices when the person does the thing', async () => {
    await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', {
      clientId: bare.clientId, holderName: 'Anaya Traders Pvt Ltd', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100999988877', railPreferences: ['IMPS'] as const,
    });
    await runRobotSweep(w.app);
    expect((await touchesOf(bare.userId))[0]!.acted_at).not.toBeNull();
  });

  it('stays quiet while the person is in the app, and in India’s night', async () => {
    const c = await bareClient('Quiet Exports');
    await age('client', 'created_at', c.clientId, 2);
    await sql`insert into session_activity (session_id, last_activity_at) values (${c.sessionId}::uuid, inrp2p_now())`.execute(w.t.owner);
    const inApp = await runRobotSweep(w.app);
    expect(inApp.refused.IN_APP).toBeGreaterThanOrEqual(1);
    expect(await touchesOf(c.userId)).toEqual([]);
    // The robot shows it on the page instead.
    expect(await robotBriefOf(w.app, c.userId)).toMatchObject({ kind: 'STEP', playbook: 'add_destination', title: 'Add where you get paid', isNew: true });

    await sql`delete from session_activity where session_id = ${c.sessionId}::uuid`.execute(w.t.owner);
    const hour = (await sql<{ h: number }>`select extract(hour from inrp2p_now() at time zone 'Asia/Kolkata')::int as h`.execute(w.app)).rows[0]!.h;
    await policy({ quietFrom: hour, quietTo: (hour + 1) % 24 });
    expect(await runRobotSweep(w.app)).toMatchObject({ looked: 0, touched: 0 });
    await policy({ quietFrom: 0, quietTo: 0 });
    await runRobotSweep(w.app);
    expect(await touchesOf(c.userId)).toMatchObject([{ playbook: 'add_destination' }]);
  });
});

describe('a request nobody priced', () => {
  let requestRef: string;
  let ravi: Awaited<ReturnType<typeof railsTrader>>;

  it('while it waits, the robot says it is searching — and what is true about who is online', async () => {
    await runAs(w.app, setPricingPolicy(w.owner.actor), w.owner.ref, 'pricing.set_policy', { expectedPolicyId: (await currentPricingPolicy(w.app)).id, reason: 'automatic prices', autoQuote: true });
    const out = await runAs(w.app, requestInstantQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'request.instant_quote', { direction: 'SELL_USDT', fixedSide: 'BASE', amount: '300', bankAccountId: w.bankAccountId } as never);
    expect(out.outcome).toMatchObject({ kind: 'WAITING' });
    requestRef = (await w.app.selectFrom('trade_request').select('ref').where('id', '=', out.requestId).executeTakeFirstOrThrow()).ref;
    const brief = await robotBriefOf(w.app, w.acceptor.userId);
    expect(brief).toMatchObject({ kind: 'SEARCH', title: 'Finding a trader for 300 USDT' });
    expect(brief!.body).toContain('No trader with that side is online right now.');
    expect(brief!.working).toMatch(/^Looking for a trader for 300 USDT until (tomorrow, )?\d\d:\d\d IST\.$/);
    // Its wait runs out with nobody.
    await sql`update trade_request set waiting_since = inrp2p_now() - interval '25 hours', waiting_until = inrp2p_now() - interval '1 minute' where ref = ${requestRef}`.execute(w.t.owner);
    await runWaitingSweep(w.app);
    expect(await w.app.selectFrom('trade_request').select(['status', 'no_price_reason']).where('ref', '=', requestRef).executeTakeFirstOrThrow()).toMatchObject({ status: 'DECLINED', no_price_reason: 'NO_OFFER' });
    await runRobotSweep(w.app);
    expect((await touchesOf(w.acceptor.userId)).filter((t) => t.playbook === 'supply_back')).toEqual([]);
  });

  it('when a trader who takes that amount comes online, the one who asked is told — in one tap to ask again', async () => {
    ravi = await railsTrader(w, 'Ravi Capital', { buy: { capacity: '5000000', rate: '100.50', min: '10000', max: '100000' } });
    await runRobotSweep(w.app);
    const told = (await touchesOf(w.acceptor.userId)).filter((t) => t.playbook === 'supply_back');
    expect(told).toMatchObject([{ subject: requestRef, mode: 'LIVE', title: 'A trader for 300 USDT is online now', href: `/exchange?again=${requestRef}` }]);
    // Not the client's member without authority, nor its other acceptor who did not ask.
    for (const p of [w.viewer, w.unverified]) expect((await touchesOf(p.userId)).filter((t) => t.playbook === 'supply_back')).toEqual([]);
    await deliver();
    expect((await clientInbox(w.app, w.clientId, { userId: w.acceptor.userId })).find((n) => n.kind === 'ROBOT_NOTE')).toMatchObject({ href: `/exchange?again=${requestRef}`, subjectRef: requestRef });
  });

  it('someone who sold before, and asked to hear of it, is told a buyer waits — at the price the book would meet', async () => {
    await runAs(w.app, setPeerPolicy(w.owner.actor), w.owner.ref, 'peer_policy.set', { enabled: true, reason: 'clients meet clients' });
    const sale = await railsTrade(w, ravi, { direction: 'SELL_USDT', amount: '150', clientRate: '100.40', plannedClientRate: '100.40' });
    await completeDeal(w, ravi, sale);
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', sale.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    await runAs(w.app, setRobotConsent(w.acceptor.actor), w.acceptor.ref, 'robot.consent', { outreach: 'ALL' as const });
    // What it was told yesterday, and what the deal told it this afternoon, are behind it.
    for (const t of await touchesOf(w.acceptor.userId)) await age('robot_touch', 'created_at', t.id, 24);
    await w.t.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`update client_notification set created_at = inrp2p_now() - interval '4 hours' where client_id = ${w.clientId}::uuid`.execute(tx);
    });

    const neha = await traderClient(w, 'Neha Buyer');
    const wants = await runAs(w.app, requestInstantQuote(neha.admin.actor, w.railsDeps), neha.admin.ref, 'request.instant_quote', { direction: 'BUY_USDT', fixedSide: 'BASE', amount: '200', walletId: neha.walletId } as never);
    expect(wants.outcome).toMatchObject({ kind: 'WAITING' });
    const nehaRef = (await w.app.selectFrom('trade_request').select('ref').where('id', '=', wants.requestId).executeTakeFirstOrThrow()).ref;
    await sql`update trade_request set waiting_since = inrp2p_now() - interval '15 minutes' where id = ${wants.requestId}::uuid`.execute(w.t.owner);

    const out = await runRobotSweep(w.app);
    expect(out.demand).toBe(1);
    const told = (await touchesOf(w.acceptor.userId)).filter((t) => t.playbook === 'demand_match');
    expect(told).toMatchObject([{ subject: nehaRef, title: 'A buyer is waiting for 150 USDT', href: '/exchange?direction=sell&amount=150' }]);
    expect(told[0]!.body).toMatch(/^Someone wants to buy 150 USDT right now\. You sold here before — sell now and you meet them at ₹\d+\.\d{2} per USDT\./);
    expect(told[0]!.body).not.toContain('Neha');
  });
});

describe('the trader programme', () => {
  it('an applicant whose reserve is not in is asked for it — the administrator, not its traders', async () => {
    const kiran = await traderClient(w, 'Kiran OTC');
    await applyAs(w, kiran.admin, { offersBuy: true, offersSell: false, typicalInr: '50000', bankAccountId: kiran.bankAccountId, walletId: kiran.walletId });
    const t = await w.app.selectFrom('trader_profile').select('id').where('client_id', '=', kiran.clientId).executeTakeFirstOrThrow();
    await age('trader_profile', 'applied_at', t.id, 3);
    await runRobotSweep(w.app);
    expect(await touchesOf(kiran.admin.userId)).toMatchObject([{ playbook: 'send_reserve', title: 'Send your 500 USDT reserve to go live', href: '/traders/reserve' }]);
    expect(await touchesOf(kiran.member.userId)).toEqual([]);
  });
});

describe('answers', () => {
  const ask = (text: string, opts: { mind?: FakeRobotMind | null; userId?: string | null; channel?: 'APP' | 'TELEGRAM'; chat?: string | null } = {}) =>
    askRobot(w.app, { mind: opts.mind ?? null, deskEmail: 'desk@inrp2p.test' }, { userId: opts.userId === undefined ? w.acceptor.userId : opts.userId, channel: opts.channel ?? 'APP', telegramChatId: opts.chat ?? null, text });

  it('by rule, from the person’s own state', async () => {
    expect(await ask('aaj ka rate kya hai')).toMatchObject({ source: 'RULE', intent: 'RATE' });
    expect((await ask('aaj ka rate kya hai')).answer).toContain('sell at ₹101.00, buy at ₹102.00');
    expect(await ask('how do I sell usdt')).toMatchObject({ source: 'RULE', intent: 'HOW_SELL', action: { href: '/exchange?direction=sell' } });
    expect(await ask('my otp is 123456')).toMatchObject({ source: 'RULE', intent: 'SECRET' });
  });

  it('what no rule knows goes to a person, as one conversation, and the answer comes back', async () => {
    const first = await ask('Can I trade on behalf of my cousin?');
    expect(first).toMatchObject({ source: 'CASE', intent: 'OTHER' });
    expect(first.answer).toContain(`I have passed it to a person at INRP2P (${first.caseRef})`);
    const second = await ask('Also, do you work on Sundays?');
    expect(second.caseRef).toBe(first.caseRef);
    const open = await w.app.selectFrom('robot_case').selectAll().where('user_id', '=', w.acceptor.userId).where('status', '=', 'OPEN').execute();
    expect(open).toHaveLength(1);
    expect(open[0]!.question).toBe('Can I trade on behalf of my cousin?\n— Also, do you work on Sundays?');

    await expect(runAs(w.app, answerRobotCase(w.finance.actor), w.finance.ref, 'robot.answer_case', { caseRef: first.caseRef!, answer: 'No.' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, answerRobotCase(w.dealer.actor), w.dealer.ref, 'robot.answer_case', { caseRef: first.caseRef!, answer: 'Only your own account, in your own name. Yes, the exchange runs every day.' });
    await expect(runAs(w.app, closeRobotCase(w.dealer.actor), w.dealer.ref, 'robot.close_case', { caseRef: first.caseRef!, reason: 'twice' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await deliver();
    const reply = (await clientInbox(w.app, w.clientId, { userId: w.acceptor.userId })).find((n) => n.kind === 'ROBOT_REPLY');
    expect(reply).toMatchObject({ title: 'INRP2P answered your question', href: '/robot' });
    expect(reply!.body).toContain('Only your own account');
    expect((await robotBriefOf(w.app, w.acceptor.userId))!.question).toMatchObject({ ref: first.caseRef, status: 'ANSWERED' });
  });

  it('with the model on: heard only when its figures are the facts’, within the day’s limit', async () => {
    await policy({ answers: 'AI', aiDailyLimit: 3 });
    const grounded = new FakeRobotMind(() => ({ answer: 'The market is at ₹101.00 to sell right now.', handoff: false, intent: 'MARKET_DEPTH' }));
    expect(await ask('do you have a mobile app', { mind: grounded })).toMatchObject({ source: 'AI', intent: 'MARKET_DEPTH', answer: 'The market is at ₹101.00 to sell right now.' });
    // The model was given facts in words, never an account number or another client.
    expect(grounded.asked[0]!.facts).toContain('Exchange stage:');
    expect(grounded.asked[0]!.facts).not.toMatch(/50100123458219|Neha|Ravi/);
    const inventing = new FakeRobotMind(() => ({ answer: 'You will get ₹99.99 per USDT tomorrow.', handoff: false, intent: 'RATE_FORECAST' }));
    expect(await ask('should I wait until tomorrow', { mind: inventing })).toMatchObject({ source: 'AI', caseRef: expect.stringMatching(/^RC-/) });
    const wary = new FakeRobotMind(() => ({ answer: 'That needs a decision by INRP2P.', handoff: true, intent: 'EXCEPTION' }));
    expect((await ask('can you reverse my last deal', { mind: wary })).answer).toMatch(/^That needs a decision by INRP2P\. I have passed it to a person/);
    // Three model answers today: the fourth question goes to a person without asking the model.
    const unused = new FakeRobotMind(() => ({ answer: 'x', handoff: false, intent: 'X' }));
    expect(await ask('what colour is the robot', { mind: unused })).toMatchObject({ source: 'CASE' });
    expect(unused.asked).toEqual([]);
  });

  it('a chat nobody linked hears the rules and where to write — and nothing about anyone', async () => {
    const out = await ask('i want to talk to a human', { userId: null, channel: 'TELEGRAM', chat: '777000' });
    expect(out).toMatchObject({ source: 'CASE', caseRef: null });
    expect(out.answer).toContain('Connect this chat to your INRP2P account');
    expect((await ask('where is my money', { userId: null, channel: 'TELEGRAM', chat: '777000' })).answer).toContain('once this chat is connected');
  });
});

describe('the desk’s view', () => {
  it('shows who is stuck, what waits, what the robot did and what to do about it', async () => {
    const intel = await robotIntel(w.app, { aiConfigured: false, canSeeTraders: true });
    expect(intel.policy.outreach).toBe('ON');
    expect(intel.switches).toEqual({ autoQuote: true, autoReview: false, peer: true });
    expect(intel.demand.waiting.BUY_USDT.requests).toBe(1);
    expect(intel.playbooks.find((p) => p.key === 'add_destination')).toMatchObject({ sent: 2, acted: 1 });
    expect(intel.openCases.length).toBeGreaterThanOrEqual(1);
    expect(intel.recommendations.map((x) => x.key)).toEqual(expect.arrayContaining(['no_side_BUY_USDT', 'cases', 'ai_unconfigured']));
    expect(intel.recent[0]).toMatchObject({ mode: 'LIVE' });
  });
});
