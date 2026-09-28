import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { createTestClientLogin, runAs } from '@inrp2p/identity/testing';
import { BANK_ACCOUNT_HMAC_CONTEXT, addBankAccount, setClientExchangeAccess } from '@inrp2p/clients';
import { portalAccess, workspaceAccess } from '../../packages/portal/src/index.ts';
import { createRequest } from '@inrp2p/quotes';
import {
  applyAsTrader, approveTrader, deskTrader, deskTraders, proposeSettlementChange, readStanding, rejectTrader, revealTraderPhone, reviewSettlementChange,
  reviewTraderDestination, setAvailability, setTraderSettlementDetails, standingIssues, traderApplicationOptions, traderHome,
} from '@inrp2p/traders';
import {
  type TraderPerson, type TradersWorld, applyAs, clientRequest, configureProgram, createTradersWorld, liveTrader, traderClient, traderIdOf, tradeThroughTrader,
} from './traders-world.ts';

/**
 * Trader self-onboarding (docs/TRADERS.md §3) and trader-submitted settlement changes (TD-24): a stranger applies
 * with nothing provisioned for them, gets no Exchange and no money authority for verifying an email, submits their
 * own bank account and wallet, and the desk verifies each of them before anything can settle through them.
 */

let w: TradersWorld;
beforeAll(async () => {
  w = await createTradersWorld('trader_onboarding');
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true });
});
afterAll(async () => w.close());

/** Someone who verified their email through "Become a trader": a client identity with no client at all. */
async function stranger(): Promise<TraderPerson> {
  const login = await createTestClientLogin(w.t.owner, { emailVerified: true });
  return { userId: login.userId, actor: { kind: 'CLIENT', userId: login.userId, sessionId: login.sessionId }, ref: login.ref as TraderPerson['ref'] };
}

let accountSeq = 610000000000;
const bankDetails = (holder: string) => ({ holderName: holder, bankName: 'HDFC Bank', accountNumber: String(accountSeq++), ifsc: 'HDFC0001234', rails: ['IMPS', 'NEFT'] as const });
const newWallet = () => ({ address: encodeTronAddress(randomBytes(20)), label: 'My trading wallet' });

const selfApplication = (holder: string) => ({
  fullName: holder, entityType: 'INDIVIDUAL' as const, telegram: 't.me/p2p_asha', phone: '+91 98765 43210', experience: 'BYBIT' as const, profileLink: 'https://www.bybit.com/fiat/trade/otc/profile/abc',
  offersBuy: true, offersSell: true, typicalInr: '200000', dailyInr: '1500000', typicalUsdt: '2000', dailyUsdt: '15000',
  bank: bankDetails(holder), wallet: newWallet(), confirmOwnership: true,
});

const apply = (who: TraderPerson, payload: Parameters<ReturnType<typeof applyAsTrader>['handle']>[1]) =>
  runAs(w.app, applyAsTrader(who.actor, w.traderDeps), who.ref, 'trader.apply', payload);

async function clientOf(userId: string) {
  return w.app
    .selectFrom('client_user as cu')
    .innerJoin('client as c', 'c.id', 'cu.client_id')
    .select(['c.id', 'c.display_name', 'c.type', 'c.exchange_access', 'cu.role', 'cu.can_accept_quotes'])
    .where('cu.user_id', '=', userId)
    .executeTakeFirstOrThrow();
}

