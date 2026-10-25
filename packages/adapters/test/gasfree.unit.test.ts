import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isDomainError } from '@inrp2p/kernel';
import { GASFREE_MAINNET, GASFREE_NILE, GasFreeApi, type GasFreePermit, gasFreeAddressOf, gasFreeFromEnv, permitDigest, recoverPermitSigner, signPermitDigest } from '../src/index.ts';
import { HdSigner } from '../src/signer/index.ts';

const KEY = 'gasfree-test-key-0123'; // secret-scan:allow — a test placeholder, not a key
const SECRET = 'gasfree-test-secret-0123456789'; // secret-scan:allow — a test placeholder, not a secret
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // secret-scan:allow — BIP-39's published test vector

/**
 * Vectors read from the mainnet `GasFreeController` itself on 2026-10-25 (`triggerconstantcontract`): what the controller
 * derives and hashes is what the exchange computes, byte for byte.
 */
describe('the GasFree account and the permit digest, as the mainnet controller computes them', () => {
  it('derives the account of an owner (getGasFreeAddress)', () => {
    expect(gasFreeAddressOf('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', GASFREE_MAINNET)).toBe('TYr3sJvWHkJNu4eVjevoUjM8DU8iUy6sXi');
    expect(gasFreeAddressOf('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', GASFREE_MAINNET)).toBe('TNr6UTN6CaefeSVtMjm7thRY9GVR6sMNx6');
    // Another deployment, another account for the same owner.
    expect(gasFreeAddressOf('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', GASFREE_NILE)).not.toBe('TYr3sJvWHkJNu4eVjevoUjM8DU8iUy6sXi');
  });

  it('hashes a permit (getMessageHashForTransfer)', () => {
    const permit: GasFreePermit = {
      token: GASFREE_MAINNET.usdt, serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E' as GasFreePermit['serviceProvider'],
      user: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' as GasFreePermit['user'], receiver: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' as GasFreePermit['receiver'],
      value: 1_234_567n, maxFee: 3_000_000n, deadline: 1_761_400_000n, version: 1n, nonce: 7n,
    };
    expect(permitDigest(permit, GASFREE_MAINNET)).toBe('e89e49654905ca2f5bde4cff3d58110063562491999277848ef93bf1366a36bd'); // secret-scan:allow — the controller's own digest, not a key
    // Every field is signed: a different receiver, amount, cap or nonce is a different digest.
    for (const over of [{ receiver: 'TYr3sJvWHkJNu4eVjevoUjM8DU8iUy6sXi' }, { value: 1_234_568n }, { maxFee: 3_000_001n }, { nonce: 8n }] as Partial<GasFreePermit>[]) {
      expect(permitDigest({ ...permit, ...over }, GASFREE_MAINNET)).not.toBe(permitDigest(permit, GASFREE_MAINNET));
    }
  });
});

