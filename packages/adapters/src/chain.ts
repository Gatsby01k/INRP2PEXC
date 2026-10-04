/**
 * Chain verification port (ARCHITECTURE §6, FI-24). A TRC20 transfer is CONFIRMED only when an implementation
 * reports it in a **solidified** block with a successful receipt, from the configured USDT contract, to the
 * expected destination. The domain depends only on this port, so a transfer can never be marked confirmed by an
 * operator's word — and an unreachable, lagging or disagreeing provider can never be read as "no such transfer".
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
  /**
   * Solidified head behind this answer: the lowest solidified head among the providers that call the block final,
   * or — when none does yet — the highest among those that agree on the facts.
   */
  readonly solidifiedBlock: bigint;
  /** Provider names that reported exactly these facts (and, when the block is final, call it final). */
  readonly agreedBy: readonly string[];
  /**
   * **Distinct independence groups** among the providers that agreed. D-05's "two independent providers" is
   * measured here, not on `agreedBy`: two adapters pointed at the same vendor, cluster or upstream node share a
   * group and can only ever count once, however they are named (`DECISIONS.md D-05`).
   */
  readonly agreedGroups: readonly string[];
  /** Configured providers that gave no usable answer this time (unreachable, timed out, unreadable). */
  readonly unavailable: readonly string[];
  /** True when at least one configured provider could not answer: the answer stands on fewer sources than configured. */
  readonly degraded: boolean;
}

/**
 * What the configured providers say about one Transfer log. Every outcome other than `FOUND` is an answer, not an
 * error, and none of them is "the transfer does not exist" unless every configured provider said so (`NOT_FOUND`
 * with no `unavailable`).
 */
export type ChainVerification =
  | { readonly status: 'FOUND'; readonly receipt: TransferReceipt }
  /** The chain executed the transaction and it failed (a reverted call keeps no Transfer logs). */
  | {
      readonly status: 'TX_FAILED';
      readonly txHash: string;
      readonly blockNumber: bigint;
      readonly blockTime: Date;
      readonly result: string;
      /** Providers that report the failure in a block they call final. */
      readonly agreedBy: readonly string[];
      readonly agreedGroups: readonly string[];
      readonly unavailable: readonly string[];
    }
  /** No provider that answered knows the transaction. */
  | { readonly status: 'NOT_FOUND'; readonly absentBy: readonly string[]; readonly absentGroups: readonly string[]; readonly unavailable: readonly string[] }
  /** Providers answered and contradict each other (different facts, or found vs failed). Never resolved by majority here. */
  | { readonly status: 'CONFLICT'; readonly reason: string; readonly unavailable: readonly string[] }
  /** Nobody gave a usable answer. */
  | { readonly status: 'UNAVAILABLE'; readonly reason: string; readonly unavailable: readonly string[] };

/** One Transfer log of a transaction, as the providers read it — for operator read-back of a submitted hash. */
export interface TransactionTransfers {
  readonly status: 'FOUND' | 'TX_FAILED' | 'NOT_FOUND';
  readonly txHash: string;
  /** Every TRC20 Transfer log in the transaction, with its real position. Empty unless FOUND. */
  readonly transfers: readonly Omit<TransferReceipt, 'solidifiedBlock' | 'agreedBy' | 'agreedGroups' | 'unavailable' | 'degraded'>[];
  /** The provider whose reading this is. */
  readonly provider: string;
}

export interface ChainVerifier {
  /** Names of the providers behind this verifier; recorded on the transfer. */
  readonly providers: readonly string[];
  /** Distinct independence groups configured. Fewer than two means no quorum is reachable at any amount. */
  readonly independenceGroups: readonly string[];
  /** The USDT (TRC20) contract this deployment accepts. */
  readonly tokenContract: string;
  /** Asks every configured provider about one Transfer log and combines the answers (FI-24, D-05). */
  verifyTransfer(network: ChainNetwork, txHash: string, logIndex: number): Promise<ChainVerification>;
  /**
   * The Transfer logs of one transaction, read from the first provider that knows it. Used to read back the facts
   * of a hash an operator submitted — the caller still picks the log by what it must pay (destination, amount) and
   * never by position, and confirmation still goes through `verifyTransfer`.
   */
  transactionTransfers(network: ChainNetwork, txHash: string): Promise<TransactionTransfers>;
}

/** Used when no chain provider is configured: verification fails loudly instead of silently confirming. */
export class UnconfiguredChainVerifier implements ChainVerifier {
  readonly providers: readonly string[] = [];
  readonly independenceGroups: readonly string[] = [];
  readonly tokenContract = '';
  async verifyTransfer(): Promise<ChainVerification> {
    throw new Error('CHAIN_VERIFIER_NOT_CONFIGURED: no TRON provider is configured for transfer verification');
  }
  async transactionTransfers(): Promise<TransactionTransfers> {
    throw new Error('CHAIN_VERIFIER_NOT_CONFIGURED: no TRON provider is configured for transfer verification');
  }
}