describe('a stranger applies, with nothing provisioned for them', () => {
  it('verifying an email gives an application to fill in — no client, no Exchange, no money authority', async () => {
    const asha = await stranger();
    expect(await workspaceAccess(w.app, asha.userId)).toMatchObject({ kind: 'NEW' });
    await expect(portalAccess(w.app, asha.userId)).rejects.toMatchObject({ code: 'EXCHANGE_NOT_ENABLED' });
    expect(await traderHome(w.app, asha.userId)).toMatchObject({ state: 'NONE', canApply: true, canAct: false });
    const options = await traderApplicationOptions(w.app, asha.userId);
    expect(options).toMatchObject({ banks: [], wallets: [], canApply: true, profile: { fullName: null, nameFixed: false, typeFixed: false } });
  });

  it('the application needs a way to reach them, the ownership confirmation, and a daily capacity no lower than the order', async () => {
    const who = await stranger();
    const base = selfApplication('Ravi Kumar');
    await expect(apply(who, { ...base, telegram: null, phone: null })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'contact' } });
    await expect(apply(who, { ...base, confirmOwnership: false })).rejects.toMatchObject({ code: 'OWNERSHIP_NOT_CONFIRMED' });
    await expect(apply(who, { ...base, dailyInr: '1000' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', details: { field: 'dailyInr' } });
    await expect(apply(who, { ...base, fullName: null })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'fullName' } });
    // Nothing half-made is left behind by a refused application.
    expect(await w.app.selectFrom('client_user').select('id').where('user_id', '=', who.userId).execute()).toHaveLength(0);
  });

  it('submitting creates their client without the Exchange and their details pending review; the desk verifies each, then approves', async () => {
    const asha = await stranger();
    const application = selfApplication('Asha Menon');
    const applied = await apply(asha, application);
    expect(applied).toMatchObject({ status: 'UNDER_REVIEW', bankStatus: 'PENDING_REVIEW', walletStatus: 'PENDING_REVIEW' });

    const client = await clientOf(asha.userId);
    expect(client).toMatchObject({ display_name: 'Asha Menon', type: 'INDIVIDUAL', exchange_access: false, role: 'CLIENT_ADMIN', can_accept_quotes: false });
    await expect(portalAccess(w.app, asha.userId)).rejects.toMatchObject({ code: 'EXCHANGE_NOT_ENABLED' });
    await expect(apply(asha, application)).rejects.toMatchObject({ code: 'TRADER_EXISTS' });
    expect(await w.app.selectFrom('client_user').select('id').where('user_id', '=', asha.userId).execute()).toHaveLength(1);

    // The account number is sealed and fingerprinted like any other; the phone is sealed too.
    const traderId = await traderIdOf(w.app, client.id);
    const profile = await w.app.selectFrom('trader_profile').selectAll().where('id', '=', traderId).executeTakeFirstOrThrow();
    const bank = await w.app.selectFrom('bank_account').selectAll().where('id', '=', profile.bank_account_id).executeTakeFirstOrThrow();
    expect(bank).toMatchObject({ status: 'PENDING_REVIEW', holder_name: 'Asha Menon', ifsc: 'HDFC0001234', rail_preferences: ['IMPS', 'NEFT'], account_last4: application.bank.accountNumber.slice(-4) });
    expect(bank.account_hmac).toBe(w.traderDeps.protector.lookupHash(application.bank.accountNumber, BANK_ACCOUNT_HMAC_CONTEXT));
    expect(JSON.stringify(bank)).not.toContain(application.bank.accountNumber);
    expect(profile).toMatchObject({ telegram_handle: '@p2p_asha', phone_last4: '3210', p2p_experience: 'BYBIT', daily_capacity_inr_minor: 150_000_000n, daily_capacity_usdt_minor: 15_000_000_000n });
    expect(profile.ownership_confirmed_at).not.toBeNull();
    const wallet = await w.app.selectFrom('crypto_wallet').selectAll().where('id', '=', profile.wallet_id).executeTakeFirstOrThrow();
    expect(wallet).toMatchObject({ status: 'PENDING_REVIEW', purpose: 'BOTH', address: application.wallet.address, label: 'My trading wallet' });

    // The desk sees it first, with the applicant's own details — nothing to retype.
    const list = await deskTraders(w.app);
    expect(list.traders.find((t) => t.traderId === traderId)).toMatchObject({ status: 'UNDER_REVIEW', awaitingReview: 2, exchangeAccess: false });
    const detail = await deskTrader(w.app, traderId);
    expect(detail.applicant).toMatchObject({ fullName: 'Asha Menon', entityType: 'INDIVIDUAL', telegram: '@p2p_asha', phoneLast4: '3210', experience: 'BYBIT', exchangeAccess: false });
    expect(detail.bank).toMatchObject({ status: 'PENDING_REVIEW', holderName: 'Asha Menon', rails: ['IMPS', 'NEFT'] });
    const phone = await runAs(w.app, revealTraderPhone(w.finance.actor, w.traderDeps.protector), w.finance.ref, 'trader.reveal_phone', { traderId }, null);
    expect(phone.phone).toBe('+919876543210');

    // Approval waits for verified details; a rejection needs a note and is shown to the applicant.
    await expect(runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId })).rejects.toMatchObject({ code: 'TRADER_DESTINATION_UNVERIFIED' });
    await expect(runAs(w.app, reviewTraderDestination(w.dealer.actor), w.dealer.ref, 'trader.review_destination', { traderId, destination: 'BANK', decision: 'VERIFY' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, reviewTraderDestination(w.finance.actor), w.finance.ref, 'trader.review_destination', { traderId, destination: 'BANK', decision: 'VERIFY' });
    await expect(runAs(w.app, reviewTraderDestination(w.finance.actor), w.finance.ref, 'trader.review_destination', { traderId, destination: 'WALLET', decision: 'REJECT' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await runAs(w.app, reviewTraderDestination(w.finance.actor), w.finance.ref, 'trader.review_destination', { traderId, destination: 'WALLET', decision: 'REJECT', note: 'This wallet belongs to an exchange' });
    const home = await traderHome(w.app, asha.userId);
    expect(home.application).toMatchObject({ bank: { state: 'VERIFIED' }, wallet: { state: 'REJECTED', note: 'This wallet belongs to an exchange' } });

    // The applicant replaces the rejected wallet without starting over; the desk verifies it and approves.
    const replacement = newWallet();
    await runAs(w.app, proposeSettlementChange(asha.actor, w.traderDeps), asha.ref, 'trader.propose_settlement_change', { wallet: replacement, confirmOwnership: true });
    const afterReplace = await w.app.selectFrom('trader_profile').select(['wallet_id', 'proposed_wallet_id']).where('id', '=', traderId).executeTakeFirstOrThrow();
    expect(afterReplace.proposed_wallet_id).toBeNull();
    expect((await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', afterReplace.wallet_id).executeTakeFirstOrThrow()).address).toBe(replacement.address);
    await runAs(w.app, reviewTraderDestination(w.finance.actor), w.finance.ref, 'trader.review_destination', { traderId, destination: 'WALLET', decision: 'VERIFY' });
    await runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId, maxOrderInr: '300000' });

    // Approval is when — and the only way — the applicant may commit to orders; it switches nothing on.
    expect(await clientOf(asha.userId)).toMatchObject({ exchange_access: false, can_accept_quotes: true });
    const approved = await w.app.selectFrom('trader_profile').select(['status', 'available', 'max_order_inr_minor']).where('id', '=', traderId).executeTakeFirstOrThrow();
    expect(approved).toEqual({ status: 'APPROVED', available: false, max_order_inr_minor: 30_000_000n });
    await expect(runAs(w.app, setAvailability(asha.actor), asha.ref, 'trader.set_availability', { available: true })).rejects.toMatchObject({ code: 'TRADER_RESERVE_SHORT' });

    // Still no Exchange: a request for this client is refused even from the desk, and by the database beneath (IX080).
    const wallets = await w.app.selectFrom('crypto_wallet').select('id').where('client_id', '=', client.id).where('status', '=', 'ACTIVE').execute();
    await expect(runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: client.id, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', walletId: wallets[0]!.id }))
      .rejects.toMatchObject({ code: 'EXCHANGE_NOT_ENABLED' });
    await expect(sql`insert into trade_request (client_id, direction, fixed_side, requested_base_minor, crypto_wallet_id, channel, created_by)
      values (${client.id}, 'BUY_USDT', 'BASE', 1000000000, ${wallets[0]!.id}, 'OPERATOR', 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX080');
    // Until the desk opens it.
    await runAs(w.app, setClientExchangeAccess(w.dealer.actor), w.dealer.ref, 'client.set_exchange_access', { clientId: client.id, exchangeAccess: true, reason: 'Onboarded as a client too' });
    expect(await portalAccess(w.app, asha.userId)).toMatchObject({ clientId: client.id, exchangeAccess: true });
  });

  it('a rejected self-registered applicant applies again as the same client, and a pending detail they replace is withdrawn', async () => {
    const who = await stranger();
    await apply(who, selfApplication('Neel Shah'));
    const client = await clientOf(who.userId);
    const traderId = await traderIdOf(w.app, client.id);
    const first = await w.app.selectFrom('trader_profile').select(['bank_account_id']).where('id', '=', traderId).executeTakeFirstOrThrow();
    await runAs(w.app, rejectTrader(w.finance.actor), w.finance.ref, 'trader.reject', { traderId, note: 'Name on the account differs' });
    await apply(who, { ...selfApplication('Neel R Shah'), entityType: 'COMPANY' });
    expect(await clientOf(who.userId)).toMatchObject({ id: client.id, display_name: 'Neel R Shah', type: 'INDIVIDUAL' });
    expect((await w.app.selectFrom('bank_account').select('status').where('id', '=', first.bank_account_id).executeTakeFirstOrThrow()).status).toBe('ARCHIVED');
    expect(await w.app.selectFrom('client_user').select('id').where('user_id', '=', who.userId).execute()).toHaveLength(1);
  });
});

describe('an existing client applies as itself', () => {
  it('keeps its identity, its name and its Exchange, and uses the destinations the desk already verified', async () => {
    const t = await traderClient(w, 'Meridian Treasury');
    expect(await traderApplicationOptions(w.app, t.admin.userId)).toMatchObject({ profile: { fullName: 'Meridian Treasury', nameFixed: true, typeFixed: true } });
    const applied = await applyAs(w, t.admin, { offersBuy: true, offersSell: false, typicalInr: '100000', fullName: 'Someone Else', bankAccountId: t.bankAccountId, walletId: t.walletId });
    expect(applied).toMatchObject({ bankStatus: 'ACTIVE', walletStatus: 'ACTIVE' });
    const client = await w.app.selectFrom('client').select(['display_name', 'exchange_access']).where('id', '=', t.clientId).executeTakeFirstOrThrow();
    expect(client).toEqual({ display_name: 'Meridian Treasury', exchange_access: true });
    expect((await portalAccess(w.app, t.admin.userId)).clientId).toBe(t.clientId);
    // Verified details go straight to approval; nothing new was registered.
    await runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId: await traderIdOf(w.app, t.clientId) });
    // The desk-onboarded client's commit authority is its own decision, not the trader approval's.
    const member = await w.app.selectFrom('client_user').select('can_accept_quotes').where('user_id', '=', t.member.userId).executeTakeFirstOrThrow();
    expect(member.can_accept_quotes).toBe(false);
  });

  it('typing an account the desk already verified reuses it rather than registering it again', async () => {
    const t = await traderClient(w, 'Harbour Desk');
    const typed = bankDetails('Harbour Desk LLP');
    const verified = await runAs(w.app, addBankAccount(w.owner.actor, w.traderDeps.protector), w.owner.ref, 'client_bank.add', { clientId: t.clientId, ...typed });
    const applied = await applyAs(w, t.admin, { offersBuy: true, offersSell: false, typicalInr: '100000', bank: { ...typed, accountNumber: ` ${typed.accountNumber} ` }, walletId: t.walletId });
    expect(applied.bankStatus).toBe('ACTIVE');
    const profile = await w.app.selectFrom('trader_profile').select('bank_account_id').where('client_id', '=', t.clientId).executeTakeFirstOrThrow();
    expect(profile.bank_account_id).toBe(verified.bankAccountId);
    expect(await w.app.selectFrom('bank_account').select('id').where('client_id', '=', t.clientId).where('status', '=', 'PENDING_REVIEW').execute()).toHaveLength(0);
  });
});

describe('an approved trader submits new settlement details (TD-24)', () => {
  it('a replacement waits beside the verified details, which keep working; the desk switches only between orders', async () => {
    const t = await traderClient(w, 'Lotus Liquidity');
    const { traderId } = await liveTrader(w, t, { buy: { capacity: '600000', rate: '98.50', min: '10000', max: '600000' } });
    const before = await w.app.selectFrom('trader_profile').select(['bank_account_id', 'wallet_id']).where('id', '=', traderId).executeTakeFirstOrThrow();

    // Only an administrator submits, and only what it owns.
    await expect(runAs(w.app, proposeSettlementChange(t.member.actor, w.traderDeps), t.member.ref, 'trader.propose_settlement_change', { bank: bankDetails('Lotus Liquidity LLP'), confirmOwnership: true }))
      .rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    await expect(runAs(w.app, proposeSettlementChange(t.admin.actor, w.traderDeps), t.admin.ref, 'trader.propose_settlement_change', { bank: bankDetails('Lotus Liquidity LLP'), confirmOwnership: false }))
      .rejects.toMatchObject({ code: 'OWNERSHIP_NOT_CONFIRMED' });

    const proposed = await runAs(w.app, proposeSettlementChange(t.admin.actor, w.traderDeps), t.admin.ref, 'trader.propose_settlement_change', { bank: bankDetails('Lotus Liquidity LLP'), confirmOwnership: true });
    expect(proposed).toMatchObject({ bankStatus: 'PENDING_REVIEW', walletStatus: null });
    const pending = await w.app.selectFrom('trader_profile').select(['bank_account_id', 'wallet_id', 'proposed_bank_account_id']).where('id', '=', traderId).executeTakeFirstOrThrow();
    expect(pending).toMatchObject({ bank_account_id: before.bank_account_id, wallet_id: before.wallet_id });
    expect(pending.proposed_bank_account_id).not.toBeNull();
    // Nothing about the trader's standing moved: it still receives orders through its verified details.
    expect(standingIssues((await readStanding(w.app, traderId)).standing)).toEqual([]);
    expect((await traderHome(w.app, t.admin.userId)).proposal).toMatchObject({ bank: { state: 'PENDING_REVIEW' }, wallet: null });

    // An order in progress settles with the details it was accepted under: the switch waits.
    const requestId = await clientRequest(w, 'SELL_USDT', '1000');
    await tradeThroughTrader(w, t, { requestId, clientRate: '98.00' });
    await expect(runAs(w.app, reviewSettlementChange(w.finance.actor), w.finance.ref, 'trader.review_settlement_change', { traderId, destination: 'BANK', decision: 'APPROVE' }))
      .rejects.toMatchObject({ code: 'TRADER_ORDERS_OPEN' });
    // The desk's own switch to another verified account of the client waits the same way.
    const other = await runAs(w.app, addBankAccount(w.owner.actor, w.traderDeps.protector), w.owner.ref, 'client_bank.add', { clientId: t.clientId, ...bankDetails('Lotus Liquidity LLP') });
    await expect(runAs(w.app, setTraderSettlementDetails(w.finance.actor), w.finance.ref, 'trader.set_settlement_details', { traderId, bankAccountId: other.bankAccountId, walletId: before.wallet_id, reason: 'switch' }))
      .rejects.toMatchObject({ code: 'TRADER_ORDERS_OPEN' });
    // The desk may still refuse the change outright, with a note the trader sees.
    await runAs(w.app, reviewSettlementChange(w.finance.actor), w.finance.ref, 'trader.review_settlement_change', { traderId, destination: 'BANK', decision: 'REJECT', note: 'Account is in another name' });
    expect((await traderHome(w.app, t.admin.userId)).proposal).toMatchObject({ bank: { state: 'REJECTED', note: 'Account is in another name' } });
    expect((await w.app.selectFrom('trader_profile').select('bank_account_id').where('id', '=', traderId).executeTakeFirstOrThrow()).bank_account_id).toBe(before.bank_account_id);
  });

  it('once no order is open, approving verifies the new wallet, registers it and moves the trader’s routes to it', async () => {
    const t = await traderClient(w, 'Coral Traders');
    const { traderId } = await liveTrader(w, t, { sell: { capacity: '5000', rate: '97.10', min: '100', max: '5000' } });
    const next = newWallet();
    await runAs(w.app, proposeSettlementChange(t.admin.actor, w.traderDeps), t.admin.ref, 'trader.propose_settlement_change', { wallet: next, confirmOwnership: true });
    await expect(runAs(w.app, reviewSettlementChange(w.dealer.actor), w.dealer.ref, 'trader.review_settlement_change', { traderId, destination: 'WALLET', decision: 'APPROVE' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, reviewSettlementChange(w.finance.actor), w.finance.ref, 'trader.review_settlement_change', { traderId, destination: 'WALLET', decision: 'APPROVE' });
    const profile = await w.app.selectFrom('trader_profile').select(['wallet_id', 'proposed_wallet_id']).where('id', '=', traderId).executeTakeFirstOrThrow();
    expect(profile.proposed_wallet_id).toBeNull();
    const wallet = await w.app.selectFrom('crypto_wallet').select(['address', 'status', 'purpose']).where('id', '=', profile.wallet_id).executeTakeFirstOrThrow();
    expect(wallet).toEqual({ address: next.address, status: 'ACTIVE', purpose: 'BOTH' });
    const routes = await w.app.selectFrom('liquidity_route').select('registered_route_address').where('trader_id', '=', traderId).execute();
    expect(routes.every((r) => r.registered_route_address === next.address)).toBe(true);
    // The previous wallet stays on the client's file as it was.
    expect((await w.app.selectFrom('crypto_wallet').select('status').where('id', '=', t.walletId).executeTakeFirstOrThrow()).status).toBe('ACTIVE');
    expect(standingIssues((await readStanding(w.app, traderId)).standing)).toEqual([]);
  });
});
