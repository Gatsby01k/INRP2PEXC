import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import {
  AwsKmsKeyEncryptionKey, LocalKeyEncryptionKey, createFieldProtector, sealedParts,
} from '@inrp2p/adapters';
import { fakeKms } from '@inrp2p/adapters/testing';
import { createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import { addBankAccount, addContact, createClient, revealBankAccount } from '@inrp2p/clients';
import { type ResealKeys, reseal, resealKeysFromEnv } from '../../scripts/reseal-fields.ts';

/**
 * Production's move from the locally held `prod-v1` to AWS KMS (owner direction 2026-10-11, migration 0036): the two
 * clients' bank accounts must survive it exactly — same account number, same lookup HMAC — and a run that stops
 * half-way must continue, never repeat or lose a row.
 */
let t: TestDatabase;
let owner: TestOperator;
let settlement: TestOperator;
const hmacKey = randomBytes(32);
const prodV1 = new LocalKeyEncryptionKey('prod-v1', randomBytes(32));
const before = createFieldProtector({ kek: prodV1, hmacKey });
const ARN = 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';

/** One KMS for the whole file (its master key must outlive a run), which can go away after a given call and come back. */
const kms = fakeKms({ arns: [ARN] });
let kmsDownFrom: number | null = null;
let kmsCalls = 0;
const kmsFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (kmsDownFrom !== null && ++kmsCalls > kmsDownFrom) return new Response(JSON.stringify({ __type: 'KMSInternalException' }), { status: 500 });
  return kms.fetchImpl(url, init);
}) as typeof fetch;
const target = new AwsKmsKeyEncryptionKey({
  keyId: 'kms-2026a', keyArn: ARN, credentials: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't' }),
  fetchImpl: kmsFetch, endpoint: 'https://kms.test/', retries: 1, retryBaseDelayMs: 1,
});
const keys: ResealKeys = { target, sources: [prodV1], hmacKey };
const after = createFieldProtector({ kek: target, hmacKey }); // what the release runs with: KMS alone

const accounts: { id: string; number: string }[] = [];
let contactId: string;

beforeAll(async () => {
  t = await createTestDatabase('reseal');
  owner = await createTestOperator(t.owner, ['OWNER']);
  settlement = await createTestOperator(t.owner, ['SETTLEMENT_OPERATOR']);
  for (const [name, number] of [['Konkan Trade', '50100123458219'], ['Malabar Pay', '000405001234']] as const) {
    const c = await runAs(t.app, createClient(owner.actor), owner.ref, 'client.create', { legalName: `${name} Private Limited`, displayName: name, type: 'COMPANY' as const });
    const added = await runAs(t.app, addBankAccount(owner.actor, before), owner.ref, 'client_bank.add', {
      clientId: c.clientId, holderName: `${name} Private Limited`, bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: number, railPreferences: ['IMPS'] as const,
    });
    accounts.push({ id: added.bankAccountId, number });
    if (!contactId) {
      contactId = (await runAs(t.app, addContact(owner.actor, before), owner.ref, 'client_contact.add', { clientId: c.clientId, name: 'Asha', phone: '+91 98200 12345', whatsapp: '+91 98200 54321' })).contactId;
    }
  }
});
afterAll(async () => t.close());

const sealedOf = async (id: string) => (await t.owner.selectFrom('bank_account').select(['account_number_enc', 'account_hmac', 'client_id']).where('id', '=', id).executeTakeFirstOrThrow());

