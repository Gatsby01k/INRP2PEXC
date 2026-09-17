import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isTronAddress } from '@inrp2p/kernel';
import { LocalKeyEncryptionKey, createFieldProtector } from '../src/index.ts';
import { FakeCustodyAdapter } from '../src/testing/index.ts';

const kek1 = new LocalKeyEncryptionKey('kek-1', randomBytes(32));
const hmacKey = randomBytes(32);

describe('envelope field protection (SECURITY §5)', () => {
  it('seals with a fresh data key, never contains the plaintext, and opens with the same context', async () => {
    const fp = createFieldProtector({ kek: kek1, hmacKey });
    const a = await fp.seal('50100123458219', 'bank_account.account_number');
    const b = await fp.seal('50100123458219', 'bank_account.account_number');
    expect(a).toMatch(/^v1\.kek-1(\.[A-Za-z0-9_-]+){4}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('50100123458219');
    expect(await fp.open(a, 'bank_account.account_number')).toBe('50100123458219');
  });

  it('binds the context: a value sealed for one field cannot be opened as another', async () => {
    const fp = createFieldProtector({ kek: kek1, hmacKey });
    const sealed = await fp.seal('9876543210', 'client_contact.phone');
    await expect(fp.open(sealed, 'bank_account.account_number')).rejects.toThrow();
  });

  it('detects tampering of the ciphertext', async () => {
    const fp = createFieldProtector({ kek: kek1, hmacKey });
    const parts = (await fp.seal('secret', 'x')).split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    await expect(fp.open(parts.join('.'), 'x')).rejects.toThrow();
  });

  it('reads values sealed under a previous KEK after rotation; unknown key ids fail', async () => {
    const sealed = await createFieldProtector({ kek: kek1, hmacKey }).seal('50100123458219', 'f');
    const kek2 = new LocalKeyEncryptionKey('kek-2', randomBytes(32));
    const rotated = createFieldProtector({ kek: kek2, previous: [kek1], hmacKey });
    expect(await rotated.open(sealed, 'f')).toBe('50100123458219');
    expect((await rotated.seal('x', 'f')).startsWith('v1.kek-2.')).toBe(true);
    await expect(createFieldProtector({ kek: kek2, hmacKey }).open(sealed, 'f')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('lookup hashes are deterministic per key and context and differ across keys and contexts', () => {
    const fp = createFieldProtector({ kek: kek1, hmacKey });
    expect(fp.lookupHash('50100123458219', 'bank')).toBe(fp.lookupHash('50100123458219', 'bank'));
    expect(fp.lookupHash('50100123458219', 'bank')).not.toBe(fp.lookupHash('50100123458219', 'inr_account'));
    expect(createFieldProtector({ kek: kek1, hmacKey: randomBytes(32) }).lookupHash('50100123458219', 'bank')).not.toBe(fp.lookupHash('50100123458219', 'bank'));
  });

  it('the KEK never serializes its key material', () => {
    expect(JSON.stringify({ kek1 })).toBe('{"kek1":{"keyId":"kek-1"}}');
  });
});

describe('fake custody adapter', () => {
  it('derives valid, deterministic TRON addresses and refuses modes it does not have', async () => {
    const derived = new FakeCustodyAdapter({ capability: 'DERIVED', seed: 's' });
    const a = await derived.allocateDepositAddress('TRON', 'IX-1');
    const b = await derived.allocateDepositAddress('TRON', 'IX-2');
    expect(isTronAddress(a.address) && isTronAddress(b.address)).toBe(true);
    expect(a.address).not.toBe(b.address);
    expect(new FakeCustodyAdapter({ capability: 'DERIVED', seed: 's' }).addressAt(0)).toEqual(a);
    await expect(derived.listDepositAddresses('TRON')).rejects.toMatchObject({ code: 'CUSTODY_CAPABILITY_MISMATCH' });
    const pool = new FakeCustodyAdapter({ capability: 'POOL', poolSize: 3 });
    expect(await pool.listDepositAddresses('TRON')).toHaveLength(3);
    await expect(pool.allocateDepositAddress('TRON', 'IX-3')).rejects.toMatchObject({ code: 'CUSTODY_CAPABILITY_MISMATCH' });
  });
});
