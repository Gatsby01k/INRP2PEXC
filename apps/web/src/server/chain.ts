import 'server-only';
import { type ChainVerifier, DualProviderChainVerifier, TronHttpProvider, UnconfiguredChainVerifier } from '@inrp2p/adapters';
import { isTronAddress } from '@inrp2p/kernel';
import { optionalEnv } from './env.ts';

let verifier: ChainVerifier | undefined;

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
  verifier = new DualProviderChainVerifier({ primary, ...(secondary ? { secondary } : {}), tokenContract: contract });
  return verifier;
}