describe('the signer signs a permit only for the key that owns the account', () => {
  const signer = HdSigner.fromMnemonic(TEST_MNEMONIC);
  const path = "m/44'/195'/0'/0/5";
  const owner = signer.addressOf(path);
  const permit = (over: Partial<GasFreePermit> = {}): GasFreePermit => ({
    token: GASFREE_MAINNET.usdt, serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E' as GasFreePermit['serviceProvider'], user: owner as GasFreePermit['user'],
    receiver: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' as GasFreePermit['receiver'], value: 10_000_000n, maxFee: 3_000_000n, deadline: 1_761_400_000n, version: 1n, nonce: 0n, ...over,
  });

  it('signs the digest with the key at the path; the signature recovers to the owner', () => {
    const { digest, signature } = signer.signPermit(path, permit(), GASFREE_MAINNET);
    expect(digest).toBe(permitDigest(permit(), GASFREE_MAINNET));
    expect(signature).toMatch(/^[0-9a-f]{128}(1b|1c)$/);
    expect(recoverPermitSigner(digest, signature)).toBe(owner);
    expect(signer.signPermit(path, permit(), GASFREE_MAINNET).signature).toBe(signature);
  });

  it('refuses a permit for another owner, another token, or a path it does not sign for', () => {
    expect(() => signer.signPermit("m/44'/195'/0'/0/6", permit(), GASFREE_MAINNET)).toThrow(/is not the permit's owner/);
    expect(() => signer.signPermit(path, permit({ token: GASFREE_NILE.usdt }), GASFREE_MAINNET)).toThrow(/USDT/);
    expect(() => signer.signPermit("m/44'/195'/1'/0/0", permit({ user: signer.feeWalletAddress as GasFreePermit['user'] }), GASFREE_MAINNET)).toThrow(/deposit address/);
  });

  it('a signature over a raw digest is the same as the signer’s', () => {
    const digest = permitDigest(permit(), GASFREE_MAINNET);
    expect(recoverPermitSigner(digest, signPermitDigest(digest, new Uint8Array(32).fill(7)))).not.toBe(owner);
  });
});

interface Call { url: string; method: string; headers: Record<string, string>; body: string | undefined }

function scripted(answers: ((c: Call) => { status: number; body: unknown } | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries(init.headers ?? {})), body: init.body as string | undefined };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error('no scripted answer');
    const a = next(call);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('GasFree’s API', () => {
  const owner = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
  const api = (fetchImpl: typeof fetch) => new GasFreeApi({ chain: GASFREE_MAINNET, apiKey: KEY, apiSecret: SECRET, fetchImpl });
  const permit: GasFreePermit = {
    token: GASFREE_MAINNET.usdt, serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E' as GasFreePermit['serviceProvider'], user: owner as GasFreePermit['user'],
    receiver: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' as GasFreePermit['receiver'], value: 10_000_000n, maxFee: 3_000_000n, deadline: 1_761_400_000n, version: 1n, nonce: 4n,
  };

  it('signs each request: HMAC-SHA256 of method, path with the network prefix, and timestamp', async () => {
    const s = scripted([() => ({ status: 200, body: { code: 200, data: { accountAddress: owner, gasFreeAddress: 'TYr3sJvWHkJNu4eVjevoUjM8DU8iUy6sXi', active: false, nonce: 4, allowSubmit: true } } })]);
    expect(await api(s.fetchImpl).account(owner as GasFreePermit['user'])).toEqual({ gasFreeAddress: 'TYr3sJvWHkJNu4eVjevoUjM8DU8iUy6sXi', active: false, nonce: 4n, allowSubmit: true });
    const c = s.calls[0]!;
    expect(c.url).toBe(`https://open.gasfree.io/tron/api/v1/address/${owner}`);
    const expected = createHmac('sha256', SECRET).update(`GET/tron/api/v1/address/${owner}${c.headers.Timestamp}`).digest('base64');
    expect(c.headers.Authorization).toBe(`ApiKey ${KEY}:${expected}`);
  });

  it('refuses an account the controller would not derive for that owner', async () => {
    const s = scripted([() => ({ status: 200, body: { code: 200, data: { gasFreeAddress: 'TNr6UTN6CaefeSVtMjm7thRY9GVR6sMNx6', active: true, nonce: 1, allowSubmit: true } } })]);
    await expect(api(s.fetchImpl).account(owner as GasFreePermit['user'])).rejects.toSatisfy((e) => isDomainError(e, 'GASFREE_MISMATCH'));
  });

  it('submits a permit as signed and reads its trace; a documented refusal is final, anything else is not', async () => {
    const s = scripted([
      () => ({ status: 200, body: { code: 200, data: { id: 'trace-1', state: 'WAITING' } } }),
      () => ({ status: 200, body: { code: 400, reason: 'NonceNotMatchException', message: 'nonce 4 expected 5' } }),
      () => ({ status: 500, body: { code: 500, reason: 'RuntimeException' } }),
      () => new Error('socket hang up'),
      () => ({ status: 200, body: { code: 200, data: { id: 'trace-1', state: 'SUCCEED', txnHash: `0x${'ab'.repeat(32)}` } } }),
    ]);
    const a = api(s.fetchImpl);
    expect(await a.submit(permit, 'cd'.repeat(65), 'req-1')).toEqual({ id: 'trace-1', state: 'WAITING', txid: null });
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({
      requestId: 'req-1', token: GASFREE_MAINNET.usdt, serviceProvider: permit.serviceProvider, user: owner, receiver: permit.receiver,
      value: '10000000', maxFee: '3000000', deadline: 1_761_400_000, version: 1, nonce: 4, sig: 'cd'.repeat(65),
    });
    expect(await a.submit(permit, 'cd'.repeat(65), 'req-2')).toMatchObject({ refused: true, reason: 'NonceNotMatchException' });
    await expect(a.submit(permit, 'cd'.repeat(65), 'req-3')).rejects.toSatisfy((e) => isDomainError(e, 'GASFREE_UNAVAILABLE'));
    await expect(a.submit(permit, 'cd'.repeat(65), 'req-4')).rejects.toSatisfy((e) => isDomainError(e, 'GASFREE_UNAVAILABLE'));
    expect(await a.trace('trace-1')).toEqual({ id: 'trace-1', state: 'SUCCEED', txid: 'ab'.repeat(32) });
  });

  it('is configured by its key and secret, on mainnet unless told Nile', () => {
    expect(gasFreeFromEnv({})).toBeNull();
    expect(gasFreeFromEnv({ GASFREE_API_KEY: KEY, GASFREE_API_SECRET: SECRET })!.chain.name).toBe('MAINNET');
    expect(gasFreeFromEnv({ GASFREE_API_KEY: KEY, GASFREE_API_SECRET: SECRET, GASFREE_NETWORK: 'nile' })!.chain.name).toBe('NILE');
    expect(() => gasFreeFromEnv({ GASFREE_API_KEY: KEY })).toThrow(/GASFREE_API_SECRET/);
    expect(() => gasFreeFromEnv({ GASFREE_API_KEY: KEY, GASFREE_API_SECRET: SECRET, GASFREE_NETWORK: 'shasta' })).toThrow(/mainnet or nile/);
  });
});
