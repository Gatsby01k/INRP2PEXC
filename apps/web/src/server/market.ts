import 'server-only';
import { cache } from 'react';
import { marketTrail, publicMarketRates } from '@inrp2p/pricing';
import { getRuntime } from './runtime.ts';

/** The market's USDT/INR reference as the rate guides print it into their HTML (ADR 0025): both directions, and when. */
export interface MarketReading {
  readonly SELL_USDT: string | null;
  readonly BUY_USDT: string | null;
  /** The last day's mid, hour by hour, oldest first. */
  readonly trail: readonly string[];
  /** When the reading was taken. */
  readonly at: Date;
}

/** How long one reading serves the pages, and how long a failed one keeps them from asking again. */
const FRESH_MS = 60_000;
const MISS_MS = 15_000;
/** A page never waits longer than this for the database: past it, the guide is drawn without the figure. */
const WAIT_MS = 1_200;

let held: { readonly value: MarketReading | null; readonly until: number } | null = null;

async function read(): Promise<MarketReading | null> {
  const db = getRuntime().appDb;
  const rates = await publicMarketRates(db);
  if (!rates.SELL_USDT && !rates.BUY_USDT) return null;
  const trail = await marketTrail(db);
  return { ...rates, trail, at: new Date() };
}

/**
 * The market's rate for a rate guide's HTML — the number someone searching "USDT to INR" came for, in the page itself
 * rather than only after its script runs, so a search engine reads it too.
 *
 * The same reference `/api/market-rate` serves (`publicMarketRates`: each direction only while fresh enough to price on),
 * read at most once a minute per server and never allowed to hold a page up: a slow or absent database leaves the guide
 * with its words, as the converter does. Once per request (`cache`), however many parts of the page ask.
 */
export const marketReading = cache(async (): Promise<MarketReading | null> => {
  const now = Date.now();
  if (held && held.until > now) return held.value;
  const value = await Promise.race([
    read().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS)),
  ]);
  held = { value, until: now + (value ? FRESH_MS : MISS_MS) };
  return value;
});
