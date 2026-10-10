import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { testFieldProtector } from '@inrp2p/adapters/testing';
import { createTestClientLogin, runAs } from '@inrp2p/identity/testing';
import { addBankAccount, openExchangeAccount } from '@inrp2p/clients';
import { globalImbalance } from '@inrp2p/ledger';
import { createRequest } from '@inrp2p/quotes';
import { usdtView } from '@inrp2p/desk';
import { detect } from '@inrp2p/scanner';
import { applyAsTrader, claimReserveDeposit, readStanding, requestReserveWithdrawal, reserveFigures, sharedReserveAddress, standingIssues, traderHome } from '@inrp2p/traders';
import { portalAccess, workspaceAccess } from '../../packages/portal/src/index.ts';
import { type TraderPerson, type TradersWorld, configureProgram, confirmOnChain, createTradersWorld, traderClient, traderIdOf } from './traders-world.ts';

/**
 * Self-service (owner decision D-17, 2026-10-10).
 *
 * 1. A client opens its own account with the workspace email code: the Exchange is open at once, no operator admits it.
 * 2. Every trader tops up its Security Reserve at one shared TRC20 address. The wallet the USDT came from says whose it
 *    is — the trader's registered wallet, on file before the transfer — so a hash anyone can read on chain cannot be
 *    claimed by someone else, a transfer is recorded and credited once, and topping up admits nobody to trading.
 */

const SHARED = 'TJNzB4sUGBo8fv7UdeeKQKQUffpfLSXbPP';

let w: TradersWorld;
beforeAll(async () => {
  w = await createTradersWorld('self_service');
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true });
});
afterAll(async () => w.close());

/** Someone who verified their email with the workspace code: a client identity with no client at all. */
async function stranger(): Promise<TraderPerson> {
  const login = await createTestClientLogin(w.t.owner, { emailVerified: true, stepUp: 'fresh' });
  return { userId: login.userId, actor: { kind: 'CLIENT', userId: login.userId, sessionId: login.sessionId }, ref: login.ref as TraderPerson['ref'] };
}

let accountSeq = 620000000000;
const usdt = (amount: string) => Money.parse(amount, 'USDT').minor;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A trader applicant with its own wallet, pending the desk's review — not approved, not able to commit. */
async function applicant(name: string, wallet = encodeTronAddress(randomBytes(20))) {
  const who = await stranger();
  await runAs(w.app, applyAsTrader(who.actor, w.traderDeps), who.ref, 'trader.apply', {
    fullName: name, entityType: 'INDIVIDUAL' as const, telegram: '@p2p_desk', experience: 'BINANCE' as const, confirmOwnership: true,
    offersBuy: true, offersSell: false, typicalInr: '200000', dailyInr: '1000000',
    bank: { holderName: name, bankName: 'HDFC Bank', accountNumber: String(accountSeq++), ifsc: 'HDFC0001234', rails: ['IMPS'] as const },
    wallet: { address: wallet, label: 'My wallet' },
  });
  const clientId = (await w.app.selectFrom('client_user').select('client_id').where('user_id', '=', who.userId).executeTakeFirstOrThrow()).client_id;
  return { who, clientId, traderId: await traderIdOf(w.app, clientId), wallet };
}

const claim = (who: TraderPerson, txHash: string) => runAs(w.app, claimReserveDeposit(who.actor, { chain: w.chain }), who.ref, 'trader_reserve.claim_deposit', { txHash });

const rowsFor = (txHash: string) => w.app.selectFrom('crypto_transfer').select(['payer_type', 'payer_id', 'state', 'source']).where('tx_hash', '=', txHash).execute();

const balanceOf = async (traderId: string) => (await reserveFigures(w.app, traderId)).balance.toDecimalString();

