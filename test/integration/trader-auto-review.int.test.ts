import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import type { OutboxEvent } from '@inrp2p/outbox';
import { createTestClientLogin, runAs } from '@inrp2p/identity/testing';
import { linkClientUser } from '@inrp2p/clients';
import { traderNotificationHandler } from '@inrp2p/notifications';
import {
  DEFAULT_RISK_POLICY, type RiskPolicy, acceptOrder, applyAsTrader, approveTrader, assignRequest, cancelSettlementChange, deskTrader, deskTraders, dueSettlementChanges, proposeSettlementChange,
  readStanding, rejectTrader, requestReserveWithdrawal, requireRiskPolicy, reviewTraderDestination, runTraderSweep, sharedReserveAddress, traderHome, traderReviewHandler,
} from '@inrp2p/traders';
import {
  type TraderPerson, type TradersWorld, clientRequest, configureProgram, confirmOnChain, createTradersWorld, liveTrader, sendUsdt, traderClient, traderIdOf, tradeThroughTrader,
} from './traders-world.ts';

/**
 * ADR 0024: traders go live without a person in the loop. The programme reviews an application by rule — the wallet
 * proven by the reserve sent from it, the bank account consistent, the reserve funded — and leaves the rest to a person
 * with its reasons; a trader deals within limits its own reserve and record set; a change of where an approved trader
 * is paid needs a fresh code, is told to every member and waits out a hold.
 */

let w: TradersWorld;
let reserveAddress: string;
beforeAll(async () => {
  w = await createTradersWorld('trader_auto_review');
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true, autoReview: true, riskPolicy: DEFAULT_RISK_POLICY });
  reserveAddress = (await sharedReserveAddress(w.app))!.address;
});
afterAll(async () => w.close());

async function stranger(): Promise<TraderPerson> {
  const login = await createTestClientLogin(w.t.owner, { emailVerified: true });
  return { userId: login.userId, actor: { kind: 'CLIENT', userId: login.userId, sessionId: login.sessionId }, ref: login.ref as TraderPerson['ref'] };
}

let accountSeq = 820000000000;
const newWallet = () => ({ address: encodeTronAddress(randomBytes(20)), label: 'Trading wallet' });
const bankOf = (holder: string, accountNumber = String(accountSeq++)) => ({ holderName: holder, bankName: 'ICICI Bank', accountNumber, ifsc: 'ICIC0001234', rails: ['IMPS'] as const });
const application = (name: string, opts: { holder?: string; accountNumber?: string; wallet?: { address: string; label: string } } = {}) => ({
  fullName: name, entityType: 'INDIVIDUAL' as const, telegram: '@p2p_trader', experience: 'BINANCE' as const, offersBuy: false, offersSell: true,
  typicalUsdt: '1000', dailyUsdt: '5000', bank: bankOf(opts.holder ?? name, opts.accountNumber), wallet: opts.wallet ?? newWallet(), confirmOwnership: true,
});

async function applied(name: string, opts: Parameters<typeof application>[1] = {}) {
  const who = await stranger();
  const payload = application(name, opts);
  await runAs(w.app, applyAsTrader(who.actor, w.traderDeps), who.ref, 'trader.apply', payload);
  const cu = await w.app.selectFrom('client_user').select('client_id').where('user_id', '=', who.userId).executeTakeFirstOrThrow();
  const traderId = await traderIdOf(w.app, cu.client_id);
  return { who, traderId, clientId: cu.client_id, wallet: payload.wallet.address, accountNumber: payload.bank.accountNumber };
}

/** Hands this trader's events — and the programme's — to the review handler, each once, as the dispatcher would. */
const seen = new Set<string>();
async function review(traderId?: string): Promise<void> {
  const handler = traderReviewHandler(w.app);
  const rows = await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).orderBy('created_at').execute();
  for (const e of rows) {
    if (seen.has(e.id) || !handler.handles(e.type)) continue;
    if (e.type !== 'trader_program.auto_review_enabled' && traderId && e.aggregate_id !== traderId) continue;
    seen.add(e.id);
    await handler.run({ id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id } as OutboxEvent);
  }
}

const profileOf = (traderId: string) =>
  w.app.selectFrom('trader_profile').select(['status', 'auto_review_flags', 'approved_at', 'reviewed_by', 'review_note', 'bank_account_id', 'wallet_id', 'proposal_effective_at', 'proposed_bank_account_id', 'proposed_wallet_id'])
    .where('id', '=', traderId).executeTakeFirstOrThrow();
