import { describe, expect, it } from 'vitest';
import {
  HdDepositAccount, HdWalletCustodyAdapter, buildTrc20Transfer, buildTrxTransfer, decodeTronTransaction, depositIndexOf, depositPath, isSignablePath, recoverTxSigner,
  signTxid, signedTransactionHex,
} from '../src/index.ts';
import { HdSigner, WELL_KNOWN_TEST_XPUBS, isCustodyMnemonic, newCustodyMnemonic, openCustodySeed, sealCustodySeed, signerFromEnv } from '../src/signer/index.ts';
import { LocalKeyEncryptionKey } from '../src/keys.ts';
import { randomBytes } from 'node:crypto';

/**
 * Golden vectors produced by TronWeb 6.0.4 (`utils.accounts.generateAccountWithMnemonic`, `utils.transaction.txJsonToPb`,
 * `txPbToRawDataHex`, `txPbToTxID`, `utils.crypto.ECKeySign`) for the BIP-39 test mnemonic. The signer's bytes, txids and
 * signatures must be exactly TronWeb's — the reference implementation every TRON node accepts.
 */
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // secret-scan:allow — BIP-39's published test vector, never a wallet with money
const XPUB = 'xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd';
const ADDR0 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const ADDR1 = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK';
const FEE_WALLET = 'TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4';
const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const REF = { number: 0x1234a3f1n, id: `0000000000000000${'0123456789abcdef'}${'00'.repeat(16)}`, timestamp: 1760356740000 };
const EXPIRATION = 1760356800000;

const TRX_RAW = '0A02A3F122080123456789ABCDEF4080ACC4EB9D335A68080112640A2D747970652E676F6F676C65617069732E636F6D2F70726F746F636F6C2E5472616E73666572436F6E747261637412330A1541C8599111F29C1E1E061265B4AF93EA1F274AD78A121541B6E708A39781C96BD399C7657780FF9FE9F052A818C0C3930770A0D7C0EB9D33'.toLowerCase();
const TRX_TXID = '8ee77358018d8f069169b9845aa78638c879239701b6eff2857eb1562e9a9792'; // secret-scan:allow — a transaction id, not a key
const TRX_SIG = '282cd7e88b8fcc09aa7bedddbffc7f8c33646430608625d09b6278633de9f995359a548d0408f876767264564065c538518fa387cf7bec46d886d58d76da5cf51c';
const USDT_RAW = '0A02A3F122080123456789ABCDEF4080ACC4EB9D335AAE01081F12A9010A31747970652E676F6F676C65617069732E636F6D2F70726F746F636F6C2E54726967676572536D617274436F6E747261637412740A1541C8599111F29C1E1E061265B4AF93EA1F274AD78A121541A614F803B6FD780986A42C78EC9C7F77E6DED13C2244A9059CBB000000000000000000000000B6E708A39781C96BD399C7657780FF9FE9F052A80000000000000000000000000000000000000000000000000000000000BC614E70A0D7C0EB9D3390018087A70E'.toLowerCase();
const USDT_TXID = '19f32a4489fc659f75f9c184deae67a3194b3aa351655a3f12c739d8c60342f5'; // secret-scan:allow — a transaction id, not a key
const USDT_SIG = '3733e923dc66f67193638e69694a3d9ee6c40c6ddbb4ab50b4397dff9155920507e218bfcfd5239142daec0e69de7bd422ea7a13a9be3ee3ce7a1ae0073a56701b';

describe('HD derivation (BIP-39/BIP-44, TRON coin type 195)', () => {
  it('derives the same addresses as TronWeb and every standard TRON wallet', () => {
    const signer = HdSigner.fromMnemonic(MNEMONIC);
    expect(signer.accountXpub).toBe(XPUB);
    expect(signer.addressOf("m/44'/195'/0'/0/0")).toBe(ADDR0);
    expect(signer.addressOf("m/44'/195'/0'/0/1")).toBe(ADDR1);
    expect(signer.feeWalletAddress).toBe(FEE_WALLET);
  });

  it('issues addresses from the public key alone — the web app never holds a private key', () => {
    const account = new HdDepositAccount(XPUB);
    expect(account.addressAt(0n)).toEqual({ address: ADDR0, path: "m/44'/195'/0'/0/0" });
    expect(account.addressAt(1n).address).toBe(ADDR1);
    expect(() => new HdDepositAccount('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu')).toThrow();
  });

  it('allocates a deposit address per sequence number through the CustodyAdapter port', async () => {
    const adapter = new HdWalletCustodyAdapter({ accountXpub: XPUB });
    expect(await adapter.capabilities('TRON')).toEqual({ depositAddress: 'DERIVED' });
    expect(await adapter.allocateDepositAddress('TRON', 'IX-1', 1n)).toEqual({ address: ADDR1, custodyReference: "m/44'/195'/0'/0/1" });
  });

  it('signs only for deposit paths and the budget wallet', () => {
    expect(depositIndexOf(depositPath(42n))).toBe(42n);
    expect(isSignablePath("m/44'/195'/1'/0/0")).toBe(true);
    expect(isSignablePath("m/44'/195'/2'/0/0")).toBe(false);
    expect(isSignablePath("m/44'/60'/0'/0/0")).toBe(false);
    expect(() => HdSigner.fromMnemonic(MNEMONIC).addressOf("m/44'/195'/0'/1/0")).toThrow(/does not sign/);
  });
});

