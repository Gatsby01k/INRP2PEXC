import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { testFieldProtector } from '@inrp2p/adapters/testing';
import type { ClientActor } from '@inrp2p/identity';
import { createTestClientLogin, createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import {
  addBankAccount, addContact, addWallet, archiveBankAccount, archiveContact, archiveWallet, createClient, isActiveBankAccountOfClient,
  linkClientUser, listAuthorizedAcceptors, listBankAccounts, revealBankAccount, setCanAcceptQuotes, setClientStatus, setClientUserStatus, updateClient,
} from '../src/index.ts';

let t: TestDatabase;
let owner: TestOperator;
let dealer: TestOperator;
let support: TestOperator;
let settlement: TestOperator;
let staleOwner: TestOperator;
const protector = testFieldProtector();

beforeAll(async () => {
  t = await createTestDatabase('clients');
  owner = await createTestOperator(t.owner, ['OWNER']);
  dealer = await createTestOperator(t.owner, ['DEALER']);
  support = await createTestOperator(t.owner, ['SUPPORT']);
  settlement = await createTestOperator(t.owner, ['SETTLEMENT_OPERATOR']);
  staleOwner = await createTestOperator(t.owner, ['OWNER'], 'stale');
});
afterAll(async () => t.close());

async function newClient(name = 'Acme Pay') {
  return runAs(t.app, createClient(dealer.actor), dealer.ref, 'client.create', { legalName: `${name} Private Limited`, displayName: name, type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const, typicalSizeUsdt: '100000' });
}

const bank = (clientId: string, accountNumber = '50100123458219') => ({ clientId, holderName: 'Acme Pay Private Limited', bankName: 'HDFC Bank', ifsc: 'hdfc0001234', accountNumber, railPreferences: ['IMPS', 'NEFT'] as const });

async function audits(entityId: string) {
  return t.app.selectFrom('audit_event').select(['action', 'actor_id', 'before', 'after']).where('entity_id', '=', entityId).orderBy('seq').execute();
}

describe('clients', () => {
  it('creates a client with a generated reference and audits it; SETTLEMENT_OPERATOR cannot', async () => {
    const c = await newClient();
    expect(c.ref).toMatch(/^CL-\d{4,}$/);
    expect((await audits(c.clientId)).map((a) => a.action)).toEqual(['client.created']);
    await expect(runAs(t.app, createClient(settlement.actor), settlement.ref, 'client.create', { legalName: 'X', displayName: 'X', type: 'COMPANY' as const })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('updates with optimistic version and rejects stale writers', async () => {
    const c = await newClient('Versioned');
    const r = await runAs(t.app, updateClient(dealer.actor), dealer.ref, 'client.update', { clientId: c.clientId, expectedVersion: 1, displayName: 'Versioned Pay', pricingNotes: 'prefers 2dp' });
    expect(r.version).toBe(2);
    await expect(runAs(t.app, updateClient(dealer.actor), dealer.ref, 'client.update', { clientId: c.clientId, expectedVersion: 1, displayName: 'Lost update' })).rejects.toMatchObject({ code: 'STALE_VERSION' });
  });

  it('the database refuses changing a client reference or type directly', async () => {
    const c = await newClient('Immutable');
    await expect(sql`update client set ref = 'CL-9999' where id = ${c.clientId}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX041');
    await expect(sql`delete from client where id = ${c.clientId}`.execute(t.app)).rejects.toThrow(/permission denied/);
  });

  it('a suspended client cannot receive new destinations', async () => {
    const c = await newClient('Suspended');
    await runAs(t.app, setClientStatus(dealer.actor), dealer.ref, 'client.set_status', { clientId: c.clientId, status: 'SUSPENDED' as const, reason: 'review' });
    await expect(runAs(t.app, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', bank(c.clientId))).rejects.toMatchObject({ code: 'CLIENT_NOT_ACTIVE' });
  });
});

describe('bank accounts (archive-not-edit, encryption, audit)', () => {
  it('stores the account number only encrypted, with last4 and HMAC; reveal is step-up gated and audited', async () => {
    const c = await newClient('Encrypted');
    const added = await runAs(t.app, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', bank(c.clientId));
    expect(added.last4).toBe('8219');
    const row = await t.owner.selectFrom('bank_account').selectAll().where('id', '=', added.bankAccountId).executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain('50100123458219');
    expect(row.ifsc).toBe('HDFC0001234');
    expect(row.account_number_enc).toMatch(/^v1\./);

    const auditRows = await t.owner.selectFrom('audit_event').select(['before', 'after']).where('entity_id', '=', added.bankAccountId).execute();
    expect(JSON.stringify(auditRows)).not.toContain('50100123458219');
    const idem = await t.owner.selectFrom('idempotency_key').select('response').where('scope', '=', 'client_bank.add').execute();
    expect(JSON.stringify(idem)).not.toContain('50100123458219');

    await expect(runAs(t.app, revealBankAccount(staleOwner.actor, protector), staleOwner.ref, 'bank_account.reveal', { bankAccountId: added.bankAccountId, purpose: 'payout' }, null)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(runAs(t.app, revealBankAccount(dealer.actor, protector), dealer.ref, 'bank_account.reveal', { bankAccountId: added.bankAccountId, purpose: 'payout' }, null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runAs(t.app, revealBankAccount(owner.actor, protector), owner.ref, 'bank_account.reveal', { bankAccountId: added.bankAccountId, purpose: 'payout' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const revealed = await runAs(t.app, revealBankAccount(settlement.actor, protector), settlement.ref, 'bank_account.reveal', { bankAccountId: added.bankAccountId, purpose: 'payout IX-1' }, null);
    expect(revealed.accountNumber).toBe('50100123458219');
    const actions = (await audits(added.bankAccountId)).map((a) => a.action);
    expect(actions).toEqual(['client_bank.added', 'bank_account.revealed']);
  });

  it('rejects the same active account twice for a client; archive then re-add works and both changes are audited (exit criterion)', async () => {
    const c = await newClient('Changes');
    const first = await runAs(t.app, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', bank(c.clientId));
    await expect(runAs(t.app, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', bank(c.clientId, '5010 0123 4582 19'))).rejects.toMatchObject({ code: 'DUPLICATE_DESTINATION' });
    await runAs(t.app, archiveBankAccount(owner.actor), owner.ref, 'client_bank.archive', { bankAccountId: first.bankAccountId, reason: 'client changed bank' });
    const second = await runAs(t.app, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', bank(c.clientId, '000405001234'));
    expect(second.bankAccountId).not.toBe(first.bankAccountId);
    await expect(runAs(t.app, archiveBankAccount(owner.actor), owner.ref, 'client_bank.archive', { bankAccountId: first.bankAccountId, reason: 'again' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    const trail = await t.app.selectFrom('audit_event').select(['action', 'entity_id', 'actor_id', 'after']).where('entity_type', '=', 'bank_account').where('entity_id', 'in', [first.bankAccountId, second.bankAccountId]).orderBy('seq').execute();
    expect(trail.map((a) => [a.action, a.entity_id])).toEqual([
      ['client_bank.added', first.bankAccountId],
      ['client_bank.archived', first.bankAccountId],
      ['client_bank.added', second.bankAccountId],
    ]);
    expect(trail.every((a) => a.actor_id === owner.actor.userId)).toBe(true);
    const outbox = await t.app.selectFrom('outbox_event').select(['type']).where('aggregate_id', '=', c.clientId).orderBy('created_at').execute();
    expect(outbox.map((o) => o.type)).toEqual(['client.destination_added', 'client.destination_archived', 'client.destination_added']);
    expect((await listBankAccounts(t.app, c.clientId)).map((b) => b.last4)).toEqual(['1234']);
    expect(await isActiveBankAccountOfClient(t.app, c.clientId, first.bankAccountId)).toBe(false);
  });

  it('bank details are never edited in place, even with direct SQL', async () => {
    const c = await newClient('NoEdit');
    const b = await runAs(t.app, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', bank(c.clientId));
    await expect(sql`update bank_account set ifsc = 'ICIC0000001' where id = ${b.bankAccountId}`.execute(t.app)).rejects.toThrow(/permission denied/);
    await expect(sql`update bank_account set ifsc = 'ICIC0000001' where id = ${b.bankAccountId}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX041');
    await sql`update bank_account set status = 'ARCHIVED', archived_by = 'x', archived_at = now() where id = ${b.bankAccountId}`.execute(t.app);
    await expect(sql`update bank_account set status = 'ACTIVE', archived_by = null, archived_at = null where id = ${b.bankAccountId}`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX040');
  });

  it('client admins manage destinations only for their own client and only with fresh TOTP; traders cannot', async () => {
    const c = await newClient('ClientSide');
    const other = await newClient('OtherCo');
    const adminLogin = await createTestClientLogin(t.owner, { stepUp: 'fresh' });
    const noTotpLogin = await createTestClientLogin(t.owner);
    const traderLogin = await createTestClientLogin(t.owner, { stepUp: 'fresh' });
    await runAs(t.app, linkClientUser(dealer.actor), dealer.ref, 'client_user.link', { clientId: c.clientId, userId: adminLogin.userId, role: 'CLIENT_ADMIN' as const });
    await runAs(t.app, linkClientUser(dealer.actor), dealer.ref, 'client_user.link', { clientId: c.clientId, userId: noTotpLogin.userId, role: 'CLIENT_ADMIN' as const });
    await runAs(t.app, linkClientUser(dealer.actor), dealer.ref, 'client_user.link', { clientId: c.clientId, userId: traderLogin.userId, role: 'CLIENT_TRADER' as const });
    const asClient = (l: typeof adminLogin): ClientActor => ({ kind: 'CLIENT', userId: l.userId, sessionId: l.sessionId });

    const added = await runAs(t.app, addBankAccount(asClient(adminLogin), protector), adminLogin.ref, 'client_bank.add', bank(c.clientId));
    expect((await audits(added.bankAccountId))[0]).toMatchObject({ action: 'client_bank.added', actor_id: adminLogin.userId });
    await expect(runAs(t.app, addBankAccount(asClient(adminLogin), protector), adminLogin.ref, 'client_bank.add', bank(other.clientId))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runAs(t.app, addBankAccount(asClient(noTotpLogin), protector), noTotpLogin.ref, 'client_bank.add', bank(c.clientId, '123456789012'))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(runAs(t.app, addBankAccount(asClient(traderLogin), protector), traderLogin.ref, 'client_bank.add', bank(c.clientId, '123456789012'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A client actor presented on the operator surface is refused.
    await expect(runAs(t.app, addBankAccount(asClient(adminLogin), protector), { ...adminLogin.ref, surface: 'OPERATOR' }, 'client_bank.add', bank(c.clientId, '123456789012'))).rejects.toMatchObject({ code: 'SESSION_SURFACE_MISMATCH' });
    // SUPPORT may add on behalf with step-up per matrix; DEALER may not.
    await expect(runAs(t.app, addBankAccount(dealer.actor, protector), dealer.ref, 'client_bank.add', bank(c.clientId, '123456789012'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runAs(t.app, addBankAccount(support.actor, protector), support.ref, 'client_bank.add', bank(c.clientId, '123456789012'))).resolves.toMatchObject({ last4: '9012' });
  });
});

describe('client wallets', () => {
  it('validates TRON checksums, enforces uniqueness among active wallets and audits add/archive', async () => {
    const c = await newClient('Wallets');
    const address = encodeTronAddress(randomBytes(20));
    const w = await runAs(t.app, addWallet(owner.actor), owner.ref, 'client_wallet.add', { clientId: c.clientId, network: 'TRON' as const, address, label: 'Treasury hot', purpose: 'SOURCE' as const });
    await expect(runAs(t.app, addWallet(owner.actor), owner.ref, 'client_wallet.add', { clientId: c.clientId, network: 'TRON' as const, address, label: 'Again', purpose: 'BOTH' as const })).rejects.toMatchObject({ code: 'DUPLICATE_DESTINATION' });
    const typo = address.slice(0, -1) + (address.endsWith('a') ? 'b' : 'a');
    await expect(runAs(t.app, addWallet(owner.actor), owner.ref, 'client_wallet.add', { clientId: c.clientId, network: 'TRON' as const, address: typo, label: 'Typo', purpose: 'SOURCE' as const })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await runAs(t.app, archiveWallet(owner.actor), owner.ref, 'client_wallet.archive', { walletId: w.walletId, reason: 'rotated' });
    expect((await audits(w.walletId)).map((a) => a.action)).toEqual(['client_wallet.added', 'client_wallet.archived']);
  });
});

describe('client users and quote-acceptance rights', () => {
  it('links only CLIENT users, starts without acceptance rights, grants need step-up and are audited', async () => {
    const c = await newClient('Acceptors');
    const login = await createTestClientLogin(t.owner);
    const unverified = await createTestClientLogin(t.owner, { emailVerified: false });
    const cu = await runAs(t.app, linkClientUser(dealer.actor), dealer.ref, 'client_user.link', { clientId: c.clientId, userId: login.userId, role: 'CLIENT_TRADER' as const });
    const cu2 = await runAs(t.app, linkClientUser(dealer.actor), dealer.ref, 'client_user.link', { clientId: c.clientId, userId: unverified.userId, role: 'CLIENT_TRADER' as const });
    await expect(runAs(t.app, linkClientUser(dealer.actor), dealer.ref, 'client_user.link', { clientId: c.clientId, userId: owner.actor.userId, role: 'CLIENT_ADMIN' as const })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await listAuthorizedAcceptors(t.app, c.clientId)).toEqual([]);

    await expect(runAs(t.app, setCanAcceptQuotes(dealer.actor), dealer.ref, 'client_user.set_accept_quotes', { clientUserId: cu.clientUserId, canAcceptQuotes: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runAs(t.app, setCanAcceptQuotes(staleOwner.actor), staleOwner.ref, 'client_user.set_accept_quotes', { clientUserId: cu.clientUserId, canAcceptQuotes: true })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await runAs(t.app, setCanAcceptQuotes(support.actor), support.ref, 'client_user.set_accept_quotes', { clientUserId: cu.clientUserId, canAcceptQuotes: true });
    await runAs(t.app, setCanAcceptQuotes(support.actor), support.ref, 'client_user.set_accept_quotes', { clientUserId: cu2.clientUserId, canAcceptQuotes: true });

    const acceptors = await listAuthorizedAcceptors(t.app, c.clientId);
    expect(acceptors).toHaveLength(1);
    expect(acceptors[0]!.clientUserId).toBe(cu.clientUserId);
    expect(acceptors[0]!.maskedEmail).toMatch(/^c•••@acmepay\.test$/);

    expect((await audits(cu.clientUserId)).map((a) => [a.action, a.after])).toEqual([
      ['client_user.linked', expect.anything()],
      ['client_user.accept_permission_changed', expect.objectContaining({ can_accept_quotes: true, changed_via: 'OPERATOR' })],
    ]);

    await runAs(t.app, setClientUserStatus(dealer.actor), dealer.ref, 'client_user.set_status', { clientUserId: cu.clientUserId, status: 'DISABLED' as const, reason: 'left company' });
    expect(await listAuthorizedAcceptors(t.app, c.clientId)).toEqual([]);
    const row = await t.app.selectFrom('client_user').select(['can_accept_quotes', 'status']).where('id', '=', cu.clientUserId).executeTakeFirstOrThrow();
    expect(row).toEqual({ can_accept_quotes: false, status: 'DISABLED' });
    await expect(runAs(t.app, setCanAcceptQuotes(support.actor), support.ref, 'client_user.set_accept_quotes', { clientUserId: cu.clientUserId, canAcceptQuotes: true })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('the database refuses linking an operator user as a client user', async () => {
    const c = await newClient('KindCheck');
    await expect(t.owner.insertInto('client_user').values({ client_id: c.clientId, user_id: owner.actor.userId, role: 'CLIENT_ADMIN', created_by: 'x' }).execute()).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX022');
  });
});

describe('contacts', () => {
  it('encrypts phone numbers, keeps one primary contact and audits changes', async () => {
    const c = await newClient('Contacts');
    const a = await runAs(t.app, addContact(support.actor, protector), support.ref, 'client_contact.add', { clientId: c.clientId, name: 'Priya', email: 'Priya@AcmePay.in', phone: '+91 98765 43210', telegramHandle: '@priya_acme', isPrimary: true });
    const b = await runAs(t.app, addContact(support.actor, protector), support.ref, 'client_contact.add', { clientId: c.clientId, name: 'Ravi', whatsapp: '+919812345678', isPrimary: true });
    const rows = await t.owner.selectFrom('client_contact').selectAll().where('client_id', '=', c.clientId).orderBy('created_at').execute();
    expect(JSON.stringify(rows)).not.toContain('9876543210');
    expect(rows.map((r) => [r.name, r.is_primary, r.phone_last4, r.whatsapp_last4, r.email])).toEqual([
      ['Priya', false, '3210', null, 'priya@acmepay.in'],
      ['Ravi', true, null, '5678', null],
    ]);
    expect(await protector.open(rows[0]!.phone_enc!, `client_contact.phone:${c.clientId}`)).toBe('+919876543210');
    await runAs(t.app, archiveContact(support.actor), support.ref, 'client_contact.archive', { contactId: b.contactId });
    expect((await audits(a.contactId)).map((x) => x.action)).toEqual(['client_contact.added']);
    expect((await audits(b.contactId)).map((x) => x.action)).toEqual(['client_contact.added', 'client_contact.archived']);
    const contactAudit = await t.owner.selectFrom('audit_event').select('after').where('entity_id', '=', a.contactId).executeTakeFirstOrThrow();
    expect(JSON.stringify(contactAudit)).not.toContain('priya@acmepay.in');
    expect(randomUUID()).toBeTruthy();
  });
});