describe('moving sealed values from prod-v1 to KMS (0036)', () => {
  it('plan writes nothing, and finds a wrong lookup key before anything moves', async () => {
    const snapshot = await sealedOf(accounts[0]!.id);
    const plan = await reseal(t.owner, keys, 'plan');
    expect(plan.ok).toBe(true);
    expect(plan.fields.find((f) => f.field === 'bank_account.account_number_enc')!.byKey).toEqual({ 'prod-v1': 2 });
    expect(plan.fields.find((f) => f.field === 'client_contact.phone_enc')!.byKey).toEqual({ 'prod-v1': 1 });
    expect(plan.remaining).toBe(4);
    expect(await sealedOf(accounts[0]!.id)).toEqual(snapshot);

    const wrongHmac = await reseal(t.owner, { ...keys, hmacKey: randomBytes(32) }, 'plan');
    expect(wrongHmac.ok).toBe(false);
    expect(wrongHmac.fields.find((f) => f.field === 'bank_account.account_number_enc')!.failed.map((x) => x.reason)).toEqual([
      expect.stringContaining('lookup HMAC differs'), expect.stringContaining('lookup HMAC differs'),
    ]);
    // apply with the wrong lookup key moves nothing at all — not even the phone numbers, which have no HMAC to check.
    const refused = await reseal(t.owner, { ...keys, hmacKey: randomBytes(32) }, 'apply');
    expect(refused.ok).toBe(false);
    expect(refused.fields.reduce((s, f) => s + f.moved, 0)).toBe(0);
    expect((await reseal(t.owner, keys, 'plan')).remaining).toBe(4);
    expect((await sealedOf(accounts[0]!.id)).account_number_enc).toBe(snapshot.account_number_enc);
  });

  it('a run that stops half-way continues where it stopped: no row lost, none moved twice', async () => {
    const first = await reseal(t.owner, keys, 'apply', { limit: 1 });
    expect(first.fields.reduce((s, f) => s + f.moved, 0)).toBe(1);
    expect(first.remaining).toBe(3);
    expect(first.ok).toBe(false); // not finished

    // KMS answers the probe (wrap, unwrap) and then goes away in the middle of the moves: the rows it could not move
    // stay exactly as they were, under prod-v1, and the run says so.
    const untouched = await sealedOf(accounts[1]!.id);
    kmsCalls = 0;
    kmsDownFrom = 2;
    const outage = await reseal(t.owner, keys, 'apply');
    kmsDownFrom = null;
    expect(outage.ok).toBe(false);
    expect(outage.fields.reduce((s, f) => s + f.moved, 0)).toBe(0);
    expect(outage.fields.flatMap((f) => f.failed.map((x) => x.reason))).toEqual([
      expect.stringContaining('KMS did not answer'), expect.stringContaining('KMS did not answer'), expect.stringContaining('KMS did not answer'),
    ]);
    expect(outage.remaining).toBe(3);
    expect(await sealedOf(accounts[1]!.id)).toEqual(untouched);

    const rest = await reseal(t.owner, keys, 'apply');
    expect(rest.fields.reduce((s, f) => s + f.moved, 0)).toBe(3);
    expect(rest.remaining).toBe(0);
    expect(rest.ok).toBe(true);

    const again = await reseal(t.owner, keys, 'apply');
    expect(again.fields.reduce((s, f) => s + f.moved, 0)).toBe(0);
    const trail = await t.owner.selectFrom('audit_event').select(['entity_type', 'after']).where('action', '=', 'field.resealed').execute();
    expect(trail).toHaveLength(4);
    expect(JSON.stringify(trail)).not.toMatch(/50100123458219|000405001234|98200/);
  });

  it('keeps every account exactly: same ciphertext, same lookup HMAC, the same number through the application, KMS alone', async () => {
    for (const a of accounts) {
      const row = await sealedOf(a.id);
      const parts = sealedParts(row.account_number_enc);
      expect(parts.keyId).toBe('kms-2026a');
      expect(row.account_hmac).toBe(before.lookupHash(a.number, 'bank_account.account_number'));
      const revealed = await runAs(t.app, revealBankAccount(settlement.actor, after), settlement.ref, 'bank_account.reveal', { bankAccountId: a.id, purpose: 'reseal check' }, null);
      expect(revealed.accountNumber).toBe(a.number);
    }
    const verify = await reseal(t.owner, keys, 'verify');
    expect(verify.ok).toBe(true);
    // prod-v1 can no longer open anything: the old key can be retired.
    await expect(before.open((await sealedOf(accounts[0]!.id)).account_number_enc, 'x')).rejects.toThrow(/unknown key id kms-2026a/);
  });

  it('the database lets only the schema owner, in a declared re-seal, change only the key of a sealed value', async () => {
    const { account_number_enc: sealed, client_id } = await sealedOf(accounts[1]!.id);
    const p = sealedParts(sealed);
    const swapKey = `v1.other-key.${p.wrapped}.${p.iv}.${p.ciphertext}.${p.tag}`;
    const update = (db: typeof t.owner, value: string, flag: boolean, extra = sql``) => db.transaction().execute(async (tx) => {
      if (flag) await sql`set local inrp2p.reseal = 'on'`.execute(tx);
      await sql`update bank_account set account_number_enc = ${value} ${extra} where id = ${accounts[1]!.id}`.execute(tx);
    });
    const ix041 = (e: unknown) => pgErrorCode(e) === 'IX041';
    await expect(update(t.owner, swapKey, false)).rejects.toSatisfy(ix041); // not declared
    await expect(update(t.owner, `v1.other-key.${p.wrapped}.${p.iv}.${p.ciphertext.slice(1)}A.${p.tag}`, true)).rejects.toSatisfy(ix041); // the data changed
    await expect(update(t.owner, `v1.kms-2026a.${p.wrapped}A.${p.iv}.${p.ciphertext}.${p.tag}`, true)).rejects.toSatisfy(ix041); // same key id
    await expect(update(t.owner, swapKey, true, sql`, holder_name = 'Someone Else'`)).rejects.toSatisfy(ix041); // another column too
    // The application never re-seals: it may not write the column, and the database does not count it as a re-seal.
    await expect(update(t.app, swapKey, true)).rejects.toThrow(/permission denied/);
    const asApp = await t.app.transaction().execute(async (tx) => {
      await sql`set local inrp2p.reseal = 'on'`.execute(tx);
      return (await sql<{ ok: boolean }>`select inrp2p_is_reseal('bank_account'::regclass, ${JSON.stringify({ account_number_enc: sealed })}::jsonb, ${JSON.stringify({ account_number_enc: swapKey })}::jsonb) as ok`.execute(tx)).rows[0]!.ok;
    });
    expect(asApp).toBe(false);
    await expect(reseal(t.app, keys, 'plan')).rejects.toThrow(/schema owner/);
    expect((await sealedOf(accounts[1]!.id)).account_number_enc).toBe(sealed);
    expect(client_id).toBeTruthy();
  });

  it('takes its keys from the environment the way the release does, the old local key only as a source', () => {
    const env = {
      INRP2P_ENV: 'production', INRP2P_KEK_PROVIDER: 'aws-kms', INRP2P_KEK_ID: 'kms-2026a', INRP2P_KMS_KEY_ARN: ARN,
      INRP2P_FIELD_HMAC_BASE64: hmacKey.toString('base64'), AWS_ACCESS_KEY_ID: 'ASIA', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't',
      INRP2P_RESEAL_FROM: JSON.stringify([{ id: 'prod-v1', provider: 'local', base64: randomBytes(32).toString('base64') }]),
    };
    const k = resealKeysFromEnv(env);
    expect(k.target.keyId).toBe('kms-2026a');
    expect(k.sources.map((s) => s.keyId)).toEqual(['prod-v1']);
    // The target itself is never a locally held key in production.
    expect(() => resealKeysFromEnv({ ...env, INRP2P_KEK_PROVIDER: 'local', INRP2P_KEK_BASE64: randomBytes(32).toString('base64') })).toThrow(/not allowed in production/);
    expect(() => resealKeysFromEnv({ ...env, INRP2P_RESEAL_FROM: JSON.stringify([{ id: 'kms-2026a', provider: 'local', base64: 'x' }]) })).toThrow(/different from the target/);
  });
});