describe('one Security Reserve address for every trader', () => {
  it('is the owner’s address, active and watched — and no operator can add another one', async () => {
    const shared = await sharedReserveAddress(w.app);
    expect(shared?.address).toBe(SHARED);
    const wallet = await w.app.selectFrom('treasury_wallet').select(['role', 'status', 'custody']).where('address', '=', SHARED).executeTakeFirstOrThrow();
    expect(wallet).toEqual({ role: 'TRADER_RESERVE', status: 'ACTIVE', custody: 'EXTERNAL' });
    // A second active reserve address is refused by the database: changing it is a reviewed migration.
    await expect(
      sql`insert into treasury_wallet (network, address, label, role, created_by) values ('TRON', ${encodeTronAddress(randomBytes(20))}, 'Second reserve', 'TRADER_RESERVE', 'test')`.execute(w.t.owner),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('an applicant under review sees it and funds its reserve from its registered wallet — and is admitted to nothing', async () => {
    const a = await applicant('Meera Nair');
    expect(await traderHome(w.app, a.who.userId)).toMatchObject({ state: 'UNDER_REVIEW', canAct: false, reserve: { depositAddress: SHARED, balance: '0.000000' } });

    const r = w.chain.add({ from: a.wallet, to: SHARED, amountMinor: usdt('600') });
    await detect(w.app, r);
    expect(await rowsFor(r.txHash)).toEqual([{ payer_type: 'TRADER', payer_id: a.traderId, state: 'DETECTED', source: 'SCANNER' }]);
    // Credited on finality, never on sight.
    expect(await balanceOf(a.traderId)).toBe('0.000000');
    await confirmOnChain(w);
    expect(await balanceOf(a.traderId)).toBe('600.000000');

    // The desk sees whose reserve it is — the only place a deposit to one shared address says so — not "unattributed".
    const seen = (await usdtView(w.app, { transferLimit: 500 })).transfers.find((t) => t.txHash === r.txHash);
    const ref = (await w.app.selectFrom('trader_profile').select('ref').where('id', '=', a.traderId).executeTakeFirstOrThrow()).ref;
    expect(seen).toMatchObject({ tradeRef: null, reserve: { traderId: a.traderId, traderRef: ref, direction: 'IN' } });

    // Topping up is not admission: still under review, still not approved to receive anything.
    const after = await traderHome(w.app, a.who.userId);
    expect(after.state).toBe('UNDER_REVIEW');
    expect(standingIssues((await readStanding(w.app, a.traderId)).standing)).toContain('NOT_APPROVED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('a hash handed in is read from the chain, recorded once and credited once, whoever finds it first', async () => {
    const a = await applicant('Kiran Rao');
    const r = w.chain.add({ from: a.wallet, to: SHARED, amountMinor: usdt('250') });

    expect(await claim(a.who, r.txHash)).toEqual({ deposits: [{ txHash: r.txHash, logIndex: 0, amount: '250.000000', status: 'CONFIRMING' }] });
    // Again, spelt another way: the same transfer, nothing new.
    expect((await claim(a.who, `0x${r.txHash.toUpperCase()}`)).deposits).toEqual([{ txHash: r.txHash, logIndex: 0, amount: '250.000000', status: 'CONFIRMING' }]);
    // The scanner meets it afterwards and records nothing more.
    await detect(w.app, r);
    expect(await rowsFor(r.txHash)).toEqual([{ payer_type: 'TRADER', payer_id: a.traderId, state: 'DETECTED', source: 'CLIENT_SUBMITTED' }]);

    await confirmOnChain(w);
    await confirmOnChain(w);
    expect(await balanceOf(a.traderId)).toBe('250.000000');
    const transfer = await w.app.selectFrom('crypto_transfer').select('id').where('tx_hash', '=', r.txHash).executeTakeFirstOrThrow();
    const journals = await sql<{ n: string }>`select count(*)::text as n from ledger_journal where posting_key like ${`%${transfer.id}%`}`.execute(w.app);
    expect(journals.rows[0]!.n).toBe('1');
    expect((await claim(a.who, r.txHash)).deposits[0]!.status).toBe('CREDITED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('nobody can take another trader’s deposit by its hash — before the scanner records it or after', async () => {
    const owner = await applicant('Divya Shah');
    const thief = await applicant('Arjun Mehta');
    const r = w.chain.add({ from: owner.wallet, to: SHARED, amountMinor: usdt('300') });

    await expect(claim(thief.who, r.txHash)).rejects.toMatchObject({ code: 'TRADER_DEPOSIT_NOT_YOURS' });
    // A refused hand-in writes nothing.
    expect(await rowsFor(r.txHash)).toEqual([]);
    await claim(owner.who, r.txHash);
    await expect(claim(thief.who, r.txHash)).rejects.toMatchObject({ code: 'TRADER_DEPOSIT_NOT_YOURS' });
    await confirmOnChain(w);
    expect(await balanceOf(owner.traderId)).toBe('300.000000');
    expect(await balanceOf(thief.traderId)).toBe('0.000000');
  });

  it('a wallet put on file after the transfer does not make the transfer anyone’s', async () => {
    const sender = encodeTronAddress(randomBytes(20));
    const r = w.chain.add({ from: sender, to: SHARED, amountMinor: usdt('120') });
    await sleep(50);
    // Someone saw the transfer on chain, then registered its sender as their own wallet.
    const late = await applicant('Late Comer', sender);
    await expect(claim(late.who, r.txHash)).rejects.toMatchObject({ code: 'TRADER_DEPOSIT_NOT_YOURS' });
    await detect(w.app, r);
    expect(await rowsFor(r.txHash)).toEqual([{ payer_type: 'UNKNOWN', payer_id: null, state: 'DETECTED', source: 'SCANNER' }]);
    const transfer = await w.app.selectFrom('crypto_transfer').select('id').where('tx_hash', '=', r.txHash).executeTakeFirstOrThrow();
    const opened = await w.app.selectFrom('exception_case').select(['type', 'details']).where('subject_id', '=', transfer.id).execute();
    expect(opened).toEqual([{ type: 'USDT_UNEXPECTED_SENDER', details: expect.objectContaining({ reason: 'RESERVE_SENDER_NOT_REGISTERED', address: 'SHARED_TRADER_RESERVE' }) }]);
    await confirmOnChain(w);
    expect(await balanceOf(late.traderId)).toBe('0.000000');
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('money from a wallet two traders have on file is nobody’s until the desk decides', async () => {
    const wallet = encodeTronAddress(randomBytes(20));
    const one = await applicant('Same Wallet One', wallet);
    const two = await applicant('Same Wallet Two', wallet);
    const r = w.chain.add({ from: wallet, to: SHARED, amountMinor: usdt('75') });
    await expect(claim(one.who, r.txHash)).rejects.toMatchObject({ code: 'TRADER_DEPOSIT_NOT_YOURS' });
    await detect(w.app, r);
    const transfer = await w.app.selectFrom('crypto_transfer').select(['id', 'payer_type']).where('tx_hash', '=', r.txHash).executeTakeFirstOrThrow();
    expect(transfer.payer_type).toBe('UNKNOWN');
    const opened = await w.app.selectFrom('exception_case').select('details').where('subject_id', '=', transfer.id).executeTakeFirstOrThrow();
    expect(opened.details).toMatchObject({ reason: 'RESERVE_SENDER_AMBIGUOUS' });
    await confirmOnChain(w);
    expect([await balanceOf(one.traderId), await balanceOf(two.traderId)]).toEqual(['0.000000', '0.000000']);
  });

  it('the database credits a shared-address transfer to the sender’s trader or to nobody (IX102)', async () => {
    const a = await applicant('Guard Sender');
    const b = await applicant('Guard Other');
    const insert = (payerId: string) => sql`
      insert into crypto_transfer (network, tx_hash, log_index, token_contract, from_address, to_address, amount_minor, payer_type, payer_id, payee_type, payee_id, source, created_by)
      values ('TRON', ${randomBytes(32).toString('hex')}, 0, ${w.chain.tokenContract}, ${a.wallet}, ${SHARED}, 1000000, 'TRADER', ${payerId}, 'EXCHANGE_TREASURY',
              (select id from treasury_wallet where address = ${SHARED}), 'OPERATOR_SUBMITTED', 'test')`.execute(w.app);
    await expect(insert(b.traderId)).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === 'IX102');
    await insert(a.traderId);
  });

  it('a hash that pays something else, failed, or is no hash at all is refused and writes nothing', async () => {
    const a = await applicant('Careful Sender');
    const elsewhere = w.chain.add({ from: a.wallet, to: w.hotAddress, amountMinor: usdt('10') });
    await expect(claim(a.who, elsewhere.txHash)).rejects.toMatchObject({ code: 'TRADER_DEPOSIT_NOT_FOUND' });
    const failed = w.chain.add({ from: a.wallet, to: SHARED, amountMinor: usdt('10'), receiptStatus: 'FAILED' });
    await expect(claim(a.who, failed.txHash)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(claim(a.who, 'not-a-hash')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(claim(a.who, randomBytes(32).toString('hex'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await rowsFor(elsewhere.txHash)).toEqual([]);
    expect(await rowsFor(failed.txHash)).toEqual([]);
  });

  it('what a trader under review topped up goes back only to its verified wallet, asked for by its administrator', async () => {
    const a = await applicant('Refund Me');
    const r = w.chain.add({ from: a.wallet, to: SHARED, amountMinor: usdt('60') });
    await claim(a.who, r.txHash);
    await confirmOnChain(w);
    // Its wallet has not been verified yet, so nothing can be sent back to it.
    await expect(runAs(w.app, requestReserveWithdrawal(a.who.actor), a.who.ref, 'trader_reserve.request_withdrawal', { amount: '60' })).rejects.toMatchObject({ code: 'TRADER_DESTINATION_INVALID' });
  });
});

describe('a client opens its own account', () => {
  const open = (who: TraderPerson, name: string) =>
    runAs(w.app, openExchangeAccount(who.actor), who.ref, 'client.open_account', { name, entityType: 'INDIVIDUAL' as const });

  it('with the Exchange open at once; the person is its administrator, able to accept quotes, and trades without an operator admitting it', async () => {
    const who = await stranger();
    expect(await workspaceAccess(w.app, who.userId)).toMatchObject({ kind: 'NEW' });
    const opened = await open(who, 'Neha Kapoor');
    const member = await w.app
      .selectFrom('client_user as cu')
      .innerJoin('client as c', 'c.id', 'cu.client_id')
      .select(['c.id', 'c.display_name', 'c.type', 'c.exchange_access', 'c.kyc_status', 'cu.role', 'cu.can_accept_quotes'])
      .where('cu.user_id', '=', who.userId)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ id: opened.clientId, display_name: 'Neha Kapoor', type: 'INDIVIDUAL', exchange_access: true, kyc_status: 'NOT_STARTED', role: 'CLIENT_ADMIN', can_accept_quotes: true });
    expect(await portalAccess(w.app, who.userId)).toMatchObject({ clientId: opened.clientId, exchangeAccess: true, canAcceptQuotes: true });

    // Its own bank account (with its authenticator), then a request the desk will price: no operator in between.
    const bank = await runAs(w.app, addBankAccount(who.actor, testFieldProtector()), who.ref, 'client_bank.add', {
      clientId: opened.clientId, holderName: 'Neha Kapoor', bankName: 'ICICI Bank', ifsc: 'ICIC0001234', accountNumber: String(accountSeq++), railPreferences: ['IMPS'] as const,
    });
    const request = await runAs(w.app, createRequest(who.actor, {}), who.ref, 'request.create', {
      clientId: opened.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1500', bankAccountId: bank.bankAccountId,
    });
    expect(request.requestId).toBeTruthy();
    const audit = await w.app.selectFrom('audit_event').select(['action', 'after']).where('entity_id', '=', opened.clientId).where('action', '=', 'client.self_registered').executeTakeFirstOrThrow();
    expect(audit.after).toMatchObject({ via: 'client.open_account', exchange_access: true });
  });

  it('once per person: a second opening, a trader applicant’s and a desk-linked user’s are refused', async () => {
    const who = await stranger();
    await open(who, 'First Account');
    await expect(open(who, 'Second Account')).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
    const trader = await applicant('Already A Trader');
    await expect(open(trader.who, 'Trader Too')).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
    const desk = await traderClient(w, 'Desk Made');
    await expect(open(desk.admin, 'Desk Made Again')).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
  });

  it('two openings at once make one account', async () => {
    const who = await stranger();
    const results = await Promise.allSettled([open(who, 'Racing One'), open(who, 'Racing Two')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await w.app.selectFrom('client_user').select('id').where('user_id', '=', who.userId).execute()).toHaveLength(1);
  });
});
