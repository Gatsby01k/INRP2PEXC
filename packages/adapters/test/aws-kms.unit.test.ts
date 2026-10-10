import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AwsKmsKeyEncryptionKey, awsCredentialsFromEnvironment, fieldProtectionFromEnv, signSigV4, sigV4SigningKey,
} from '../src/index.ts';

/**
 * TD-03: the KMS-backed key-encryption key. The signer is checked against AWS's published Signature Version 4
 * examples; the adapter against an in-memory KMS that, like the real one, binds each wrapped key to its encryption
 * context and key.
 */
const EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

describe('Signature Version 4', () => {
  it('derives the documented signing key', () => {
    // AWS General Reference, "Examples of how to derive a signing key for Signature Version 4".
    expect(sigV4SigningKey(EXAMPLE.secretAccessKey, '20120215', 'us-east-1', 'iam').toString('hex'))
      .toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d'); // secret-scan:allow
  });

  it('signs the test suite’s get-vanilla request to the documented signature', () => {
    const headers = signSigV4({
      method: 'GET', url: new URL('https://example.amazonaws.com/'), headers: {}, body: '', region: 'us-east-1', service: 'service',
      credentials: EXAMPLE, amzDate: '20150830T123600Z',
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', // secret-scan:allow
    );
  });

  it('signs the session token and sorted query parameters too', () => {
    const headers = signSigV4({
      method: 'POST', url: new URL('https://kms.ap-south-1.amazonaws.com/?b=2&a=1'), headers: { 'X-Amz-Target': 'TrentService.Encrypt' }, body: '{}',
      region: 'ap-south-1', service: 'kms', credentials: { ...EXAMPLE, sessionToken: 'token' }, amzDate: '20261005T120000Z',
    });
    expect(headers['x-amz-security-token']).toBe('token');
    expect(headers.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token;x-amz-target');
  });
});

const ARN_A = 'arn:aws:kms:ap-south-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const ARN_B = 'arn:aws:kms:ap-south-1:111122223333:key/5678abcd-12ab-34cd-56ef-1234567890ab';

/** An in-memory KMS: one master key per ARN; a ciphertext names its key and is bound to its encryption context. */
function fakeKms(opts: { failFirst?: number; failWith?: { status: number; type: string }; deny?: boolean } = {}) {
  const masters = new Map([ARN_A, ARN_B].map((arn) => [arn, randomBytes(32)]));
  const calls: { target: string; signed: boolean; body: Record<string, unknown> }[] = [];
  let failures = opts.failFirst ?? 0;
  const ctxHash = (ctx: unknown) => createHash('sha256').update(JSON.stringify(ctx)).digest();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const target = headers.get('x-amz-target') ?? '';
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ target, signed: (headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256 Credential='), body });
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
    if (failures > 0) {
      failures--;
      return reply(opts.failWith?.status ?? 500, { __type: opts.failWith?.type ?? 'KMSInternalException' });
    }
    if (opts.deny) return reply(400, { __type: 'com.amazonaws.kms#AccessDeniedException' });
    const master = masters.get(String(body.KeyId));
    if (!master) return reply(400, { __type: 'NotFoundException' });
    if (target === 'TrentService.Encrypt') {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', master, iv);
      c.setAAD(ctxHash(body.EncryptionContext));
      const ct = Buffer.concat([c.update(Buffer.from(String(body.Plaintext), 'base64')), c.final()]);
      const blob = Buffer.concat([Buffer.from(String(body.KeyId).padEnd(100)), iv, c.getAuthTag(), ct]);
      return reply(200, { CiphertextBlob: blob.toString('base64'), KeyId: body.KeyId });
    }
    const blob = Buffer.from(String(body.CiphertextBlob), 'base64');
    if (blob.subarray(0, 100).toString().trim() !== body.KeyId) return reply(400, { __type: 'IncorrectKeyException' });
    try {
      const d = createDecipheriv('aes-256-gcm', master, blob.subarray(100, 112));
      d.setAAD(ctxHash(body.EncryptionContext));
      d.setAuthTag(blob.subarray(112, 128));
      const pt = Buffer.concat([d.update(blob.subarray(128)), d.final()]);
      return reply(200, { Plaintext: pt.toString('base64'), KeyId: body.KeyId });
    } catch {
      return reply(400, { __type: 'InvalidCiphertextException' });
    }
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const credentials = async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'session' });
const kms = (fetchImpl: typeof fetch, arn = ARN_A, keyId = 'kms-a') =>
  new AwsKmsKeyEncryptionKey({ keyId, keyArn: arn, credentials, fetchImpl, endpoint: 'https://kms.test/', retryBaseDelayMs: 1 });

describe('AWS KMS key-encryption key', () => {
  it('wraps and unwraps a data key through signed Encrypt/Decrypt calls bound to the application’s context', async () => {
    const k = fakeKms();
    const kek = kms(k.fetchImpl);
    const dek = randomBytes(32);
    const wrapped = await kek.wrap(dek);
    expect(wrapped.equals(dek)).toBe(false);
    expect((await kek.unwrap(wrapped)).equals(dek)).toBe(true);
    expect(k.calls.map((c) => [c.target, c.signed])).toEqual([['TrentService.Encrypt', true], ['TrentService.Decrypt', true]]);
    expect(k.calls[0]!.body.EncryptionContext).toEqual({ app: 'inrp2p', purpose: 'field-data-key' });
  });

  it('a wrapped key opens only under its own key and context', async () => {
    const k = fakeKms();
    const wrapped = await kms(k.fetchImpl).wrap(randomBytes(32));
    await expect(kms(k.fetchImpl, ARN_B, 'kms-b').unwrap(wrapped)).rejects.toMatchObject({ code: 'KMS_REFUSED' });
  });

  it('retries a throttled or failing KMS, refuses at once what retrying cannot fix, and never answers without it', async () => {
    const flaky = fakeKms({ failFirst: 2, failWith: { status: 400, type: 'ThrottlingException' } });
    const dek = randomBytes(32);
    expect(await kms(flaky.fetchImpl).wrap(dek)).toBeInstanceOf(Buffer);
    expect(flaky.calls.length).toBe(3); // two throttled, the third answered

    const denied = fakeKms({ deny: true });
    await expect(kms(denied.fetchImpl).wrap(dek)).rejects.toMatchObject({ code: 'KMS_REFUSED' });
    expect(denied.calls.length).toBe(1);

    const down = fakeKms({ failFirst: 100 });
    await expect(kms(down.fetchImpl).wrap(dek)).rejects.toMatchObject({ code: 'KMS_UNAVAILABLE' });
    expect(down.calls.length).toBe(4);
    const unreachable = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(kms(unreachable).wrap(dek)).rejects.toMatchObject({ code: 'KMS_UNAVAILABLE' });
  });

  it('refuses an alias or anything that is not a key ARN, so a sealed value always names one key', () => {
    expect(() => kms(fakeKms().fetchImpl, 'alias/inrp2p')).toThrow(/ARN/);
    expect(() => kms(fakeKms().fetchImpl, 'arn:aws:kms:ap-south-1:111122223333:alias/inrp2p')).toThrow(/ARN/);
  });
});

describe('AWS credentials', () => {
  it('come from the environment, else the container role, else the instance role — and say so when there are none', async () => {
    expect(await awsCredentialsFromEnvironment({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' })()).toMatchObject({ accessKeyId: 'AKIA', sessionToken: 't' });
    const seen: string[] = [];
    const container = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ AccessKeyId: 'ASIA', SecretAccessKey: 's', Token: 'role', Expiration: new Date(Date.now() + 3_600_000).toISOString() }));
    }) as typeof fetch;
    const source = awsCredentialsFromEnvironment({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }, container);
    expect(await source()).toMatchObject({ accessKeyId: 'ASIA', sessionToken: 'role' });
    await source();
    expect(seen).toEqual(['http://169.254.170.2/v2/credentials/abc']); // cached until close to expiry
    const nowhere = (async () => { throw new TypeError('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(awsCredentialsFromEnvironment({}, nowhere)()).rejects.toMatchObject({ code: 'KMS_UNAVAILABLE' });
  });
});

describe('field protection configuration (TD-03)', () => {
  const hmac = randomBytes(32).toString('base64');
  const local = randomBytes(32).toString('base64');

  it('refuses in production a locally held key, a missing configuration and the repository’s own test keys', () => {
    expect(() => fieldProtectionFromEnv({ INRP2P_ENV: 'production' })).toThrow(/required in production/);
    expect(() => fieldProtectionFromEnv({ INRP2P_ENV: 'production', INRP2P_KEK_ID: 'k1', INRP2P_KEK_BASE64: local, INRP2P_FIELD_HMAC_BASE64: hmac })).toThrow(/not allowed in production/);
    expect(() => fieldProtectionFromEnv({
      INRP2P_ENV: 'production', INRP2P_KEK_PROVIDER: 'aws-kms', INRP2P_KEK_ID: 'k1', INRP2P_KMS_KEY_ARN: ARN_A,
      INRP2P_FIELD_HMAC_BASE64: 'ZTJlLWhtYWMtbWF0ZXJpYWwtMDEyMzQ1Njc4OWFiY2U=', // secret-scan:allow
    })).toThrow(/test keys/);
    expect(() => fieldProtectionFromEnv({
      INRP2P_ENV: 'production', INRP2P_KEK_PROVIDER: 'aws-kms', INRP2P_KEK_ID: 'k1', INRP2P_KMS_KEY_ARN: ARN_A, INRP2P_FIELD_HMAC_BASE64: hmac,
      INRP2P_KEK_PREVIOUS: JSON.stringify([{ id: 'old', provider: 'local', base64: local }]),
    })).toThrow(/locally held/);
    // Outside production, nothing configured simply means nothing protected — and every seal refuses.
    expect(fieldProtectionFromEnv({})).toBeNull();
  });

  it('rotates: values sealed under the previous KMS key stay readable, new ones are sealed under the current key', async () => {
    const k = fakeKms();
    const env = (current: string, arn: string, previous?: object[]) => ({
      INRP2P_ENV: 'production', INRP2P_KEK_PROVIDER: 'aws-kms', INRP2P_KEK_ID: current, INRP2P_KMS_KEY_ARN: arn, INRP2P_FIELD_HMAC_BASE64: hmac,
      INRP2P_KMS_ENDPOINT: 'https://kms.test/', AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's',
      ...(previous ? { INRP2P_KEK_PREVIOUS: JSON.stringify(previous) } : {}),
    });
    const before = fieldProtectionFromEnv(env('kms-2026a', ARN_A), { fetchImpl: k.fetchImpl })!;
    const old = await before.protector.seal('50100123458219', 'bank_account.account_number:c1');
    expect(old.split('.')[1]).toBe('kms-2026a');

    const after = fieldProtectionFromEnv(env('kms-2026b', ARN_B, [{ id: 'kms-2026a', provider: 'aws-kms', arn: ARN_A }]), { fetchImpl: k.fetchImpl })!;
    expect(await after.protector.open(old, 'bank_account.account_number:c1')).toBe('50100123458219');
    const fresh = await after.protector.seal('50100123458219', 'bank_account.account_number:c1');
    expect(fresh.split('.')[1]).toBe('kms-2026b');
    // The field context is authenticated at the data-key layer: the right key and the wrong field still fail.
    await expect(after.protector.open(fresh, 'bank_account.account_number:c2')).rejects.toThrow();
  });
});
