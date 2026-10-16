import { describe, expect, it } from 'vitest';
import { LocalKeyEncryptionKey } from '@inrp2p/adapters';
import { openCustodySeed } from '@inrp2p/adapters/signer';
import { POOL_RECORD_PATH, confirmationPositions, custodyFacts, sealNew } from '../custody-seed.ts';

/**
 * The custody seed procedure (RUNBOOKS `custody-seed`). Its interactive part needs a terminal and a person; what CI
 * checks is the arithmetic around it: the same words always open the same, standard wallet (vectors from TronWeb
 * 6.0.4 for the BIP-39 test mnemonic), a sealed seed opens to that wallet again, and the words asked back are three
 * distinct positions of the 24.
 */
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // secret-scan:allow — BIP-39's published test vector, never a wallet with money

describe('the custody seed procedure', () => {
  it('derives the standard TRON wallet of a seed', () => {
    const f = custodyFacts(MNEMONIC);
    expect(f.firstDealAddress).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    expect(f.budgetWallet).toBe('TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4');
    expect(f.accountXpub).toBe('xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd');
    expect(POOL_RECORD_PATH).toBe("m/44'/195'/2'/0/0");
    expect(f.poolRecordAddress).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(new Set([f.firstDealAddress, f.budgetWallet, f.poolRecordAddress]).size).toBe(3);
  });

  it('seals a seed that opens to the same wallet, and only under its own key', async () => {
    const kek = new LocalKeyEncryptionKey('custody-test', Buffer.alloc(32, 7));
    const { sealed, facts } = await sealNew(MNEMONIC, kek);
    expect(sealed).not.toContain('abandon');
    const signer = await openCustodySeed(sealed, kek);
    expect(signer.accountXpub).toBe(facts.accountXpub);
    signer.close();
    await expect(openCustodySeed(sealed, new LocalKeyEncryptionKey('custody-test', Buffer.alloc(32, 8)))).rejects.toThrow();
  });

  it('asks back three distinct words of the 24', () => {
    for (let i = 0; i < 50; i += 1) {
      const p = confirmationPositions();
      expect(p).toHaveLength(3);
      expect(new Set(p).size).toBe(3);
      for (const n of p) expect(n >= 1 && n <= 24).toBe(true);
    }
  });
});
