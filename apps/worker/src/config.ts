import { DomainError } from '@inrp2p/kernel';
import { type FieldProtector, LocalKeyEncryptionKey, createFieldProtector } from '@inrp2p/adapters';

/**
 * Field protection for the worker (opening sealed acceptance codes for delivery). The only key implementation
 * available today is the locally held KEK — TD-03: a KMS-backed KeyEncryptionKey is required before any real
 * client data reaches staging or production. Returns `null` when no keys are configured, so the worker starts and
 * code deliveries fail loudly instead of silently disappearing.
 */
export function fieldProtectorFromEnv(env: NodeJS.ProcessEnv = process.env): FieldProtector | null {
  const keyId = env.INRP2P_KEK_ID;
  const kek = env.INRP2P_KEK_BASE64;
  const hmac = env.INRP2P_FIELD_HMAC_BASE64;
  if (!keyId || !kek || !hmac) return null;
  const hmacKey = Buffer.from(hmac, 'base64');
  if (hmacKey.length !== 32) throw new DomainError('INVALID_ARGUMENT', 'INRP2P_FIELD_HMAC_BASE64 must decode to 32 bytes');
  return createFieldProtector({ kek: LocalKeyEncryptionKey.fromBase64(keyId, kek), hmacKey });
}

/** A protector that refuses every operation, so an unconfigured deployment cannot open or seal anything. */
export const UNCONFIGURED_PROTECTOR: FieldProtector = {
  async seal(): Promise<never> {
    throw new Error('FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID, INRP2P_KEK_BASE64 and INRP2P_FIELD_HMAC_BASE64 are required');
  },
  async open(): Promise<never> {
    throw new Error('FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID, INRP2P_KEK_BASE64 and INRP2P_FIELD_HMAC_BASE64 are required');
  },
  lookupHash(): never {
    throw new Error('FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID, INRP2P_KEK_BASE64 and INRP2P_FIELD_HMAC_BASE64 are required');
  },
};
