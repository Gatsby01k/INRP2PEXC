import 'server-only';
import { DomainError } from '@inrp2p/kernel';
import {
  type CustodyAdapter,
  type FieldProtector,
  HdWalletCustodyAdapter,
  PoolCustodyAdapter,
  UNCONFIGURED_FIELD_PROTECTOR,
  UnconfiguredCustodyAdapter,
  fieldProtectionFromEnv,
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
 * Field protection from the environment, with the worker's rules (`fieldProtectionFromEnv`, TD-03): an AWS KMS key in
 * production — a locally held one, or one of the repository's test keys, refuses to start — and a refusing protector
 * when nothing is configured outside production.
 */
let protector: FieldProtector | undefined;

export function protectorForWeb(): FieldProtector {
  if (!protector) protector = fieldProtectionFromEnv(process.env)?.protector ?? UNCONFIGURED_FIELD_PROTECTOR;
  return protector;
}

let custody: CustodyAdapter | undefined;

/**
 * The custody adapter acceptance checks itself against.
 *
 * POOL (D-02): addresses are provisioned at a provider, imported once by an operator, and handed out from
 * `deposit_address`. DERIVED (ADR 0017): the exchange's own HD account derives a new address per trade from its
 * extended public key — see below. The adapter's job at acceptance time is to say who it is and what it can do,
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
  if (capability === 'DERIVED') {
    // ADR 0017: the exchange's own HD account. The web app holds only its extended public key — it derives a new
    // address per trade and can spend from none of them; the worker's signer holds the seed.
    const xpub = optionalEnv('INRP2P_CUSTODY_XPUB');
    if (!xpub) throw new DomainError('CUSTODY_MISCONFIGURED', 'INRP2P_CUSTODY_CAPABILITY=DERIVED needs INRP2P_CUSTODY_XPUB (the account key m/44\'/195\'/0\')');
    custody = new HdWalletCustodyAdapter({ provider, accountXpub: xpub });
    return custody;
  }
  if (capability !== 'POOL') {
    throw new DomainError('CUSTODY_CAPABILITY_UNSUPPORTED', `INRP2P_CUSTODY_CAPABILITY=${capability} is not supported: POOL (D-02) or DERIVED (ADR 0017)`);
  }
  custody = new PoolCustodyAdapter(provider);
  return custody;
}

export function quoteDepsForWeb(): QuoteDeps {
  return { protector: protectorForWeb(), custody: custodyForWeb() };
}
