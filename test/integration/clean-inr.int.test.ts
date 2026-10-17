import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { testFieldProtector } from '@inrp2p/adapters/testing';
import { addBankAccount, createClient } from '@inrp2p/clients';
import { setInrAccountCollectionDetails } from '@inrp2p/inr-accounts';
import { portalTrade } from '../../packages/portal/src/index.ts';
import {
  acceptIncomingSender, checkIncomingSender, claimIncomingFiat, confirmFirstLeg, expireUnpaidTrades, importBankStatement, recordIncomingFiat,
} from '@inrp2p/settlement';
import { type World, createWorld, openTrade } from '../../packages/settlement/test/world.ts';

/**
 * Clean INR (ADR 0018, FI-96): a client's rupees count only when they came from the client's own registered account.
 * The client is told where to pay, by when and under which reference; says it paid, from which of its accounts; and
 * the desk confirms the payment only once the bank — a statement, or a person looking at the credit — showed who sent
 * it. A stranger's rupees never count, whatever anyone clicks, and the database says so too (IX116, IX119).
 */
let w: World;
const imps = () => String(randomInt(1e11, 1e12));
/** The scenario client's registered account: "Acme Pay Private Limited", HDFC ••8219. */
const HOLDER = 'ACME PAY PVT LTD';

beforeAll(async () => {
  w = await createWorld('clean-inr', { capacityInr: '900000000.00' });
});
afterAll(async () => w.close());

const buy = (baseUsdt = '1000') => openTrade(w, { direction: 'BUY_USDT', baseUsdt });
const due = async (tradeId: string) => {
  const e = await w.app.selectFrom('trade_economics').select('quote_inr_minor').where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
  return Money.ofMinor(e.quote_inr_minor, 'INR').toDecimalString();
};
const claim = (tradeRef: string, p: { utr?: string; from?: string; rail?: 'IMPS' | 'UPI' | 'NEFT' | 'RTGS'; amount?: string } = {}) =>
  runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', {
    tradeRef, rail: p.rail ?? 'IMPS', utr: p.utr ?? imps(), fromBankAccountId: p.from ?? w.bankAccountId, ...(p.amount ? { amount: p.amount } : {}),
  });
