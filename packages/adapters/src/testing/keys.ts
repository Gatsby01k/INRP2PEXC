import { randomBytes } from 'node:crypto';
import { createFieldProtector, type FieldProtector } from '../field-protection.ts';
import { LocalKeyEncryptionKey } from '../keys.ts';

/** Fresh random keys per test run; never used by any deployed environment. */
export function testFieldProtector(keyId = 'test-kek-1'): FieldProtector {
  return createFieldProtector({ kek: new LocalKeyEncryptionKey(keyId, randomBytes(32)), hmacKey: randomBytes(32) });
}