const statusOf = async (table: 'bank_account' | 'crypto_wallet', id: string) => (await w.app.selectFrom(table).select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

async function fundReserve(from: string, amount: string): Promise<void> {
  await sendUsdt(w, from, reserveAddress, amount);
  await confirmOnChain(w);
}

describe('the programme reviews an application by rule', () => {
  it('verifies a consistent bank account at once, waits for the reserve from the wallet, and approves the moment it lands', async () => {
    const a = await applied('Asha Menon');
    await review(a.traderId);
    const waiting = await profileOf(a.traderId);
    expect(waiting).toMatchObject({ status: 'UNDER_REVIEW', auto_review_flags: ['WALLET_NOT_PROVEN', 'RESERVE_SHORT'] });
    // The account holder is the applicant, on no other file: verified now. The wallet is only an address so far.
    expect(await statusOf('bank_account', waiting.bank_account_id)).toBe('ACTIVE');
    expect(await statusOf('crypto_wallet', waiting.wallet_id)).toBe('PENDING_REVIEW');
    // The applicant is told its move: the reserve, from its own wallet.
    expect((await traderHome(w.app, a.who.userId)).review).toEqual({ automatic: true, waitingOn: 'RESERVE', reserveToSend: '500.000000' });

    // Part of it proves the wallet — and the review says how much is still to come.
    await fundReserve(a.wallet, '300');
    await review(a.traderId);
    expect(await profileOf(a.traderId)).toMatchObject({ status: 'UNDER_REVIEW', auto_review_flags: ['RESERVE_SHORT'] });
    expect(await statusOf('crypto_wallet', waiting.wallet_id)).toBe('ACTIVE');
    expect((await traderHome(w.app, a.who.userId)).review).toMatchObject({ waitingOn: 'RESERVE', reserveToSend: '200.000000' });

    // The rest: approved, with the authority to commit — and nothing switched on.
    await fundReserve(a.wallet, '200');
    await review(a.traderId);
    const approved = await profileOf(a.traderId);
    expect(approved).toMatchObject({ status: 'APPROVED', auto_review_flags: [], reviewed_by: 'SYSTEM' });
    expect(approved.approved_at).not.toBeNull();
    expect(approved.review_note).toMatch(/wallet proven on chain/);
    const cu = await w.app.selectFrom('client_user').select('can_accept_quotes').where('user_id', '=', a.who.userId).executeTakeFirstOrThrow();
    expect(cu.can_accept_quotes).toBe(true);
    const audit = await w.app.selectFrom('audit_event').select('after').where('entity_id', '=', a.traderId).where('action', '=', 'trader.approved').executeTakeFirstOrThrow();
    expect(audit.after).toMatchObject({ via: 'AUTO_REVIEW', required_reserve_minor: '500000000' });
    expect(await w.app.selectFrom('outbox_event').select('id').where('aggregate_id', '=', a.traderId).where('type', '=', 'trader.approved').execute()).toHaveLength(1);
    const standing = await readStanding(w.app, a.traderId);
    expect(standing.standing).toMatchObject({ status: 'APPROVED', available: false, reserveFunded: true, destinationsActive: true });

    // A redelivered event changes nothing.
    seen.clear();
    await review(a.traderId);
    expect((await profileOf(a.traderId)).status).toBe('APPROVED');
    expect(await w.app.selectFrom('audit_event').select('seq').where('entity_id', '=', a.traderId).where('action', '=', 'trader.approved').execute()).toHaveLength(1);
  });

  it('leaves a holder in another name for a person — whose verification is then all the rules wait for', async () => {
    const v = await applied('Vikram Rao', { holder: 'Sunita Rao' });
    await fundReserve(v.wallet, '500');
    await review(v.traderId);
    const profile = await profileOf(v.traderId);
    expect(profile).toMatchObject({ status: 'UNDER_REVIEW', auto_review_flags: ['BANK_NAME_MISMATCH'] });
    expect(await statusOf('bank_account', profile.bank_account_id)).toBe('PENDING_REVIEW');
    expect(await statusOf('crypto_wallet', profile.wallet_id)).toBe('ACTIVE');
    expect((await traderHome(w.app, v.who.userId)).review).toMatchObject({ waitingOn: 'DESK', reserveToSend: '0.000000' });
    expect((await deskTraders(w.app)).traders.find((t) => t.traderId === v.traderId)).toMatchObject({ autoReviewFlags: ['BANK_NAME_MISMATCH'], awaitingReview: 1 });

    // The desk satisfies itself (the account is a joint one, say) and verifies it: the rules approve straight after.
    await runAs(w.app, reviewTraderDestination(w.finance.actor), w.finance.ref, 'trader.review_destination', { traderId: v.traderId, destination: 'BANK', decision: 'VERIFY', note: 'Joint account with spouse, statement seen' });
    await review(v.traderId);
    expect(await profileOf(v.traderId)).toMatchObject({ status: 'APPROVED', auto_review_flags: [] });
  });

  it('never verifies details another client has on file, and never approves again an applicant the desk rejected', async () => {
    const first = await applied('Ravi Kumar');
    // The same account number and the same wallet, under someone else's name and client.
    const copy = await applied('Ravi Kumar', { accountNumber: first.accountNumber, wallet: { address: first.wallet, label: 'Same wallet' } });
    await review(copy.traderId);
    const flags = (await profileOf(copy.traderId)).auto_review_flags;
    expect(flags).toEqual(expect.arrayContaining(['BANK_ON_FILE_ELSEWHERE', 'WALLET_ON_FILE_ELSEWHERE', 'WALLET_NOT_PROVEN']));
    expect(await statusOf('bank_account', (await profileOf(copy.traderId)).bank_account_id)).toBe('PENDING_REVIEW');
    // The first applicant is held back the same way now: its account and wallet are on another file too.
    await review(first.traderId);
    expect((await profileOf(first.traderId)).auto_review_flags).toEqual(expect.arrayContaining(['WALLET_ON_FILE_ELSEWHERE']));

    // Rejected by the desk, applying again with clean details and a funded reserve: a person decides.
    const neel = await applied('Neel Shah');
    await runAs(w.app, rejectTrader(w.finance.actor), w.finance.ref, 'trader.reject', { traderId: neel.traderId, note: 'Call us first' });
    const again = application('Neel Shah');
    await runAs(w.app, applyAsTrader(neel.who.actor, w.traderDeps), neel.who.ref, 'trader.apply', again);
    await fundReserve(again.wallet.address, '500');
    await review(neel.traderId);
    const held = await profileOf(neel.traderId);
    expect(held).toMatchObject({ status: 'UNDER_REVIEW', auto_review_flags: ['REJECTED_BEFORE'] });
    expect(await statusOf('bank_account', held.bank_account_id)).toBe('ACTIVE');
    expect(await statusOf('crypto_wallet', held.wallet_id)).toBe('ACTIVE');
    expect((await traderHome(w.app, neel.who.userId)).review).toMatchObject({ waitingOn: 'DESK' });
    expect((await deskTrader(w.app, neel.traderId)).autoReview).toMatchObject({ flags: ['REJECTED_BEFORE'] });
    await runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId: neel.traderId });
    expect((await profileOf(neel.traderId)).status).toBe('APPROVED');
  });

  it('does nothing while switched off, and reviews every waiting application when switched on', async () => {
    await configureProgram(w, { autoReview: false, riskPolicy: DEFAULT_RISK_POLICY });
    const m = await applied('Meera Iyer');
    await fundReserve(m.wallet, '500');
    await review(m.traderId);
    const untouched = await profileOf(m.traderId);
    expect(untouched).toMatchObject({ status: 'UNDER_REVIEW', auto_review_flags: [] });
    expect(await statusOf('bank_account', untouched.bank_account_id)).toBe('PENDING_REVIEW');
    expect((await traderHome(w.app, m.who.userId)).review).toMatchObject({ automatic: false, waitingOn: 'DESK' });

    await configureProgram(w, { autoReview: true, riskPolicy: DEFAULT_RISK_POLICY });
    await review();
    expect(await profileOf(m.traderId)).toMatchObject({ status: 'APPROVED' });
  });

  it('the database refuses an approval without verified details or a reserve, whoever asks (IX138)', async () => {
    await configureProgram(w, { autoReview: false, riskPolicy: DEFAULT_RISK_POLICY });
    const x = await applied('Kiran Das');
    await expect(sql`update trader_profile set status = 'APPROVED', required_reserve_minor = 500000000, approved_at = now(), reviewed_at = now() where id = ${x.traderId}`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX138');
    const p = await profileOf(x.traderId);
    await sql`update bank_account set status = 'ACTIVE' where id = ${p.bank_account_id}`.execute(w.t.owner);
    await sql`update crypto_wallet set status = 'ACTIVE' where id = ${p.wallet_id}`.execute(w.t.owner);
    await expect(sql`update trader_profile set status = 'APPROVED', approved_at = now(), reviewed_at = now() where id = ${x.traderId}`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX138');
    await configureProgram(w, { autoReview: true, riskPolicy: DEFAULT_RISK_POLICY });
  });
});

describe('a trader deals within what its reserve and record allow', () => {
  it('under a policy the database and the code agree on, case for case', async () => {
    const ok = DEFAULT_RISK_POLICY;
    const cases: unknown[] = [
      ok,
      { ...ok, cleanDays: 0 },
      { cleanDays: 30, tiers: ok.tiers.slice(0, 2) },
      { ...ok, cleanDays: 366 },
      { ...ok, tiers: [{ ...ok.tiers[0], minDays: 1 }, ok.tiers[1], ok.tiers[2]] },
      { ...ok, tiers: [ok.tiers[0], { ...ok.tiers[1], openX: 3 }, ok.tiers[2]] },
      { ...ok, tiers: [ok.tiers[0], ok.tiers[1], { ...ok.tiers[2], minDeals: 5 }] },
      { ...ok, tiers: [ok.tiers[0], ok.tiers[1], { ...ok.tiers[2], dealX: 'ten' }] },
      { ...ok, tiers: [ok.tiers[0], ok.tiers[1], { ...ok.tiers[2], dealX: 101 }] },
      { ...ok, tiers: 'three' },
    ];
    for (const c of cases) {
      let code = true;
      try {
        requireRiskPolicy(c);
      } catch {
        code = false;
      }
      const db = await sql<{ ok: boolean }>`select inrp2p_valid_trader_risk_policy(${JSON.stringify(c)}::jsonb) as ok`.execute(w.app);
      expect([JSON.stringify(c), db.rows[0]!.ok]).toEqual([JSON.stringify(c), code]);
    }
  });

  let t: Awaited<ReturnType<typeof traderClient>>;
  let traderId: string;
  beforeAll(async () => {
    t = await traderClient(w, 'Saffron Liquidity');
    ({ traderId } = await liveTrader(w, t, { sell: { capacity: '20000', rate: '97.00', min: '100', max: '20000' } }));
  });
  const offer = async (amount: string) => {
    const requestId = await clientRequest(w, 'BUY_USDT', amount);
    return runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId });
  };
  const accept = (ref: string) => runAs(w.app, acceptOrder(t.admin.actor), t.admin.ref, 'trader_order.accept', { ref });

  it('is offered nothing larger than its level allows on its free reserve, and more as soon as it deposits more', async () => {
    // A new trader with 500 USDT free: one deal up to twice that, open deals up to four times.
    const home = await traderHome(w.app, t.admin.userId);
    expect(home.limits).toMatchObject({ level: 'NEW', heldBack: false, maxDeal: '1000.000000', maxOpen: '2000.000000', open: '0.000000', completedDeals: 0, next: { level: 'PROVEN', deals: 10, days: 7 } });

    await expect(offer('1500')).rejects.toMatchObject({ code: 'TRADER_NONE_ELIGIBLE', details: { excluded: { DEAL_ABOVE_LIMIT: 1 } } });
    await accept((await offer('900')).ref);
    await accept((await offer('950')).ref);
    await expect(offer('200')).rejects.toMatchObject({ code: 'TRADER_NONE_ELIGIBLE', details: { excluded: { OPEN_ABOVE_LIMIT: 1 } } });
    expect((await traderHome(w.app, t.admin.userId)).limits).toMatchObject({ open: '1850.000000' });

    // 1,500 more from its own wallet: 2,000 free stretches to 4,000 a deal and 8,000 open.
    await fundReserve(t.walletAddress, '1500');
    await accept((await offer('200')).ref);
    await accept((await offer('1500')).ref);
    expect((await traderHome(w.app, t.admin.userId)).limits).toMatchObject({ maxDeal: '4000.000000', maxOpen: '8000.000000', open: '3550.000000' });
    expect((await deskTraders(w.app)).traders.find((r) => r.traderId === traderId)?.risk).toMatchObject({ level: 'NEW', open: '3550.000000', maxOpen: '8000.000000' });
  });

  it('cannot withdraw the reserve its open deals stand on', async () => {
    // Open: 3,550 (largest 1,500). Backing at ×2 a deal and ×4 open: max(750, 888) — more than the 500 requirement.
    const { reserve } = await readStanding(w.app, traderId);
    expect(reserve.limits?.backingMinor).toBe(887_500_000n);
    expect(reserve.locked.toDecimalString()).toBe('887.500000');
    expect(reserve.available.toDecimalString()).toBe('1112.500000');
    await expect(runAs(w.app, requestReserveWithdrawal(t.admin.actor), t.admin.ref, 'trader_reserve.request_withdrawal', { amount: '1200' }))
      .rejects.toMatchObject({ code: 'TRADER_WITHDRAWAL_EXCEEDS_AVAILABLE', details: { available: '1112.500000' } });
    await runAs(w.app, requestReserveWithdrawal(t.admin.actor), t.admin.ref, 'trader_reserve.request_withdrawal', { amount: '1000' });
  });

  it('accepts no offer that no longer fits, when the programme tightens the limits after it was made', async () => {
    const made = await offer('300');
    const tight: RiskPolicy = { cleanDays: 30, tiers: [{ minDeals: 0, minDays: 0, dealX: 1, openX: 1 }, DEFAULT_RISK_POLICY.tiers[1], DEFAULT_RISK_POLICY.tiers[2]] };
    await configureProgram(w, { autoReview: true, riskPolicy: tight });
    await expect(accept(made.ref)).rejects.toMatchObject({ code: 'TRADER_NOT_ELIGIBLE', details: { issues: ['OPEN_ABOVE_LIMIT'] } });
    await configureProgram(w, { autoReview: true, riskPolicy: DEFAULT_RISK_POLICY });
    await accept(made.ref);
  });
});

