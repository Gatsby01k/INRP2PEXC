import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AwsKmsKeyEncryptionKey, LocalKeyEncryptionKey, awsCredentialsFromEnvironment, createFieldProtector, fieldProtectionFromEnv, rewrapSealed, sealedParts,
  signSigV4, sigV4SigningKey, webIdentityToken,
} from '../src/index.ts';
import { type FakeKmsOptions, fakeKms as fakeKmsOf } from '../src/testing/index.ts';

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

/** The in-memory KMS of `@inrp2p/adapters/testing`, holding these two keys. */
const fakeKms = (opts: Omit<FakeKmsOptions, 'arns'> = {}) => fakeKmsOf({ ...opts, arns: [ARN_A, ARN_B] });

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

describe('AWS credentials from a web identity (Vercel OIDC federation, token files)', () => {
  const ROLE = 'arn:aws:iam::111122223333:role/inrp2p-vercel-web';
  const STS_OK = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult>
    <Credentials><SessionToken>session-from-sts</SessionToken><SecretAccessKey>secret-from-sts</SecretAccessKey>
    <Expiration>${new Date(Date.now() + 3_600_000).toISOString()}</Expiration><AccessKeyId>ASIASTS</AccessKeyId></Credentials>
  </AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
  const sts = (reply: { status: number; body: string }) => {
    const seen: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
      return new Response(reply.body, { status: reply.status });
    }) as typeof fetch;
    return { fetchImpl, seen };
  };
  const CONTEXT = Symbol.for('@vercel/request-context');
  const withVercelRequest = async <T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
    const g = globalThis as Record<symbol, unknown>;
    g[CONTEXT] = { get: () => ({ headers }) };
    try {
      return await fn();
    } finally {
      delete g[CONTEXT];
    }
  };

  it('reads the token Vercel gives the request, else VERCEL_OIDC_TOKEN, else a token file', async () => {
    expect(webIdentityToken({})).toBeNull();
    expect(webIdentityToken({ VERCEL_OIDC_TOKEN: 'from-env' })).toBe('from-env');
    expect(await withVercelRequest({ 'x-vercel-oidc-token': 'from-request' }, async () => webIdentityToken({ VERCEL_OIDC_TOKEN: 'from-env' }))).toBe('from-request');
    expect(webIdentityToken({ AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/token' }, (p) => (p === '/var/run/token' ? 'from-file\n' : ''))).toBe('from-file');
  });

  it('exchanges it with STS for the named role and caches the temporary credentials until close to expiry', async () => {
    const s = sts({ status: 200, body: STS_OK });
    const source = awsCredentialsFromEnvironment({ AWS_ROLE_ARN: ROLE, AWS_REGION: 'us-east-1', AWS_ROLE_SESSION_NAME: 'inrp2p-web' }, s.fetchImpl);
    const creds = await withVercelRequest({ 'x-vercel-oidc-token': 'jwt-from-vercel' }, source);
    expect(creds).toMatchObject({ accessKeyId: 'ASIASTS', secretAccessKey: 'secret-from-sts', sessionToken: 'session-from-sts' });
    expect(s.seen[0]!.url).toBe('https://sts.us-east-1.amazonaws.com/');
    expect(Object.fromEntries(s.seen[0]!.body)).toMatchObject({ Action: 'AssumeRoleWithWebIdentity', RoleArn: ROLE, RoleSessionName: 'inrp2p-web', WebIdentityToken: 'jwt-from-vercel' });
    await source(); // no request context now: the cached credentials still serve
    expect(s.seen).toHaveLength(1);
  });

  it('says so when a role is named but there is no token, and refuses at once what STS refuses', async () => {
    await expect(awsCredentialsFromEnvironment({ AWS_ROLE_ARN: ROLE }, sts({ status: 200, body: STS_OK }).fetchImpl)()).rejects.toThrow(/OIDC federation/);
    const denied = sts({ status: 403, body: '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized</Message></Error></ErrorResponse>' });
    await expect(awsCredentialsFromEnvironment({ AWS_ROLE_ARN: ROLE, VERCEL_OIDC_TOKEN: 'jwt' }, denied.fetchImpl)()).rejects.toMatchObject({ code: 'KMS_REFUSED' });
    const down = sts({ status: 503, body: '<ErrorResponse><Error><Code>ServiceUnavailable</Code></Error></ErrorResponse>' });
    await expect(awsCredentialsFromEnvironment({ AWS_ROLE_ARN: ROLE, VERCEL_OIDC_TOKEN: 'jwt' }, down.fetchImpl)()).rejects.toMatchObject({ code: 'KMS_UNAVAILABLE' });
  });

  it('lets KMS run on those credentials', async () => {
    const k = fakeKms();
    const s = sts({ status: 200, body: STS_OK });
    const both = (async (url: string | URL | Request, init?: RequestInit) => (String(url).includes('sts.') ? s.fetchImpl(url, init) : k.fetchImpl(url, init))) as typeof fetch;
    const kek = new AwsKmsKeyEncryptionKey({
      keyId: 'kms-a', keyArn: ARN_A, credentials: awsCredentialsFromEnvironment({ AWS_ROLE_ARN: ROLE, VERCEL_OIDC_TOKEN: 'jwt' }, both), fetchImpl: both, endpoint: 'https://kms.test/',
    });
    const dek = randomBytes(32);
    expect((await kek.unwrap(await kek.wrap(dek))).equals(dek)).toBe(true);
    expect(k.calls.every((c) => c.signed)).toBe(true);
  });
});

describe('moving sealed values to KMS (migration 0036)', () => {
  const hmacKey = randomBytes(32);
  const local = new LocalKeyEncryptionKey('prod-v1', randomBytes(32));

  it('re-wraps only the data key: the iv, the ciphertext and the tag stay, and the value opens under KMS alone', async () => {
    const k = fakeKms();
    const target = kms(k.fetchImpl);
    const before = await createFieldProtector({ kek: local, hmacKey }).seal('50100123458219', 'bank_account.account_number:c1');
    const after = await rewrapSealed(before, [local], target);
    const [b, a] = [sealedParts(before), sealedParts(after)];
    expect(a.keyId).toBe('kms-a');
    expect([a.iv, a.ciphertext, a.tag]).toEqual([b.iv, b.ciphertext, b.tag]);
    expect(a.wrapped).not.toBe(b.wrapped);
    const kmsOnly = createFieldProtector({ kek: target, hmacKey });
    expect(await kmsOnly.open(after, 'bank_account.account_number:c1')).toBe('50100123458219');
    // Still bound to its field: the context is checked at the data layer, which the move never touched.
    await expect(kmsOnly.open(after, 'bank_account.account_number:c2')).rejects.toThrow();
    // Already moved: returned as is, KMS not asked again.
    const calls = k.calls.length;
    expect(await rewrapSealed(after, [local], target)).toBe(after);
    expect(k.calls.length).toBe(calls);
  });

  it('refuses a value whose key it was not given, and a value that is not sealed', async () => {
    const other = new LocalKeyEncryptionKey('other', randomBytes(32));
    const sealed = await createFieldProtector({ kek: other, hmacKey }).seal('x', 'f');
    await expect(rewrapSealed(sealed, [local], kms(fakeKms().fetchImpl))).rejects.toThrow(/no key to unwrap values sealed under other/);
    await expect(rewrapSealed('plain', [local], kms(fakeKms().fetchImpl))).rejects.toThrow(/unsupported sealed value/);
  });
});
