import 'server-only';
import { unstable_cache } from 'next/cache';
import { cache } from 'react';
import { Rate } from '@inrp2p/kernel';
import { type MarketDay, marketDays } from '@inrp2p/pricing';
import { getRuntime } from './runtime.ts';
import { marketReading } from './market.ts';
import { type DollarFix, fixFor, parseEcbDollar, premiumHundredths } from './premium-math.ts';

/**
 * India's USDT premium for the public premium page and its CSV: USDT's rupee price in India against the dollar's.
 *
 * - USDT in India is the market reference (ADR 0025) the converter and the rate guides show — the mid of both
 *   directions — now, and as each day's average in India's time (`marketDays`).
 * - The dollar is the European Central Bank's reference rates: rupees per euro over dollars per euro, published each
 *   working day. Nothing of INRP2P's own goes into either figure.
 *
 * Neither is allowed to hold a page up for long: past its wait, the page is drawn with its words and without the
 * figures, as the converter does without a rate.
 */

const ECB_DOLLAR = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD+INR.EUR.SP00.A';
/** How far back the page and its CSV look. The reference has been recorded since ADR 0025 went live. */
export const PREMIUM_DAYS = 90;

/**
 * The ECB answers in two to seven seconds and publishes once a working day, so its answer is kept in the framework's
 * data cache — one copy for every server, kept across cold starts — for three hours, and served while a fresh one is
 * fetched behind it. Only the first read ever, or one after the cache is purged, waits on the ECB.
 */
const DOLLAR_REVALIDATE_SECONDS = 3 * 3600;
const DOLLAR_WAIT_MS = 8_000;
/** After the ECB has failed, this server does not ask again for a while. */
const DOLLAR_MISS_MS = 2 * 60_000;
/** The days change with every recorded reference; the database is never waited on for long. */
const DAYS_FRESH_MS = 10 * 60_000;
const DAYS_MISS_MS = 60_000;
const DAYS_WAIT_MS = 1_500;

interface Held<T> {
  readonly value: T | null;
  readonly until: number;
}
let dollarRetryAt = 0;
let daysHeld: Held<readonly MarketDay[]> | null = null;

const timeout = <T,>(ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)) as Promise<T | null>;

/** The ECB's answer, read and checked. It throws rather than return nothing, so that a failure is never cached. */
const cachedDollar = unstable_cache(
  async (): Promise<readonly { readonly date: string; readonly micro: string }[]> => {
    // A few days more than the page shows, so its first day still finds the last working day's fix before it.
    const from = new Date(Date.now() - (PREMIUM_DAYS + 10) * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(`${ECB_DOLLAR}?startPeriod=${from}&format=csvdata&detail=dataonly`, {
      headers: { accept: 'text/csv' },
      cache: 'no-store',
      signal: AbortSignal.timeout(DOLLAR_WAIT_MS),
    });
    if (!res.ok) throw new Error(`ECB answered ${res.status}`);
    const fixes = parseEcbDollar(await res.text());
    if (fixes.length === 0) throw new Error('ECB answered without a dollar');
    // The data cache keeps JSON: the micro-rupees travel as text.
    return fixes.map((f) => ({ date: f.date, micro: f.micro.toString() }));
  },
  ['ecb-usd-inr', String(PREMIUM_DAYS)],
  { revalidate: DOLLAR_REVALIDATE_SECONDS },
);

/** The ECB's dollar in rupees for the last months, oldest first; null while it cannot be read. */
export async function dollarFixes(): Promise<readonly DollarFix[] | null> {
  if (Date.now() < dollarRetryAt) return null;
  const read = cachedDollar().then(
    (rows) => rows.map((r) => ({ date: r.date, micro: BigInt(r.micro) })),
    () => {
      dollarRetryAt = Date.now() + DOLLAR_MISS_MS;
      return null;
    },
  );
  return Promise.race([read, timeout<readonly DollarFix[]>(DOLLAR_WAIT_MS + 500)]);
}

async function marketHistory(): Promise<readonly MarketDay[] | null> {
  const now = Date.now();
  if (daysHeld && daysHeld.until > now) return daysHeld.value;
  const value = await Promise.race([marketDays(getRuntime().appDb, PREMIUM_DAYS).catch(() => null), timeout<readonly MarketDay[]>(DAYS_WAIT_MS)]);
  daysHeld = { value, until: now + (value ? DAYS_FRESH_MS : DAYS_MISS_MS) };
  return value;
}

export interface PremiumPoint {
  /** USDT in India, in micro-rupees. */
  readonly usdtMicro: bigint;
  /** The dollar it is measured against. */
  readonly dollar: DollarFix;
  /** The premium, in hundredths of a percent. */
  readonly hundredths: bigint;
}

export interface PremiumDay extends PremiumPoint {
  /** `YYYY-MM-DD` in India's time. */
  readonly day: string;
}

export interface PremiumReading {
  /** Now: the market's fresh reference against the latest dollar the ECB has published; null without a fresh reference. */
  readonly now: (PremiumPoint & { readonly at: Date }) | null;
  /** Each day's average against that day's dollar, oldest first. */
  readonly days: readonly PremiumDay[];
}

/** The mid of the market's two directions, or the one there is. */
function midMicro(sell: string | null, buy: string | null): bigint | null {
  const rates = [sell, buy].flatMap((r) => {
    if (!r) return [];
    try {
      return [Rate.parse(r, 'REFERENCE').micro];
    } catch {
      return [];
    }
  });
  if (rates.length === 0) return null;
  return rates.reduce((a, b) => a + b, 0n) / BigInt(rates.length);
}

/** The premium now and day by day; null when there is no dollar to measure against, or nothing to measure. */
export const premiumReading = cache(async (): Promise<PremiumReading | null> => {
  const [fixes, market, history] = await Promise.all([dollarFixes(), marketReading(), marketHistory()]);
  if (!fixes || fixes.length === 0) return null;
  const latest = fixes[fixes.length - 1]!;
  const mid = market ? midMicro(market.SELL_USDT, market.BUY_USDT) : null;
  const now = mid && market ? { usdtMicro: mid, dollar: latest, hundredths: premiumHundredths(mid, latest.micro), at: market.at } : null;
  const days = (history ?? []).flatMap((d): PremiumDay[] => {
    const dollar = fixFor(d.day, fixes);
    if (!dollar) return [];
    const usdtMicro = Rate.parse(d.mid, 'REFERENCE').micro;
    return [{ day: d.day, usdtMicro, dollar, hundredths: premiumHundredths(usdtMicro, dollar.micro) }];
  });
  if (!now && days.length === 0) return null;
  return { now, days };
});
