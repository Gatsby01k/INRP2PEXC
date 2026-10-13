import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { DomainError, type TronAddress, normalizeTronAddress } from '@inrp2p/kernel';
import { AwsKmsKeyEncryptionKey, awsCredentialsFromEnvironment } from '../aws-kms.ts';
import { type FieldProtector, type Sealed, createFieldProtector } from '../field-protection.ts';
import { DEPOSIT_ACCOUNT_PATH, FEE_WALLET_PATH, isSignablePath } from '../hd-wallet.ts';
import { type KeyEncryptionKey, LocalKeyEncryptionKey } from '../keys.ts';
import { type UnsignedTronTx, decodeTronTransaction, signTxid, tronAddressOfPublicKey } from '../tron-tx.ts';

/**
 * The private half of the exchange's HD wallet (ADR 0017 §3) — the worker's, never the web app's: this entry point is
 * `@inrp2p/adapters/signer`, which the web app may not import (lint).
 *
 * The seed is a BIP-39 mnemonic of 24 words, written on paper twice when it is made and kept apart from every system
 * (RUNBOOKS `custody-seed`). The worker holds it only as an envelope-sealed value (`INRP2P_CUSTODY_SEED_SEALED`) whose
 * data key a KMS key wraps under the `custody-seed` context, opened once at start into memory. It signs nothing but
 * the two transaction shapes the exchange sends, from a deposit address or the budget wallet, and only after checking
 * that the key it derived is the transaction's own sender.
 */
export const CUSTODY_SEED_CONTEXT = 'custody.hd_seed.v1';
/**
 * The record address of the deal-address pool (`treasury_wallet` role DEPOSIT_POOL): an address of the same seed that
 * the ledger names deal addresses under. Nothing is ever sent to or from it; the signer never signs for it.
 */
export const POOL_RECORD_PATH = "m/44'/195'/2'/0/0";
const KMS_CONTEXT = Object.freeze({ app: 'inrp2p', purpose: 'custody-seed' });

export class HdSigner {
  readonly #root: HDKey;
  /** m/44'/195'/0' — what the web app and the database hold (`custody_hd_account.account_xpub`). */
  readonly accountXpub: string;
  readonly feeWalletAddress: TronAddress;
  readonly poolRecordAddress: TronAddress;
  #closed = false;

  private constructor(root: HDKey) {
    this.#root = root;
    this.accountXpub = root.derive(DEPOSIT_ACCOUNT_PATH).publicExtendedKey;
    this.feeWalletAddress = this.addressOf(FEE_WALLET_PATH);
    const pool = root.derive(POOL_RECORD_PATH);
    this.poolRecordAddress = tronAddressOfPublicKey(pool.publicKey!);
    pool.wipePrivateData();
  }

  static fromMnemonic(mnemonic: string, passphrase = ''): HdSigner {
    const words = mnemonic.trim().split(/\s+/).join(' ');
    if (!validateMnemonic(words, wordlist)) throw new DomainError('INVALID_ARGUMENT', 'not a valid BIP-39 mnemonic (English word list, checksum)');
    const seed = mnemonicToSeedSync(words, passphrase);
    try {
      return new HdSigner(HDKey.fromMasterSeed(seed));
    } finally {
      seed.fill(0);
    }
  }

  #key(path: string): HDKey {
    if (this.#closed) throw new DomainError('CUSTODY_SIGNER_CLOSED', 'the signer was closed');
    if (!isSignablePath(path)) throw new DomainError('CUSTODY_PATH_REFUSED', `the signer does not sign for ${path}`);
    return this.#root.derive(path);
  }

  addressOf(path: string): TronAddress {
    const key = this.#key(path);
    try {
      return tronAddressOfPublicKey(key.publicKey!);
    } finally {
      key.wipePrivateData();
    }
  }

  /**
   * Signs one of the exchange's own transactions. The transaction is read back from its bytes — not from what the
   * caller says it is — and refused unless the key at `path` is its sender.
   */
  sign(path: string, tx: UnsignedTronTx): string {
    const decoded = decodeTronTransaction({ rawDataHex: tx.rawDataHex });
    if (decoded.txid !== tx.txid) throw new DomainError('CUSTODY_TX_MISMATCH', 'the transaction id is not the hash of its bytes');
    const key = this.#key(path);
    try {
      const owner = tronAddressOfPublicKey(key.publicKey!);
      if (owner !== decoded.contract.from) throw new DomainError('CUSTODY_TX_MISMATCH', `the key at ${path} is ${owner}, the transaction is sent by ${decoded.contract.from}`);
      return signTxid(decoded.txid, key.privateKey!);
    } finally {
      key.wipePrivateData();
    }
  }

  close(): void {
    this.#closed = true;
    this.#root.wipePrivateData();
  }

  toJSON(): { accountXpub: string; feeWalletAddress: string } {
    return { accountXpub: this.accountXpub, feeWalletAddress: this.feeWalletAddress };
  }
}

/** A new 24-word custody mnemonic (256 bits of entropy from the platform's CSPRNG). */
export function newCustodyMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function isCustodyMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim().split(/\s+/).join(' '), wordlist);
}