describe('TRON transactions, byte for byte', () => {
  it('builds a TRX transfer identical to TronWeb, with its txid', () => {
    const tx = buildTrxTransfer({ from: ADDR0, to: ADDR1, amountSun: 15_000_000n, ref: REF, timestamp: 1760356740000, expiration: EXPIRATION });
    expect(tx.rawDataHex).toBe(TRX_RAW);
    expect(tx.txid).toBe(TRX_TXID);
  });

  it('builds a USDT transfer(address,uint256) identical to TronWeb, with its fee limit and txid', () => {
    const tx = buildTrc20Transfer({ from: ADDR0, contract: USDT_MAINNET, to: ADDR1, amountMinor: 12_345_678n, feeLimitSun: 30_000_000n, ref: REF, timestamp: 1760356740000, expiration: EXPIRATION });
    expect(tx.rawDataHex).toBe(USDT_RAW);
    expect(tx.txid).toBe(USDT_TXID);
    const back = decodeTronTransaction({ rawDataHex: tx.rawDataHex });
    expect(back.contract).toEqual({ kind: 'TRC20', from: ADDR0, contract: USDT_MAINNET, to: ADDR1, amountMinor: 12_345_678n });
    expect(back.feeLimitSun).toBe(30_000_000n);
    expect(back.expiration).toBe(EXPIRATION);
  });

  it('signs exactly as TronWeb (RFC 6979, low-s, v = recovery + 27), and the signature recovers the sender', () => {
    const signer = HdSigner.fromMnemonic(MNEMONIC);
    const usdt = buildTrc20Transfer({ from: ADDR0, contract: USDT_MAINNET, to: ADDR1, amountMinor: 12_345_678n, feeLimitSun: 30_000_000n, ref: REF, timestamp: 1760356740000, expiration: EXPIRATION });
    const trx = buildTrxTransfer({ from: ADDR0, to: ADDR1, amountSun: 15_000_000n, ref: REF, timestamp: 1760356740000, expiration: EXPIRATION });
    expect(signer.sign("m/44'/195'/0'/0/0", usdt)).toBe(USDT_SIG);
    expect(signer.sign("m/44'/195'/0'/0/0", trx)).toBe(TRX_SIG);
    expect(recoverTxSigner(USDT_TXID, USDT_SIG)).toBe(ADDR0);
    const signed = decodeTronTransaction({ signedHex: signedTransactionHex(usdt.rawDataHex, USDT_SIG) });
    expect(signed.txid).toBe(USDT_TXID);
    expect(signed.signatures).toEqual([USDT_SIG]);
  });

  it('refuses to sign a transaction its key does not send, or bytes that are not their txid', () => {
    const signer = HdSigner.fromMnemonic(MNEMONIC);
    const tx = buildTrxTransfer({ from: ADDR1, to: ADDR0, amountSun: 1n, ref: REF, timestamp: 1, expiration: 2 });
    expect(() => signer.sign("m/44'/195'/0'/0/0", tx)).toThrow(/is sent by/);
    expect(() => signer.sign("m/44'/195'/0'/0/1", { ...tx, txid: USDT_TXID })).toThrow(/not the hash/);
    expect(() => signTxid('00', new Uint8Array(32))).toThrow();
  });
});

describe('the custody seed', () => {
  it('is 24 words, sealed under the custody key and opened only with it', async () => {
    const mnemonic = newCustodyMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(24);
    expect(isCustodyMnemonic(mnemonic)).toBe(true);
    const kek = new LocalKeyEncryptionKey('custody-test', randomBytes(32));
    const sealed = await sealCustodySeed(mnemonic, kek);
    expect(sealed).not.toContain(mnemonic.split(' ')[0]!);
    const signer = await openCustodySeed(sealed, kek);
    expect(signer.accountXpub).toBe(HdSigner.fromMnemonic(mnemonic).accountXpub);
    await expect(openCustodySeed(sealed, new LocalKeyEncryptionKey('custody-test', randomBytes(32)))).rejects.toThrow();
  });

  it('a published test mnemonic never runs in production, and a local key is refused there', async () => {
    const kek = new LocalKeyEncryptionKey('k1', randomBytes(32));
    const sealed = await sealCustodySeed(MNEMONIC, kek);
    expect(WELL_KNOWN_TEST_XPUBS.has(XPUB)).toBe(true);
    await expect(signerFromEnv({ INRP2P_ENV: 'production', INRP2P_CUSTODY_SEED_SEALED: sealed, INRP2P_CUSTODY_KEK_ID: 'k1', INRP2P_CUSTODY_KEK_PROVIDER: 'local', INRP2P_CUSTODY_KEK_BASE64: 'x' }))
      .rejects.toThrow(/not allowed in production/);
    expect(await signerFromEnv({})).toBeNull();
  });
});
