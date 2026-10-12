import { DomainError } from '@inrp2p/kernel';
import type { Sealed } from './field-protection.ts';
import type { KeyEncryptionKey } from './keys.ts';

/**
 * Moving a sealed value to another key-encryption key (migration 0036, RUNBOOKS `field-encryption-keys`).
 *
 * A sealed value is `v1.<key id>.<wrapped data key>.<iv>.<ciphertext>.<tag>`. Only the data key is wrapped by the
 * key-encryption key, so a move unwraps the data key with the key that wrapped it and wraps it with the target: the
 * iv, the ciphertext and the tag are kept byte for byte. The field itself is never decrypted here, and what it says
 * cannot change — the database refuses a re-wrap that touches anything but the key id and the wrapped data key.
 */

export interface SealedParts {
  readonly keyId: string;
  readonly wrapped: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export function sealedParts(sealed: string): SealedParts {
  const parts = sealed.split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') throw new DomainError('INVALID_ARGUMENT', 'unsupported sealed value');
  const [, keyId, wrapped, iv, ciphertext, tag] = parts as [string, string, string, string, string, string];
  return { keyId, wrapped, iv, ciphertext, tag };
}

/** The key id a sealed value names. */
export const sealedKeyId = (sealed: string): string => sealedParts(sealed).keyId;

/**
 * Re-wraps the data key of `sealed` under `target`, unwrapping it with whichever of `from` wrapped it. A value already
 * under `target` is returned unchanged.
 */
export async function rewrapSealed(sealed: string, from: readonly KeyEncryptionKey[], target: KeyEncryptionKey): Promise<Sealed> {
  const p = sealedParts(sealed);
  if (p.keyId === target.keyId) return sealed as Sealed;
  const source = from.find((k) => k.keyId === p.keyId);
  if (!source) throw new DomainError('INVALID_ARGUMENT', `no key to unwrap values sealed under ${p.keyId}`);
  const dek = await source.unwrap(Buffer.from(p.wrapped, 'base64url'));
  try {
    if (dek.length !== 32) throw new DomainError('INVALID_ARGUMENT', `the data key under ${p.keyId} is not 32 bytes`);
    const wrapped = await target.wrap(dek);
    return `v1.${target.keyId}.${wrapped.toString('base64url')}.${p.iv}.${p.ciphertext}.${p.tag}` as Sealed;
  } finally {
    dek.fill(0);
  }
}
