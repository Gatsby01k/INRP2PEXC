import { describe, expect, it } from 'vitest';
import type { BalanceReading, BalanceSource } from '@inrp2p/adapters';
import { readBalance } from '../src/balances.ts';

const ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const CONTRACT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';

const source = (name: string, group: string, answer: BalanceReading | Error | 'hang'): BalanceSource => ({
  name,
  independenceGroup: group,
  getSolidifiedBalance: () => (answer === 'hang' ? new Promise<BalanceReading>(() => {}) : answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
});
const at = (balanceMinor: bigint, solidifiedBlock: bigint): BalanceReading => ({ balanceMinor, solidifiedBlock, trxSun: 5_000_000n });

describe('reading a balance from several sources (B2)', () => {
  it('two independent groups with the same balance agree, as of the lower of their blocks', async () => {
    const r = await readBalance([source('a', 'vendor-a', at(100n, 900n)), source('b', 'vendor-b', at(100n, 905n))], ADDRESS, CONTRACT);
    expect(r).toMatchObject({ quality: 'AGREED', balanceMinor: 100n, solidifiedBlock: 900n, independentSources: 2, providers: ['a', 'b'], detail: null });
  });

  it('two adapters of one group are one source, however many answer', async () => {
    const r = await readBalance([source('a1', 'Vendor-A', at(100n, 900n)), source('a2', 'vendor-a', at(100n, 900n))], ADDRESS, CONTRACT);
    expect(r).toMatchObject({ quality: 'SINGLE_SOURCE', balanceMinor: 100n, independentSources: 1 });
  });

  it('one answer and one failure is a single source, and says which failed', async () => {
    const r = await readBalance([source('a', 'vendor-a', at(7n, 900n)), source('b', 'vendor-b', new Error('HTTP 503'))], ADDRESS, CONTRACT);
    expect(r).toMatchObject({ quality: 'SINGLE_SOURCE', balanceMinor: 7n, independentSources: 1, providers: ['a'] });
    expect(r.detail).toContain('b: HTTP 503');
  });

  it('different balances are a contradiction — never an average, a majority or the larger number', async () => {
    const r = await readBalance([
      source('a', 'vendor-a', at(100n, 900n)), source('b', 'vendor-b', at(100n, 900n)), source('c', 'vendor-c', at(1_000n, 900n)),
    ], ADDRESS, CONTRACT);
    expect(r).toMatchObject({ quality: 'DISAGREED', balanceMinor: null, solidifiedBlock: null });
    expect(r.detail).toContain('c=1000@900');
  });

  it('no answer at all — errors or timeouts — is an error reading, with no number in it', async () => {
    const r = await readBalance([source('a', 'vendor-a', new Error('ECONNRESET')), source('b', 'vendor-b', 'hang')], ADDRESS, CONTRACT, 20);
    expect(r).toMatchObject({ quality: 'ERROR', balanceMinor: null, solidifiedBlock: null, independentSources: 0, providers: [] });
    expect(r.detail).toContain('timed out');
    expect((await readBalance([], ADDRESS, CONTRACT)).detail).toBe('no source configured');
  });
});
