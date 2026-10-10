import { createHash } from 'node:crypto';
import { DomainError } from '@inrp2p/kernel';
import { type AwsKmsOptions, AwsKmsKeyEncryptionKey, awsCredentialsFromEnvironment } from './aws-kms.ts';
import { type FieldProtector, createFieldProtector } from './field-protection.ts';
import { type KeyEncryptionKey, LocalKeyEncryptionKey } from './keys.ts';

/**
 * Field protection from the environment, the same for the web app and the worker (TD-03).
 *
 * - `INRP2P_KEK_PROVIDER` — `aws-kms` (the data keys are wrapped by a KMS key: `INRP2P_KMS_KEY_ARN`, optionally
 *   `INRP2P_KMS_ENDPOINT` for a VPC endpoint) or `local` (a key held in the process: `INRP2P_KEK_BASE64`, for
 *   development and tests). `INRP2P_KEK_ID` names the current key in every value it seals.
 * - `INRP2P_KEK_PREVIOUS` — the keys earlier values were sealed with, as JSON
 *   `[{"id":"…","provider":"aws-kms","arn":"…"}]`; they open old values and never seal new ones (rotation).
 * - `INRP2P_FIELD_HMAC_BASE64` — the 32-byte lookup key, from the secret manager.
 *
 * With `INRP2P_ENV=production` the configuration must be complete and must not use a locally held key — current or
 * previous — or a key this repository uses in its own tests: the process refuses to start rather than seal a bank
 * account under a key someone could read in a config file.
 */
export interface FieldProtectionConfig {
  readonly protector: FieldProtector;
  readonly current: KeyEncryptionKey;
  readonly previous: readonly KeyEncryptionKey[];
}

/** SHA-256 prefixes of the lookup keys the repository's own e2e and visual worlds use: never in production. */
const TEST_HMAC_FINGERPRINTS = new Set(['5a3045f704dfc4c8', '9f331ca9027aa9a2']);

const misconfigured = (message: string) => new DomainError('FIELD_PROTECTION_MISCONFIGURED', message);

function kmsKey(env: NodeJS.ProcessEnv, id: string, arn: string | undefined, deps: { fetchImpl?: typeof fetch }): AwsKmsKeyEncryptionKey {
  if (!arn) throw misconfigured(`the KMS key ARN for ${id} is required`);
  const opts: AwsKmsOptions = {
    keyId: id, keyArn: arn, credentials: awsCredentialsFromEnvironment(env, deps.fetchImpl ?? fetch),
    ...(env.INRP2P_KMS_ENDPOINT ? { endpoint: env.INRP2P_KMS_ENDPOINT } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  return new AwsKmsKeyEncryptionKey(opts);
}

export function fieldProtectionFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetchImpl?: typeof fetch } = {}): FieldProtectionConfig | null {
  const production = (env.INRP2P_ENV ?? '').trim().toLowerCase() === 'production';
  const provider = (env.INRP2P_KEK_PROVIDER ?? 'local').trim().toLowerCase();
  const keyId = env.INRP2P_KEK_ID?.trim();
  const hmacBase64 = env.INRP2P_FIELD_HMAC_BASE64?.trim();
  if (!keyId || !hmacBase64) {
    if (production) throw misconfigured('INRP2P_KEK_ID and INRP2P_FIELD_HMAC_BASE64 are required in production');
    return null;
  }
  const hmacKey = Buffer.from(hmacBase64, 'base64');
  if (hmacKey.length !== 32) throw misconfigured('INRP2P_FIELD_HMAC_BASE64 must decode to 32 bytes');
  if (production) {
    if (hmacKey.every((b) => b === 0)) throw misconfigured('the lookup key is all zeros');
    if (TEST_HMAC_FINGERPRINTS.has(createHash('sha256').update(hmacKey).digest('hex').slice(0, 16))) throw misconfigured('the lookup key is one of this repository’s test keys');
  }

  let current: KeyEncryptionKey;
  if (provider === 'aws-kms') {
    current = kmsKey(env, keyId, env.INRP2P_KMS_KEY_ARN?.trim(), deps);
  } else if (provider === 'local') {
    if (production) throw misconfigured('a locally held key-encryption key is not allowed in production: set INRP2P_KEK_PROVIDER=aws-kms');
    if (!env.INRP2P_KEK_BASE64) throw misconfigured('INRP2P_KEK_BASE64 is required for the local provider');
    current = LocalKeyEncryptionKey.fromBase64(keyId, env.INRP2P_KEK_BASE64);
  } else {
    throw misconfigured(`unknown INRP2P_KEK_PROVIDER ${provider}`);
  }

  const previous: KeyEncryptionKey[] = [];
  if (env.INRP2P_KEK_PREVIOUS?.trim()) {
    let list: unknown;
    try {
      list = JSON.parse(env.INRP2P_KEK_PREVIOUS);
    } catch {
      throw misconfigured('INRP2P_KEK_PREVIOUS is not JSON');
    }
    if (!Array.isArray(list)) throw misconfigured('INRP2P_KEK_PREVIOUS must be a JSON array');
    for (const entry of list as { id?: string; provider?: string; arn?: string; base64?: string }[]) {
      if (!entry.id || entry.id === keyId) throw misconfigured('every previous key needs its own id, different from the current one');
      if (entry.provider === 'aws-kms') previous.push(kmsKey(env, entry.id, entry.arn, deps));
      else if (entry.provider === 'local') {
        if (production) throw misconfigured(`previous key ${entry.id} is locally held, which production never used`);
        if (!entry.base64) throw misconfigured(`previous key ${entry.id} has no key material`);
        previous.push(LocalKeyEncryptionKey.fromBase64(entry.id, entry.base64));
      } else throw misconfigured(`previous key ${entry.id} has an unknown provider`);
    }
  }
  return { protector: createFieldProtector({ kek: current, previous, hmacKey }), current, previous };
}

/** Refuses every operation, so an unconfigured deployment fails at the boundary instead of storing plaintext. */
const NOT_CONFIGURED = 'FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID and INRP2P_FIELD_HMAC_BASE64 (and a key provider) are required';
export const UNCONFIGURED_FIELD_PROTECTOR: FieldProtector = {
  async seal(): Promise<never> {
    throw new Error(NOT_CONFIGURED);
  },
  async open(): Promise<never> {
    throw new Error(NOT_CONFIGURED);
  },
  lookupHash(): never {
    throw new Error(NOT_CONFIGURED);
  },
};