const check = (transferId: string, senderName: string, senderAccount: string | null = null) =>
  runAs(w.app, checkIncomingSender(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.check_sender', { transferId, senderName, senderAccount });
const confirm = (legId: string) => runAs(w.app, confirmFirstLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'settlement.confirm_incoming', { legId });
const legOf = (legRef: string) => w.app.selectFrom('settlement_leg').select(['id', 'status']).where('ref', '=', legRef).executeTakeFirstOrThrow();

describe('a BUY tells its client where to pay, by when, and under which reference', () => {
  it('fixes the instructions when the quote is accepted, and shows the client the account in full', async () => {
    const t = await buy();
    const c = await w.app.selectFrom('trade_collection').selectAll().where('trade_id', '=', t.tradeId).executeTakeFirstOrThrow();
    expect(c.inr_account_id).toBe(w.inrAccountId);
    expect(c.reference).toMatch(/^P[0-9A-HJKMNP-TV-Z]{7}$/);
    const window = c.pay_by.getTime() - c.created_at.getTime();
    expect(window).toBe(30 * 60_000);

    const view = await portalTrade(w.app, w.clientId, t.tradeRef, { protector: w.deps.protector });
    expect(view.payment?.instructions).toMatchObject({ reference: c.reference, bankName: 'ICICI Bank', ifsc: 'ICIC0001234', beneficiaryName: 'INRP2P Settlement Private Limited', upiLink: null });
    expect(view.payment?.instructions?.accountNumber).toMatch(/^\d{9}$/);
    expect(view.payment?.fromAccounts).toEqual([expect.objectContaining({ id: w.bankAccountId, holderName: 'Acme Pay Private Limited', last4: '8219' })]);
    expect(view.payment?.due).toBe(await due(t.tradeId));
    expect(view.payment?.canClaim).toBe(true);
    // The instructions are the trade's for good (IX117 and append-only).
    await expect(w.t.owner.updateTable('trade_collection').set({ reference: 'P0000000' }).where('trade_id', '=', t.tradeId).execute()).rejects.toMatchObject({ code: 'IX001' });
  });

  it('offers a UPI code with the exact amount and the reference, up to UPI’s limit', async () => {
    await runAs(w.app, setInrAccountCollectionDetails(w.finance.actor), w.finance.ref, 'inr_account.set_collection_details', { accountId: w.inrAccountId, upiVpa: 'INRP2P.Collect@icici', beneficiaryName: 'INRP2P Exchange' });
    const small = await buy('500');
    const view = await portalTrade(w.app, w.clientId, small.tradeRef, { protector: w.deps.protector });
    const amount = Number(await due(small.tradeId)).toFixed(2);
    expect(view.payment?.instructions?.upiId).toBe('inrp2p.collect@icici');
    expect(view.payment?.instructions?.upiLink).toBe(`upi://pay?pa=inrp2p.collect%40icici&pn=INRP2P%20Exchange&am=${amount}&cu=INR&tn=INRP2P%20${view.payment!.instructions!.reference}`);
    const large = await buy('100000');
    expect((await portalTrade(w.app, w.clientId, large.tradeRef, { protector: w.deps.protector })).payment?.instructions?.upiLink).toBeNull();
  });
});

describe('the client says it paid; the desk counts it only once it saw who sent it', () => {
  it('files the payment from the client’s own account, and refuses to confirm until the sender is the account holder', async () => {
    const t = await buy();
    const utr = imps();
    const filed = await claim(t.tradeRef, { utr });
    const leg = await legOf(filed.legRef);
    expect(leg.status).toBe('PROCESSING');
    const f = await w.app.selectFrom('fiat_transfer').select(['payer_bank_account_id', 'filed_by', 'utr']).where('id', '=', filed.transferId).executeTakeFirstOrThrow();
    expect(f).toEqual({ payer_bank_account_id: w.bankAccountId, filed_by: 'CLIENT', utr });
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', t.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('FIRST_LEG_DETECTED');

    await expect(confirm(leg.id)).rejects.toMatchObject({ code: 'INR_SENDER_NOT_VERIFIED' });
    expect(await check(filed.transferId, 'Acme Pay Pvt. Ltd.')).toMatchObject({ verdict: 'MATCH', exceptionId: null });
    await confirm(leg.id);
    expect((await legOf(filed.legRef)).status).toBe('COMPLETED');
    const view = await portalTrade(w.app, w.clientId, t.tradeRef, { protector: w.deps.protector });
    expect(view.payment?.payments).toEqual([expect.objectContaining({ ref: filed.legRef, state: 'CONFIRMED', filedBy: 'CLIENT', from: { bankName: 'HDFC Bank', last4: '8219' } })]);
  });

  it('never counts rupees from someone else — not by a click, not by the database', async () => {
    const t = await buy();
    const filed = await claim(t.tradeRef);
    const leg = await legOf(filed.legRef);
    const out = await check(filed.transferId, 'SURESH KUMAR SHARMA', 'XXXXXX4321');
    expect(out.verdict).toBe('MISMATCH');
    const cases = await w.app.selectFrom('exception_case').select(['type', 'severity', 'status']).where('subject_id', '=', filed.transferId).execute();
    expect(cases).toEqual([{ type: 'INR_UNEXPECTED_SENDER', severity: 'BLOCKING', status: 'OPEN' }]);
    expect((await w.app.selectFrom('trade').select('hold').where('id', '=', t.tradeId).executeTakeFirstOrThrow()).hold).toBe(true);
    const told = await w.app.selectFrom('outbox_event').select('type').where('aggregate_id', '=', t.tradeId).where('type', '=', 'client.payment_third_party').execute();
    expect(told).toHaveLength(1);
    const view = await portalTrade(w.app, w.clientId, t.tradeRef, { protector: w.deps.protector });
    expect(view.payment?.payments[0]?.state).toBe('RETURNING');

    await expect(confirm(leg.id)).rejects.toMatchObject({ code: 'INR_SENDER_NOT_VERIFIED' });
    await expect(runAs(w.app, acceptIncomingSender(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.accept_sender', { transferId: filed.transferId, reason: 'client says it is their cousin' }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // The database refuses the same thing by hand.
    const raw = await w.app.updateTable('fiat_transfer').set({ status: 'CONFIRMED', confirmed_at: new Date() }).where('id', '=', filed.transferId).execute().catch((e: unknown) => e);
    expect(pgErrorCode(raw)).toBe('IX116');
    const accept = await w.app
      .insertInto('fiat_sender_check')
      .values({ fiat_transfer_id: filed.transferId, via: 'DESK', verdict: 'ACCEPTED', reason: 'raw insert', checked_by: 'test' })
      .execute()
      .catch((e: unknown) => e);
    expect(pgErrorCode(accept)).toBe('IX119');
  });

  it('lets a person accept a partial match as the client’s own, with the reason — and only a partial one', async () => {
    const t = await buy();
    const filed = await claim(t.tradeRef);
    const leg = await legOf(filed.legRef);
    expect((await check(filed.transferId, 'ACME')).verdict).toBe('PARTIAL');
    await expect(confirm(leg.id)).rejects.toMatchObject({ code: 'INR_SENDER_NOT_VERIFIED' });
    await runAs(w.app, acceptIncomingSender(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.accept_sender', { transferId: filed.transferId, reason: 'account ••8219 on the credit is the client’s HDFC account' });
    await confirm(leg.id);
    expect((await legOf(filed.legRef)).status).toBe('COMPLETED');
    // Once counted, the sender is no longer decided by hand.
    await expect(check(filed.transferId, HOLDER)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('refuses a payment from another client’s account, a malformed reference, or more than is due', async () => {
    const t = await buy();
    const stranger = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: 'Someone Else', displayName: 'Someone Else', type: 'INDIVIDUAL' as const });
    const other = await runAs(w.app, addBankAccount(w.owner.actor, testFieldProtector()), w.owner.ref, 'client_bank.add', {
      clientId: stranger.clientId, holderName: 'Someone Else', bankName: 'SBI', ifsc: 'SBIN0001234', accountNumber: String(randomInt(1e9, 1e10)), railPreferences: ['IMPS'] as const,
    });
    await expect(claim(t.tradeRef, { from: other.bankAccountId })).rejects.toMatchObject({ code: 'NOT_OWN_ACCOUNT' });
    await expect(claim(t.tradeRef, { utr: 'HDFCN52026101612' })).rejects.toMatchObject({ code: 'INVALID_UTR' });
    await expect(claim(t.tradeRef, { rail: 'NEFT', utr: imps() })).rejects.toMatchObject({ code: 'INVALID_UTR' });
    const tooMuch = Money.parse(await due(t.tradeId), 'INR').add(Money.parse('1.00', 'INR')).toDecimalString();
    await expect(claim(t.tradeRef, { amount: tooMuch })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    // A second payment of the rest while the first is being checked (IMPS caps a transfer); then nothing more is due.
    const half = Money.parse(await due(t.tradeId), 'INR');
    const first = Money.ofMinor(half.minor / 2n, 'INR');
    await claim(t.tradeRef, { amount: first.toDecimalString() });
    await claim(t.tradeRef);
    await expect(claim(t.tradeRef)).rejects.toMatchObject({ code: 'NOTHING_OWED' });
  });
});

describe('the bank statement says who sent it', () => {
  const importLines = (lines: { reference: string; amount: string; description: string }[]) =>
    runAs(w.app, importBankStatement(w.finance.actor), w.finance.ref, 'statement.import', {
      inrAccountId: w.inrAccountId, periodFrom: '2026-01-01', periodTo: '2030-12-31', filename: `stmt-${randomInt(1e9)}.csv`, sha256: randomInt(1e9).toString(16).padStart(64, 'a'),
      lines: lines.map((l) => ({ valueDate: new Date().toISOString().slice(0, 10), direction: 'CREDIT' as const, ...l })),
    });

  it('checks the sender of every credit it matches: the client’s own counts, a stranger opens a case', async () => {
    const mine = await buy();
    const theirs = await buy();
    const a = await runAs(w.app, recordIncomingFiat(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.record', { tradeId: mine.tradeId, rail: 'IMPS' as const, utr: imps(), amount: await due(mine.tradeId), inrAccountId: w.inrAccountId });
    const b = await claim(theirs.tradeRef);
    const utrA = (await w.app.selectFrom('fiat_transfer').select('utr').where('id', '=', a.transferId).executeTakeFirstOrThrow()).utr;
    const utrB = (await w.app.selectFrom('fiat_transfer').select('utr').where('id', '=', b.transferId).executeTakeFirstOrThrow()).utr;
    const out = await importLines([
      { reference: utrA, amount: await due(mine.tradeId), description: `IMPS/P2A/${utrA}/ACME PAY PVT LTD/HDFC0001234` },
      { reference: utrB, amount: await due(theirs.tradeId), description: `UPI/${utrB}/PRIYA SINGH/priya.singh@okaxis/Payment` },
    ]);
    expect(out).toMatchObject({ matched: 2, sendersChecked: 2, strangers: 1 });
    await confirm(a.legId);
    const stranger = await w.app.selectFrom('fiat_sender_check').select(['via', 'verdict', 'seen_name', 'seen_account']).where('fiat_transfer_id', '=', b.transferId).executeTakeFirstOrThrow();
    expect(stranger).toEqual({ via: 'STATEMENT', verdict: 'MISMATCH', seen_name: 'PRIYA SINGH', seen_account: 'priya.singh@okaxis' });
    // A person cannot outvote what the statement showed.
    await check(b.transferId, HOLDER);
    await expect(confirm((await legOf(b.legRef)).id)).rejects.toMatchObject({ code: 'INR_SENDER_NOT_VERIFIED' });
  });

  it('does not undo a person’s full match with a statement that shows less', async () => {
    const t = await buy();
    const filed = await claim(t.tradeRef);
    await check(filed.transferId, 'ACME PAY PRIVATE LIMITED', 'XXXXXXXXXX8219');
    const utr = (await w.app.selectFrom('fiat_transfer').select('utr').where('id', '=', filed.transferId).executeTakeFirstOrThrow()).utr;
    await importLines([{ reference: utr, amount: await due(t.tradeId), description: `IMPS/${utr}/ACME/HDFC0001234` }]);
    const verdict = await sql<{ v: string }>`select inrp2p_fiat_sender_verdict(${filed.transferId}::uuid) as v`.execute(w.app);
    expect(verdict.rows[0]!.v).toBe('MATCH');
    await confirm((await legOf(filed.legRef)).id);
  });
});

describe('the payment window', () => {
  it('cancels a BUY its client neither paid nor said so in time — and never one with a payment filed', async () => {
    const unpaid = await buy();
    const paid = await buy();
    await claim(paid.tradeRef);
    const late = await w.t.pinnedClock();
    await late.set(new Date(Date.now() + 31 * 60_000));
    const out = await expireUnpaidTrades(late.db);
    expect(out.failures).toEqual([]);
    expect(out.cancelled).toBeGreaterThanOrEqual(1);
    const states = await w.app.selectFrom('trade').select(['id', 'lifecycle_state']).where('id', 'in', [unpaid.tradeId, paid.tradeId]).execute();
    expect(Object.fromEntries(states.map((s) => [s.id, s.lifecycle_state]))).toEqual({ [unpaid.tradeId]: 'CANCELLED', [paid.tradeId]: 'FIRST_LEG_DETECTED' });
    const told = await w.app.selectFrom('outbox_event').select('payload').where('aggregate_id', '=', unpaid.tradeId).where('type', '=', 'client.trade_cancelled').executeTakeFirstOrThrow();
    expect(told.payload).toMatchObject({ reason: 'not paid within the payment window', expiredUnpaid: true });
    await expect(claim(unpaid.tradeRef)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});
