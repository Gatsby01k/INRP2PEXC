import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { DomainError } from '@inrp2p/kernel';
import type { KeyEncryptionKey } from './keys.ts';

/** Sealed text stored in `inrp2p_sealed` columns: v1.<kid>.<wrapped dek>.<iv>.<ciphertext>.<tag> (base64url). */
export type Sealed = string & { readonly __sealed: true };

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export interface FieldProtector {
  /** Envelope-encrypts `plaintext`; `context` (e.g. "bank_account.account_number") is bound as AAD. */
  seal(plaintext: string, context: string): Promise<Sealed>;
  open(sealed: string, context: string): Promise<string>;
  /** Keyed HMAC-SHA-256 (separate key) for duplicate detection / lookup without decrypting (SECURITY §5). */
  lookupHash(normalized: string, context: string): string;
}

/**
 * Envelope encryption for sensitive fields (ARCHITECTURE §8, SECURITY §5): a fresh AES-256-GCM data key per
 * value, wrapped by the KEK. Values sealed under earlier key ids stay readable through `previous` KEKs.
 */
export function createFieldProtector(opts: { kek: KeyEncryptionKey; previous?: readonly KeyEncryptionKey[]; hmacKey: Buffer }): FieldProtector {
  if (opts.hmacKey.length < 32) throw new DomainError('INVALID_ARGUMENT', 'HMAC key must be at least 32 bytes');
  const keks = new Map([opts.kek, ...(opts.previous ?? [])].map((k) => [k.keyId, k]));
  const hmacKey = Buffer.from(opts.hmacKey);
  return {
    async seal(plaintext, context) {
      const dek = randomBytes(32);
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', dek, iv);
      c.setAAD(Buffer.from(context, 'utf8'));
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      const wrapped = await opts.kek.wrap(dek);
      dek.fill(0);
      return `v1.${opts.kek.keyId}.${b64(wrapped)}.${b64(iv)}.${b64(ct)}.${b64(c.getAuthTag())}` as Sealed;
    },
    async open(sealed, context) {
      const parts = sealed.split('.');
      if (parts.length !== 6 || parts[0] !== 'v1') throw new DomainError('INVALID_ARGUMENT', 'unsupported sealed value');
      const [, kid, wrapped, iv, ct, tag] = parts as [string, string, string, string, string, string];
      const kek = keks.get(kid);
      if (!kek) throw new DomainError('INVALID_ARGUMENT', `unknown key id ${kid}`);
      const dek = await kek.unwrap(unb64(wrapped));
      try {
        const d = createDecipheriv('aes-256-gcm', dek, unb64(iv));
        d.setAAD(Buffer.from(context, 'utf8'));
        d.setAuthTag(unb64(tag));
        return Buffer.concat([d.update(unb64(ct)), d.final()]).toString('utf8');
      } finally {
        dek.fill(0);
      }
    },
    lookupHash(normalized, context) {
      return createHmac('sha256', hmacKey).update(context, 'utf8').update(':', 'utf8').update(normalized, 'utf8').digest('hex');
    },
  };
}
