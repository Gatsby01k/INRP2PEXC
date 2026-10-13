import { HDKey } from '@scure/bip32';
import { DomainError, type TronAddress } from '@inrp2p/kernel';
import { tronAddressOfPublicKey } from './tron-tx.ts';

/**
 * The exchange's own HD wallet, public half (ADR 0017 §3). BIP-32/BIP-44 with TRON's registered coin type 195 —
 * the derivation every standard TRON wallet (TronLink, Trust, Ledger) uses, so the 24 recovery words open the same
 * addresses anywhere.
 *
 * - `m/44'/195'/0'/0/{i}` — deposit addresses, one per trade or per trader delivery, `i` from a database sequence
 *   that never repeats.
 * - `m/44'/195'/1'/0/0` — the network budget wallet: where traders' TRX deposits arrive and top-ups leave from.
 *
 * Everything here works from the account's extended **public** key: the web app issues addresses without ever holding
 * a key that could spend from them. The private half lives only in the worker (`@inrp2p/adapters/signer`).
 */
export const TRON_COIN_TYPE = 195;
export const DEPOSIT_ACCOUNT_PATH = "m/44'/195'/0'";
export const DEPOSIT_CHAIN_PATH = `${DEPOSIT_ACCOUNT_PATH}/0`;
export const FEE_WALLET_PATH = "m/44'/195'/1'/0/0";
/** BIP-32 child indexes below the hardened range. */
const MAX_INDEX = 0x7fffffffn;

export const depositPath = (index: bigint): string => {
  if (typeof index !== 'bigint' || index < 0n || index > MAX_INDEX) throw new DomainError('INVALID_ARGUMENT', 'a deposit index is 0…2³¹−1');
  return `${DEPOSIT_CHAIN_PATH}/${index}`;
};

/** The index of a deposit path, or null for any other path. */
export function depositIndexOf(path: string): bigint | null {
  const m = /^m\/44'\/195'\/0'\/0\/([0-9]{1,10})$/.exec(path);
  if (!m) return null;
  const i = BigInt(m[1]!);
  return i <= MAX_INDEX ? i : null;
}

/** Paths the signer may ever sign for: deposit addresses and the network budget wallet. Nothing else. */
export const isSignablePath = (path: string): boolean => path === FEE_WALLET_PATH || depositIndexOf(path) !== null;

/** Deposit addresses from the account's extended public key: what the web app uses to issue an address per trade. */
export class HdDepositAccount {
  readonly xpub: string;
  readonly #chain: HDKey;

  constructor(accountXpub: string) {
    const xpub = accountXpub.trim();
    let account: HDKey;
    try {
      account = HDKey.fromExtendedKey(xpub);
    } catch (e) {
      throw new DomainError('INVALID_ARGUMENT', `not an extended public key: ${(e as Error).message}`);
    }
    if (account.privateKey) throw new DomainError('INVALID_ARGUMENT', 'an extended PRIVATE key was given where only the public one belongs');
    // An account key sits at depth 3 (m/44'/195'/n'); a deeper or shallower key would derive somewhere else.
    if (account.depth !== 3) throw new DomainError('INVALID_ARGUMENT', `the account key must be at depth 3 (m/44'/195'/0'), not ${account.depth}`);
    this.xpub = xpub;
    this.#chain = account.deriveChild(0);
  }

  addressAt(index: bigint): { readonly address: TronAddress; readonly path: string } {
    const path = depositPath(index);
    const child = this.#chain.deriveChild(Number(index));
    if (!child.publicKey) throw new DomainError('INVALID_ARGUMENT', 'derivation produced no key');
    return { address: tronAddressOfPublicKey(child.publicKey), path };
  }
}