describe('a change of where an approved trader is paid', () => {
  let t: Awaited<ReturnType<typeof traderClient>>;
  let traderId: string;
  beforeAll(async () => {
    t = await traderClient(w, 'Indigo Exchange');
    ({ traderId } = await liveTrader(w, t, { buy: { capacity: '600000', rate: '98.50', min: '10000', max: '600000' } }));
  });
  const propose = (who: TraderPerson, p: Record<string, unknown>) => runAs(w.app, proposeSettlementChange(who.actor, w.traderDeps), who.ref, 'trader.propose_settlement_change', { confirmOwnership: true, ...p } as never);
  const later = async (hours: number) => {
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + hours * 3_600_000));
    return clock;
  };

  it('needs a fresh authenticator code — a session alone changes nothing about where a trader is paid', async () => {
    const stale = await createTestClientLogin(w.t.owner, { emailVerified: true, stepUp: 'stale' });
    await runAs(w.app, linkClientUser(w.owner.actor), w.owner.ref, 'client_user.link', { clientId: t.clientId, userId: stale.userId, role: 'CLIENT_ADMIN' as const });
    const who = { userId: stale.userId, actor: { kind: 'CLIENT' as const, userId: stale.userId, sessionId: stale.sessionId }, ref: stale.ref as TraderPerson['ref'] };
    await expect(propose(who, { bank: bankOf('Indigo Exchange LLP') })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const plain = await createTestClientLogin(w.t.owner, { emailVerified: true });
    await runAs(w.app, linkClientUser(w.owner.actor), w.owner.ref, 'client_user.link', { clientId: t.clientId, userId: plain.userId, role: 'CLIENT_ADMIN' as const });
    await expect(propose({ userId: plain.userId, actor: { kind: 'CLIENT', userId: plain.userId, sessionId: plain.sessionId }, ref: plain.ref as TraderPerson['ref'] }, { bank: bankOf('Indigo Exchange LLP') }))
      .rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
  });

  it('tells every member at once, keeps the registered details through its hold, and is then applied by rule', async () => {
    const before = await profileOf(traderId);
    const out = await propose(t.admin, { bank: bankOf('Indigo Exchange LLP') });
    const hours = (Date.parse(out.effectiveAt!) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    const home = await traderHome(w.app, t.member.userId);
    expect(home.proposal).toMatchObject({ bank: { state: 'PENDING_REVIEW' }, effectiveAt: out.effectiveAt, waitingOn: 'HOLD' });

    // Every member's inbox (the client's, not one person's), and by email.
    const notify = traderNotificationHandler(w.app);
    const event = await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).where('aggregate_id', '=', traderId).where('type', '=', 'trader.settlement_change_proposed').executeTakeFirstOrThrow();
    await notify.run({ id: event.id, type: event.type, aggregateType: event.aggregate_type, aggregateId: event.aggregate_id, payload: event.payload, correlationId: event.correlation_id } as OutboxEvent);
    const note = await w.app.selectFrom('client_notification').select(['kind', 'user_id', 'title', 'body']).where('client_id', '=', t.clientId).where('kind', '=', 'TRADER_SETTLEMENT_CHANGE').executeTakeFirstOrThrow();
    expect(note).toMatchObject({ user_id: null, title: 'A new bank account was submitted for your trader account' });
    expect(note.body).toMatch(/If this was not you, stop it/);

    // Not before its time.
    await runTraderSweep(w.app);
    expect((await profileOf(traderId)).bank_account_id).toBe(before.bank_account_id);

    const clock = await later(25);
    const report = await runTraderSweep(clock.db);
    expect(report.changesApplied).toBe(1);
    const after = await profileOf(traderId);
    expect(after.bank_account_id).not.toBe(before.bank_account_id);
    expect(after).toMatchObject({ proposed_bank_account_id: null, proposal_effective_at: null, auto_review_flags: [] });
    expect(await statusOf('bank_account', after.bank_account_id)).toBe('ACTIVE');
    const bank = await w.app.selectFrom('bank_account').select('account_last4').where('id', '=', after.bank_account_id).executeTakeFirstOrThrow();
    const routes = await w.app.selectFrom('liquidity_route').select('registered_payout_identity').where('trader_id', '=', traderId).execute();
    expect(routes.every((r) => r.registered_payout_identity === `ICICI Bank ••••${bank.account_last4}`)).toBe(true);
    await clock.set(null);
  });

  it('is stopped by any administrator, and waits for open orders, or for a person when a rule is not met', async () => {
    // Stopped: what was submitted is withdrawn and the registered wallet stays.
    const before = await profileOf(traderId);
    await propose(t.admin, { wallet: newWallet() });
    const proposed = (await profileOf(traderId)).proposed_wallet_id!;
    await runAs(w.app, cancelSettlementChange(t.admin.actor), t.admin.ref, 'trader.cancel_settlement_change', {});
    expect(await profileOf(traderId)).toMatchObject({ wallet_id: before.wallet_id, proposed_wallet_id: null, proposal_effective_at: null });
    expect(await statusOf('crypto_wallet', proposed)).toBe('ARCHIVED');
    await expect(runAs(w.app, cancelSettlementChange(t.admin.actor), t.admin.ref, 'trader.cancel_settlement_change', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // An order in progress settles with the details it was accepted under: the change waits for it.
    await propose(t.admin, { wallet: newWallet() });
    await tradeThroughTrader(w, t, { requestId: await clientRequest(w, 'SELL_USDT', '200'), clientRate: '98.00' });
    const clock = await later(25);
    expect((await runTraderSweep(clock.db)).changesApplied).toBe(0);
    expect(await profileOf(traderId)).toMatchObject({ wallet_id: before.wallet_id, auto_review_flags: ['ORDERS_OPEN'] });
    expect((await traderHome(clock.db, t.admin.userId)).proposal).toMatchObject({ waitingOn: 'ORDERS' });
    await clock.set(null);
  });

  it('leaves a bank account in someone else’s name for a person, however long it has waited', async () => {
    const other = await traderClient(w, 'Teal Brokers');
    const { traderId: otherId } = await liveTrader(w, other, { buy: { capacity: '600000', rate: '98.40', min: '10000', max: '600000' } });
    await propose(other.admin, { bank: bankOf('Somebody Else') });
    const clock = await later(25);
    await runTraderSweep(clock.db);
    const waiting = await profileOf(otherId);
    expect(waiting.auto_review_flags).toEqual(['BANK_NAME_MISMATCH']);
    expect(waiting.proposed_bank_account_id).not.toBeNull();
    expect((await traderHome(clock.db, other.admin.userId)).proposal).toMatchObject({ waitingOn: 'DESK' });
    // Looked at once: the sweep leaves it alone until something about it changes.
    expect((await dueSettlementChanges(clock.db)).includes(otherId)).toBe(false);
    await clock.set(null);
  });
});
