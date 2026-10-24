import { DomainError } from '@inrp2p/kernel';

/**
 * What one TRX is worth, read from public markets — so the TRX price every quote's network fee is valued at never goes
 * stale because nobody published one (ADR 0017: after 72 hours without a price no quote is sent at all).
 *
 * Two independent public tickers, no keys. USD is taken for USDT: the fee is a few rupees, and the difference between
 * the two is far below the precision it is quoted to. A source that does not answer is left out; sources that disagree
 * by more than `maxSpread` are refused as a whole — a price nobody can stand behind is not published.
 */
export interface TrxPriceSource {
  readonly name: string;
  /** USD per TRX, or a thrown error. */
  read(): Promise<number>;
}

export interface TrxPriceReading {
  /** USDT per TRX, in millionths. */
  readonly usdtPerTrxMicro: bigint;
  /** The sources that answered, with what each said — recorded as the price's source. */
  readonly source: string;
}

const getJson = async (fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> => {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res.json();
};

const positive = (v: unknown, what: string): number => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what} is not a positive number`);
  return n;
};

/** Kraken's last trade and CoinGecko's aggregate: two different markets, both reachable without a key. */
export function marketTrxPriceSources(fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 8_000): TrxPriceSource[] {
  return [
    {
      name: 'kraken',
      read: async () => {
        const j = (await getJson(fetchImpl, 'https://api.kraken.com/0/public/Ticker?pair=TRXUSD', timeoutMs)) as { error?: unknown[]; result?: Record<string, { c?: unknown[] }> };
        if (Array.isArray(j.error) && j.error.length > 0) throw new Error(`kraken: ${String(j.error[0])}`);
        const pair = j.result ? Object.values(j.result)[0] : undefined;
        return positive(pair?.c?.[0], 'kraken last trade');
      },
    },
    {
      name: 'coingecko',
      read: async () => {
        const j = (await getJson(fetchImpl, 'https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=usd', timeoutMs)) as { tron?: { usd?: unknown } };
        return positive(j.tron?.usd, 'coingecko price');
      },
    },
  ];
}

/** The median of what the sources say, in micro-USDT, once they agree within `maxSpread` (a fraction: 0.03 is 3%). */
export async function readTrxPrice(sources: readonly TrxPriceSource[], maxSpread = 0.03): Promise<TrxPriceReading> {
  const answers = await Promise.all(
    sources.map(async (s) => {
      try {
        return { name: s.name, price: await s.read(), error: null as string | null };
      } catch (e) {
        return { name: s.name, price: 0, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const ok = answers.filter((a) => a.error === null);
  if (ok.length === 0) throw new DomainError('CHAIN_PROVIDER_ERROR', `no TRX price source answered: ${answers.map((a) => `${a.name}: ${a.error}`).join('; ')}`, { transient: true });
  const prices = ok.map((a) => a.price).sort((a, b) => a - b);
  if (prices[prices.length - 1]! > prices[0]! * (1 + maxSpread)) {
    throw new DomainError('INVALID_RATE', `TRX price sources disagree: ${ok.map((a) => `${a.name} ${a.price}`).join(', ')}`);
  }
  const mid = prices.length % 2 === 1 ? prices[(prices.length - 1) / 2]! : (prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2;
  const usdtPerTrxMicro = BigInt(Math.round(mid * 1_000_000));
  if (usdtPerTrxMicro <= 0n) throw new DomainError('INVALID_RATE', 'the TRX price rounds to nothing');
  return { usdtPerTrxMicro, source: `market: ${ok.map((a) => `${a.name} ${a.price}`).join(', ')}`.slice(0, 200) };
}