/** Seals the mnemonic under the custody KEK: an envelope whose data key KMS wraps (the field format, its own context). */
export async function sealCustodySeed(mnemonic: string, kek: KeyEncryptionKey): Promise<Sealed> {
  if (!isCustodyMnemonic(mnemonic)) throw new DomainError('INVALID_ARGUMENT', 'not a valid BIP-39 mnemonic');
  return protectorFor(kek).seal(mnemonic.trim().split(/\s+/).join(' '), CUSTODY_SEED_CONTEXT);
}

export async function openCustodySeed(sealed: string, kek: KeyEncryptionKey): Promise<HdSigner> {
  const mnemonic = await protectorFor(kek).open(sealed, CUSTODY_SEED_CONTEXT);
  return HdSigner.fromMnemonic(mnemonic);
}

// The envelope needs a lookup key it never uses for the seed; a throwaway one keeps it out of every configuration.
const protectorFor = (kek: KeyEncryptionKey): FieldProtector => createFieldProtector({ kek, hmacKey: randomBytes(32) });

/**
 * The custody key-encryption key from the environment:
 *
 * - `INRP2P_CUSTODY_KEK_PROVIDER` — `aws-kms` (`INRP2P_CUSTODY_KMS_KEY_ARN`, a key only the worker's role may use for
 *   Decrypt, under the `custody-seed` context) or `local` (`INRP2P_CUSTODY_KEK_BASE64`; development and tests only);
 * - `INRP2P_CUSTODY_KEK_ID` — the id recorded in the sealed value.
 *
 * Production refuses a locally held key.
 */
export function custodyKekFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetchImpl?: typeof fetch } = {}): KeyEncryptionKey {
  const production = (env.INRP2P_ENV ?? '').trim().toLowerCase() === 'production';
  const provider = (env.INRP2P_CUSTODY_KEK_PROVIDER ?? (production ? 'aws-kms' : 'local')).trim().toLowerCase();
  const keyId = (env.INRP2P_CUSTODY_KEK_ID ?? '').trim();
  if (!keyId) throw new DomainError('CUSTODY_MISCONFIGURED', 'INRP2P_CUSTODY_KEK_ID is required');
  if (provider === 'aws-kms') {
    const arn = (env.INRP2P_CUSTODY_KMS_KEY_ARN ?? '').trim();
    if (!arn) throw new DomainError('CUSTODY_MISCONFIGURED', 'INRP2P_CUSTODY_KMS_KEY_ARN is required for aws-kms');
    return new AwsKmsKeyEncryptionKey({
      keyId, keyArn: arn, credentials: awsCredentialsFromEnvironment(env, deps.fetchImpl ?? fetch), encryptionContext: KMS_CONTEXT,
      ...(env.INRP2P_KMS_ENDPOINT ? { endpoint: env.INRP2P_KMS_ENDPOINT } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  if (provider === 'local') {
    if (production) throw new DomainError('CUSTODY_MISCONFIGURED', 'a locally held custody key is not allowed in production: set INRP2P_CUSTODY_KEK_PROVIDER=aws-kms');
    const b64 = (env.INRP2P_CUSTODY_KEK_BASE64 ?? '').trim();
    if (!b64) throw new DomainError('CUSTODY_MISCONFIGURED', 'INRP2P_CUSTODY_KEK_BASE64 is required for the local provider');
    return LocalKeyEncryptionKey.fromBase64(keyId, b64);
  }
  throw new DomainError('CUSTODY_MISCONFIGURED', `unknown INRP2P_CUSTODY_KEK_PROVIDER ${provider}`);
}

/**
 * The worker's signer, or null when custody signing is not configured (`INRP2P_CUSTODY_SEED_SEALED` absent): the worker
 * then signs nothing and every send waits, visibly. A configured but unopenable seed is an error, never a null.
 */
export async function signerFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetchImpl?: typeof fetch } = {}): Promise<HdSigner | null> {
  const sealed = (env.INRP2P_CUSTODY_SEED_SEALED ?? '').trim();
  if (!sealed) return null;
  const signer = await openCustodySeed(sealed, custodyKekFromEnv(env, deps));
  if ((env.INRP2P_ENV ?? '').trim().toLowerCase() === 'production' && WELL_KNOWN_TEST_XPUBS.has(signer.accountXpub)) {
    signer.close();
    throw new DomainError('CUSTODY_MISCONFIGURED', 'the custody seed is a published test mnemonic: anyone could spend from its addresses');
  }
  return signer;
}

/** Account keys (m/44'/195'/0') of mnemonics published in specifications and tutorials: never a production seed. */
export const WELL_KNOWN_TEST_XPUBS: ReadonlySet<string> = new Set([
  // "abandon abandon … about" (BIP-39 test vector), the repository's own test seed.
  'xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd',
]);

/** For the recovery check: the address a path derives to, as the database recorded it. */
export function sameAddress(a: string, b: string): boolean {
  return normalizeTronAddress(a) === normalizeTronAddress(b);
}
