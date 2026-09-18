/**
 * Chain verification port (ARCHITECTURE §6, FI-24). A TRC20 transfer is CONFIRMED only when an implementation
 * reports it in a **solidified** block with a successful receipt, from the configured USDT contract, to the
 * expected destination. Scanning itself (block cursors, providers, reorgs) is Phase 5; the domain depends only on
 * this port so a transfer can never be marked confirmed by an operator's word.
 */
export type ChainNetwork = 'TRON';

export interface TransferReceipt {
  readonly network: ChainNetwork;
  readonly txHash: string;
  readonly logIndex: number;
  readonly tokenContract: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  /** Minor units of the token (USDT: 6 decimals), decoded from the Transfer log, never from tx input. */
  readonly amountMinor: bigint;
  readonly blockNumber: bigint;
  readonly blockTime: Date;
  readonly receiptStatus: 'SUCCESS' | 'FAILED';
  /** Highest solidified (irreversible) block the provider reports. */
  readonly solidifiedBlock: bigint;
  /** Provider names that returned exactly these facts. Names are for the audit trail, not for the quorum. */
  readonly agreedBy: readonly string[];
  /**
   * **Distinct independence groups** among the providers that agreed. D-05's "two independent providers" is
   * measured here, not on `agreedBy`: two adapters pointed at the same vendor, cluster or upstream node share a
   * group and can only ever count once, however they are named (`DECISIONS.md D-05`).
   */
  readonly agreedGroups: readonly string[];
}

export interface ChainVerifier {
  /** Names of the providers behind this verifier; recorded on the transfer. */
  readonly providers: readonly string[];
  /** Distinct independence groups configured. Fewer than two means no quorum is reachable at any amount. */
  readonly independenceGroups: readonly string[];
  /** The USDT (TRC20) contract this deployment accepts. */
  readonly tokenContract: string;
  /** Returns the transfer as the chain reports it, or `null` when the event does not exist. */
  lookupTransfer(network: ChainNetwork, txHash: string, logIndex: number): Promise<TransferReceipt | null>;
}

/** Used when no chain provider is configured: verification fails loudly instead of silently confirming. */
export class UnconfiguredChainVerifier implements ChainVerifier {
  readonly providers: readonly string[] = [];
  readonly independenceGroups: readonly string[] = [];
  readonly tokenContract = '';
  async lookupTransfer(): Promise<TransferReceipt | null> {
    throw new Error('CHAIN_VERIFIER_NOT_CONFIGURED: no TRON provider is configured for transfer verification');
  }
}
