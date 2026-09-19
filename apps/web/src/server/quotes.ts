import 'server-only';
import { DomainError } from '@inrp2p/kernel';
import {
  type CustodyAdapter,
  type FieldProtector,
  LocalKeyEncryptionKey,
  PoolCustodyAdapter,
  UnconfiguredCustodyAdapter,
  createFieldProtector,
} from '@inrp2p/adapters';
import type { QuoteDeps } from '@inrp2p/quotes';
import { optionalEnv } from './env.ts';

/**
 * What the web app needs to run a quote decision: the custody provider that SELL acceptance allocates a deposit
 * address through (D-02), and the field protector that seals and opens client secrets (SECURITY §4).
 *
 * Both mirror the worker's configuration and both fail loudly when unconfigured. A client accepting a quote is
 * the one moment the exchange takes on an obligation, so an app that cannot attribute the incoming USDT, or
 * cannot open a sealed value, must refuse the acceptance rather than complete it on a guess.
 */

/**
 * The only key implementation available today is a locally held KEK — TD-03: a KMS-backed KeyEncryptionKey is
 * required before real client data reaches staging or production.
 */
function protectorFromEnv(): FieldProtector | null {
  const keyId = optionalEnv('INRP2P_KEK_ID');
  const kek = optionalEnv('INRP2P_KEK_BASE64');
  const hmac = optionalEnv('INRP2P_FIELD_HMAC_BASE64');
  if (!keyId || !kek || !hmac) return null;
  const hmacKey = Buffer.from(hmac, 'base64');
  if (hmacKey.length !== 32) throw new DomainError('INVALID_ARGUMENT', 'INRP2P_FIELD_HMAC_BASE64 must decode to 32 bytes');
  return createFieldProtector({ kek: LocalKeyEncryptionKey.fromBase64(keyId, kek), hmacKey });
}

/** Refuses every operation, so an unconfigured deployment fails at the boundary instead of storing plaintext. */
const NOT_CONFIGURED = 'FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID, INRP2P_KEK_BASE64 and INRP2P_FIELD_HMAC_BASE64 are required';
const UNCONFIGURED_PROTECTOR: FieldProtector = {
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

let protector: FieldProtector | undefined;

export function protectorForWeb(): FieldProtector {
  if (!protector) protector = protectorFromEnv() ?? UNCONFIGURED_PROTECTOR;
  return protector;
}

let custody: CustodyAdapter | undefined;

/**
 * The custody adapter acceptance checks itself against.
 *
 * V1 runs in POOL mode (D-02): addresses are provisioned at the provider, imported once by an operator, and
 * handed out from `deposit_address`. The adapter's job at acceptance time is to say who it is and what it can do,
 * and `requireAdapterMatchesRecord` refuses if either disagrees with the recorded `custody_provider_config`. So
 * the app is configured with the provider slug alone — nothing here can invent an address.
 *
 * With no provider configured the adapter reports UNSUPPORTED, which is exactly what the database says with no
 * capability recorded: SELL acceptance refuses (D-02) instead of taking USDT it could not attribute.
 */
export function custodyForWeb(): CustodyAdapter {
  if (custody) return custody;
  const provider = optionalEnv('INRP2P_CUSTODY_PROVIDER');
  const capability = (optionalEnv('INRP2P_CUSTODY_CAPABILITY') ?? 'POOL').toUpperCase();
  if (!provider) {
    custody = new UnconfiguredCustodyAdapter();
    return custody;
  }
  if (capability !== 'POOL') {
    // DERIVED needs a provider integration that issues addresses; there is none in V1, and pretending otherwise
    // would mean acceptance succeeding against an address nobody can sweep.
    throw new DomainError('CUSTODY_CAPABILITY_UNSUPPORTED', `INRP2P_CUSTODY_CAPABILITY=${capability} is not implemented; V1 supports POOL (D-02)`);
  }
  custody = new PoolCustodyAdapter(provider);
  return custody;
}

export function quoteDepsForWeb(): QuoteDeps {
  return { protector: protectorForWeb(), custody: custodyForWeb() };
}
