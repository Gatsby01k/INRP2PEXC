import { describe, expect, it } from 'vitest';
import { isDomainError } from '@inrp2p/kernel';
import { type UsdtInrSource, marketUsdtInrSources, readUsdtInrReference, rupeesMicro } from '../src/index.ts';

const book = (name: string, bid: string, ask: string): UsdtInrSource => ({ name, read: async () => ({ bidMicro: rupeesMicro(bid, 'bid'), askMicro: rupeesMicro(ask, 'ask') }) });
const down = (name: string): UsdtInrSource => ({ name, read: async () => { throw new Error('timeout'); } });

describe('the USDT/INR market reference from public books', () => {
  it('takes the middle bid and ask of books that agree, rounded to the client’s side', async () => {
    const r = await readUsdtInrReference([book('a', '101.32', '101.86'), book('b', '101.2', '101.22')]);
    expect(r.bidMicro).toBe(101_260_000n);
    expect(r.askMicro).toBe(101_540_000n);
    expect(r.source).toContain('a 101.32/101.86');
    expect(r.source).toContain('b 101.2/101.22');
  });

  it('never publishes one book alone: a price nobody confirmed is not a reference', async () => {
    await expect(readUsdtInrReference([book('a', '101', '102'), down('b')])).rejects.toSatisfy(
      (e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR') && /b: timeout/.test((e as Error).message),
    );
  });

  it('refuses books that disagree by more than the spread allowed', async () => {
    await expect(readUsdtInrReference([book('a', '101', '102'), book('b', '94.8', '94.9')])).rejects.toSatisfy((e) => isDomainError(e, 'INVALID_RATE'));
  });

  it('drops a crossed book (bid above ask) as if it had not answered', async () => {
    await expect(readUsdtInrReference([book('a', '103', '102'), book('b', '101', '102')])).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR'));
  });

  it('reads prices as decimals, never through a float, dropping digits past the sixth', () => {
    expect(rupeesMicro('101.2000000000', 'x')).toBe(101_200_000n);
    expect(rupeesMicro('0.1234567', 'x')).toBe(123_456n);
    expect(() => rupeesMicro(101.2, 'x')).toThrow();
    expect(() => rupeesMicro('1e2', 'x')).toThrow();
    expect(() => rupeesMicro('0', 'x')).toThrow();
  });

  it('reads WazirX and CoinDCX as they answer', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('wazirx')
        ? Response.json({ symbol: 'usdtinr', bidPrice: '101.32', askPrice: '101.86' })
        : Response.json([{ market: 'BTCINR', bid: '1', ask: '2' }, { market: 'USDTINR', bid: '101.2000000000', ask: '101.2200000000' }])) as unknown as typeof fetch;
    const r = await readUsdtInrReference(marketUsdtInrSources(fetchImpl));
    expect(r.bidMicro).toBe(101_260_000n);
    expect(r.askMicro).toBe(101_540_000n);
  });
});
