import { marketTrail, publicMarketRates } from '@inrp2p/pricing';
import { getRuntime } from '../../../server/runtime.ts';

export const dynamic = 'force-dynamic';

/**
 * The USDT/INR market rate the home page's converter estimates with (ADR 0025's reference, both directions), on the
 * public host. The page itself reads no database: its converter asks here once it is shown, and the edge keeps the
 * answer for five minutes — the worker reads the books every five — so a crowd of visitors is one read, not thousands.
 * A rate older than the pricing policy allows is not given at all, and then the converter says what the price will be.
 */
export async function GET() {
  try {
    const db = getRuntime().appDb;
    const rates = await publicMarketRates(db);
    // The last day's line, for the workspace's ticker; only while there is a rate to show beside it.
    const trail = rates.SELL_USDT || rates.BUY_USDT ? await marketTrail(db) : [];
    return Response.json({ ...rates, trail }, { headers: { 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=300' } });
  } catch {
    return Response.json({ SELL_USDT: null, BUY_USDT: null, trail: [] }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
