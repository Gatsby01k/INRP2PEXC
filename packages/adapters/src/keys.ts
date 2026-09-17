import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DomainError } from '@inrp2p/kernel';

/**
 * Key-encryption-key port (ARCHITECTURE §8). Production binds a cloud KMS; the application never sees the
 * KEK itself, only wrap/unwrap of per-value data keys.
 */
export interface KeyEncryptionKey {
  /** Stable key id recorded in every sealed value so rotation can find the right KEK. */
  readonly keyId: string;
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

/**
 * AES-256-GCM key wrapping with a locally held 32-byte key. For development and tests; production
 * deployments supply a KMS-backed KeyEncryptionKey instead (launch checklist).
 */
export class LocalKeyEncryptionKey implements KeyEncryptionKey {
  readonly keyId: string;
  readonly #key: Buffer;

  constructor(keyId: string, key: Buffer) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new DomainError('INVALID_ARGUMENT', 'key id must be url-safe, 1..64 chars');
    if (key.length !== 32) throw new DomainError('INVALID_ARGUMENT', 'KEK must be 32 bytes');
    this.keyId = keyId;
    this.#key = Buffer.from(key);
  }

  static fromBase64(keyId: string, base64: string): LocalKeyEncryptionKey {
    return new LocalKeyEncryptionKey(keyId, Buffer.from(base64, 'base64'));
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([c.update(dataKey), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    if (wrapped.length < 12 + 16 + 1) throw new DomainError('INVALID_ARGUMENT', 'wrapped key too short');
    const d = createDecipheriv('aes-256-gcm', this.#key, wrapped.subarray(0, 12));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }

  toJSON(): { keyId: string } {
    return { keyId: this.keyId };
  }
}
