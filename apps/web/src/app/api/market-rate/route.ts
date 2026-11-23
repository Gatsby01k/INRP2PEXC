import { marketTrail, publicMarketRates } from '@inrp2p/pricing';
import { dollarFixes, midMicro } from '../../../server/premium.ts';
import { premiumHundredths } from '../../../server/premium-math.ts';
import { getRuntime } from '../../../server/runtime.ts';

export const dynamic = 'force-dynamic';

/** How long the rate waits for the dollar before it goes without the premium. */
const DOLLAR_WAIT_MS = 1_500;

/**
 * The USDT/INR market rate the home page's converter estimates with (ADR 0025's reference, both directions), on the
 * public host. The page itself reads no database: its converter asks here once it is shown, and the edge keeps the
 * answer for five minutes — the worker reads the books every five — so a crowd of visitors is one read, not thousands.
 * A rate older than the pricing policy allows is not given at all, and then the converter says what the price will be.
 *
 * With the rate comes India's USDT premium over the dollar (in hundredths of a percent), which the masthead shows and
 * links to its page: the same mid measured against the ECB's latest dollar. The dollar is a cached answer; when it is
 * not to hand within a moment the premium is simply left out, and the rate is never held up for it.
 */
export async function GET() {
  try {
    const db = getRuntime().appDb;
    const rates = await publicMarketRates(db);
    // The last day's line, for the workspace's ticker, and the premium: only while there is a rate to show beside them.
    const mid = midMicro(rates.SELL_USDT, rates.BUY_USDT);
    const [trail, fixes] = mid
      ? await Promise.all([marketTrail(db), Promise.race([dollarFixes(), new Promise<null>((resolve) => setTimeout(() => resolve(null), DOLLAR_WAIT_MS))])])
      : [[], null];
    const dollar = fixes?.[fixes.length - 1];
    const premium = mid && dollar ? Number(premiumHundredths(mid, dollar.micro)) : null;
    return Response.json({ ...rates, trail, premium }, { headers: { 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=300' } });
  } catch {
    return Response.json({ SELL_USDT: null, BUY_USDT: null, trail: [], premium: null }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
