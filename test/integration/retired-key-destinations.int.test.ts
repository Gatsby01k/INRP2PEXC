import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { AwsKmsKeyEncryptionKey, type FieldProtector, LocalKeyEncryptionKey, createFieldProtector } from '@inrp2p/adapters';
import { fakeKms } from '@inrp2p/adapters/testing';
import type { ClientActor } from '@inrp2p/identity';
import { createTestClientLogin, createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import { addBankAccount, archiveBankAccount, createClient, linkClientUser, listBankAccounts, revealBankAccount } from '@inrp2p/clients';
import { createRequest } from '@inrp2p/quotes';

/**
 * D-18, owner 2026-10-11: production's two bank accounts (CL-0003, CL-0004) hold random test details sealed under the
 * locally held `prod-v1`, which the release does not have. They are not moved to KMS: their clients archive them, the
 * ordinary way, once the release runs. Archiving needs no key; afterwards nothing pays them and nothing opens them —
 * the release never tries to decrypt a value it has no key for.
 */
let t: TestDatabase;
let dealer: TestOperator;
let settlement: TestOperator;
const hmacKey = randomBytes(32);
// What production sealed with, before this release.
const prodV1 = createFieldProtector({ kek: new LocalKeyEncryptionKey('prod-v1', randomBytes(32)), hmacKey });
// What the release runs with: KMS alone; every attempt to open a value is counted.
const kms = fakeKms();
const releaseKey = new AwsKmsKeyEncryptionKey({
  keyId: 'kms-2026a', keyArn: 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  credentials: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't' }), fetchImpl: kms.fetchImpl, endpoint: 'https://kms.test/',
});
const inner = createFieldProtector({ kek: releaseKey, hmacKey });
const opened: string[] = [];
const release: FieldProtector = { ...inner, open: async (sealed, context) => { opened.push(context); return inner.open(sealed, context); } };

let clientId: string;
let accountId: string;
let admin: Awaited<ReturnType<typeof createTestClientLogin>>;
const asClient = (l: typeof admin): ClientActor => ({ kind: 'CLIENT', userId: l.userId, sessionId: l.sessionId });

beforeAll(async () => {
  t = await createTestDatabase('retired_key');
  dealer = await createTestOperator(t.owner, ['DEALER']);
  settlement = await createTestOperator(t.owner, ['SETTLEMENT_OPERATOR']);
  clientId = (await runAs(t.app, createClient(dealer.actor), dealer.ref, 'client.create', { legalName: 'Test Trader Private Limited', displayName: 'Test Trader', type: 'COMPANY' as const })).clientId;
  admin = await createTestClientLogin(t.owner, { stepUp: 'fresh' });
  await runAs(t.app, linkClientUser(dealer.actor), dealer.ref, 'client_user.link', { clientId, userId: admin.userId, role: 'CLIENT_ADMIN' as const });
  // Production's state: an active account, sealed under prod-v1 by the release before this one.
  accountId = (await runAs(t.app, addBankAccount(asClient(admin), prodV1), admin.ref, 'client_bank.add', {
    clientId, holderName: 'Test Trader', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100999988887', railPreferences: ['IMPS'] as const,
  })).bankAccountId;
});
afterAll(async () => t.close());

const sellRequest = () => runAs(t.app, createRequest(dealer.actor, {}), dealer.ref, 'request.create', {
  clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: accountId,
});

describe('production’s test bank accounts under prod-v1, archived instead of moved (D-18)', () => {
  it('while still active, the release cannot open them: it fails closed, with no key to try', async () => {
    await expect(runAs(t.app, revealBankAccount(settlement.actor, release), settlement.ref, 'bank_account.reveal', { bankAccountId: accountId, purpose: 'payout check' }, null))
      .rejects.toThrow(/unknown key id prod-v1/);
    expect(kms.calls).toHaveLength(0); // no KMS call, no decryption attempted: the key is simply not in the release's ring
  });

  it('the client archives them the ordinary way — fresh TOTP, a reason, audited — and no key is needed for it', async () => {
    opened.length = 0;
    await runAs(t.app, archiveBankAccount(asClient(admin)), admin.ref, 'client_bank.archive', { bankAccountId: accountId, reason: 'Random test details added by the owner; never a real account (D-18)' });
    const row = await t.owner.selectFrom('bank_account').select(['status', 'archived_by', 'archive_reason', 'account_number_enc']).where('id', '=', accountId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'ARCHIVED', archived_by: expect.stringContaining(admin.userId), archive_reason: expect.stringContaining('test details') });
    expect(row.account_number_enc.split('.')[1]).toBe('prod-v1'); // left as it was: never moved, never opened
    const trail = await t.owner.selectFrom('audit_event').select(['action', 'actor_id', 'after']).where('entity_id', '=', accountId).orderBy('seq').execute();
    expect(trail.map((a) => a.action)).toEqual(['client_bank.added', 'client_bank.archived']);
    expect(trail[1]!.actor_id).toBe(admin.userId);
    expect(JSON.stringify(trail)).not.toContain('50100999988887');
    const event = await t.owner.selectFrom('outbox_event').select(['type', 'payload']).where('type', '=', 'client.destination_archived').executeTakeFirstOrThrow();
    expect(JSON.stringify(event.payload)).toContain('"last4":"8887"');
    expect(opened).toEqual([]);
  });

  it('once archived they are out of every payout, and nothing opens them', async () => {
    opened.length = 0;
    await expect(sellRequest()).rejects.toMatchObject({ code: 'DESTINATION_INVALID' });
    await expect(runAs(t.app, revealBankAccount(settlement.actor, release), settlement.ref, 'bank_account.reveal', { bankAccountId: accountId, purpose: 'payout check' }, null))
      .rejects.toMatchObject({ code: 'DESTINATION_INVALID', message: expect.stringContaining('archived') });
    expect(await listBankAccounts(t.app, clientId)).toEqual([]);
    expect((await listBankAccounts(t.app, clientId, { includeArchived: true })).map((b) => [b.status, b.last4])).toEqual([['ARCHIVED', '8887']]);
    expect(opened).toEqual([]);
    expect(kms.calls).toHaveLength(0);
  });

  it('the client adds a real account afterwards: sealed under KMS, and it is the one that pays', async () => {
    const fresh = await runAs(t.app, addBankAccount(asClient(admin), release), admin.ref, 'client_bank.add', {
      clientId, holderName: 'Test Trader', bankName: 'ICICI Bank', ifsc: 'ICIC0001234', accountNumber: '000405001234', railPreferences: ['IMPS'] as const,
    });
    const sealed = (await t.owner.selectFrom('bank_account').select('account_number_enc').where('id', '=', fresh.bankAccountId).executeTakeFirstOrThrow()).account_number_enc;
    expect(sealed.split('.')[1]).toBe('kms-2026a');
    const revealed = await runAs(t.app, revealBankAccount(settlement.actor, release), settlement.ref, 'bank_account.reveal', { bankAccountId: fresh.bankAccountId, purpose: 'payout check' }, null);
    expect(revealed.accountNumber).toBe('000405001234');
  });
});
