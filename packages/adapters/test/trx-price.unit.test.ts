import { describe, expect, it } from 'vitest';
import { isDomainError } from '@inrp2p/kernel';
import { type TrxPriceSource, marketTrxPriceSources, readTrxPrice } from '../src/index.ts';

const source = (name: string, price: number | Error): TrxPriceSource => ({
  name,
  read: async () => {
    if (price instanceof Error) throw price;
    return price;
  },
});

describe('the TRX price from public markets', () => {
  it('takes the middle of sources that agree, in micro-USDT, and names them', async () => {
    const r = await readTrxPrice([source('a', 0.33), source('b', 0.331)]);
    expect(r.usdtPerTrxMicro).toBe(330_500n);
    expect(r.source).toContain('a 0.33');
    expect(r.source).toContain('b 0.331');
  });

  it('goes on with the sources that answered when one does not', async () => {
    const r = await readTrxPrice([source('a', new Error('timeout')), source('b', 0.3296)]);
    expect(r.usdtPerTrxMicro).toBe(329_600n);
  });

  it('refuses sources that disagree rather than publishing a price nobody stands behind', async () => {
    await expect(readTrxPrice([source('a', 0.33), source('b', 0.36)])).rejects.toSatisfy((e) => isDomainError(e, 'INVALID_RATE'));
  });

  it('is a provider error, transient, when no source answers', async () => {
    await expect(readTrxPrice([source('a', new Error('down')), source('b', new Error('down'))])).rejects.toSatisfy(
      (e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR') && /a: down/.test((e as Error).message),
    );
  });

  it('reads Kraken and CoinGecko as they answer', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('kraken')
        ? Response.json({ error: [], result: { TRXUSD: { c: ['0.3294720', '107.6'] } } })
        : Response.json({ tron: { usd: 0.329627 } })) as unknown as typeof fetch;
    const r = await readTrxPrice(marketTrxPriceSources(fetchImpl));
    expect(r.usdtPerTrxMicro).toBe(329_550n);
  });
});
