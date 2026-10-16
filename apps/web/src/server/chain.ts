import 'server-only';
import { type ChainVerifier, QuorumChainVerifier, TronHttpProvider, TronSendNetwork, UnconfiguredChainVerifier } from '@inrp2p/adapters';
import { DomainError } from '@inrp2p/kernel';
import { isTronAddress } from '@inrp2p/kernel';
import { optionalEnv } from './env.ts';

let verifier: ChainVerifier | undefined;
let providers: readonly TronHttpProvider[] = [];

/**
 * The chain verifier the desk's commands use (FI-24, D-05). The web app needs one only where an operator
 * confirms a USDT movement by hand; detection and automatic confirmation belong to the worker's scanner.
 *
 * Configuration mirrors the worker's, and the same rule applies: with nothing configured the verifier refuses
 * every lookup rather than letting an operator's word stand in for the chain.
 */
export function chainForWeb(): ChainVerifier {
  if (verifier) return verifier;
  const primaryUrl = optionalEnv('INRP2P_TRON_PRIMARY_URL');
  const primaryGroup = optionalEnv('INRP2P_TRON_PRIMARY_GROUP');
  const contract = optionalEnv('INRP2P_USDT_CONTRACT');
  if (!primaryUrl || !primaryGroup || !contract || !isTronAddress(contract)) {
    verifier = new UnconfiguredChainVerifier();
    return verifier;
  }
  const primaryKey = optionalEnv('INRP2P_TRON_PRIMARY_KEY');
  const primary = new TronHttpProvider({
    name: optionalEnv('INRP2P_TRON_PRIMARY_NAME') ?? 'tron-primary',
    independenceGroup: primaryGroup,
    baseUrl: primaryUrl,
    ...(primaryKey ? { apiKey: primaryKey } : {}),
  });
  const secondaryUrl = optionalEnv('INRP2P_TRON_SECONDARY_URL');
  const secondaryGroup = optionalEnv('INRP2P_TRON_SECONDARY_GROUP');
  const secondaryKey = optionalEnv('INRP2P_TRON_SECONDARY_KEY');
  const secondary =
    secondaryUrl && secondaryGroup
      ? new TronHttpProvider({
          name: optionalEnv('INRP2P_TRON_SECONDARY_NAME') ?? 'tron-secondary',
          independenceGroup: secondaryGroup,
          baseUrl: secondaryUrl,
          ...(secondaryKey ? { apiKey: secondaryKey } : {}),
        })
      : undefined;
  providers = secondary ? [primary, secondary] : [primary];
  verifier = new QuorumChainVerifier({ providers, tokenContract: contract });
  return verifier;
}

/**
 * The same providers, read as the signer reads them — for what the desk and traders hand in by hash (a TRX deposit to
 * the network budget, ADR 0017). Reading only: the web app never signs or broadcasts.
 */
export function sendNetworkForWeb(): TronSendNetwork {
  chainForWeb();
  if (providers.length === 0) throw new DomainError('CHAIN_MONITORING_UNCONFIGURED', 'no TRON provider is configured here, so no transaction can be read');
  return new TronSendNetwork(providers);
}
