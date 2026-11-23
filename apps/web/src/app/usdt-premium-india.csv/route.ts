import { headers } from 'next/headers';
import { premiumReading } from '../../server/premium.ts';
import { getRuntime } from '../../server/runtime.ts';
import { surfaceForHost } from '../../server/surface.ts';

export const dynamic = 'force-dynamic';

/** A micro-rupee figure as a plain decimal with four places, the way a spreadsheet reads it. */
const four = (micro: bigint): string => {
  const tenThousandths = (micro + 50n) / 100n;
  return `${tenThousandths / 10_000n}.${(tenThousandths % 10_000n).toString().padStart(4, '0')}`;
};
const percent = (hundredths: bigint): string => {
  const abs = hundredths < 0n ? -hundredths : hundredths;
  return `${hundredths < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};

/**
 * `/usdt-premium-india.csv`: India's USDT premium day by day, as the premium page shows it — each day's average of the
 * market's USDT/INR reference (ADR 0025) in India's time, the ECB's dollar in rupees published for that day, and the
 * premium of the one over the other. For anyone who cites the figures: a journalist, an analyst, a spreadsheet.
 *
 * Only the public host answers. Without a dollar to measure against there is nothing to publish, and it says so with a
 * 503 rather than an empty file that looks like a quiet market.
 */
export async function GET() {
  const surface = surfaceForHost((await headers()).get('host'), getRuntime().hosts);
  if (surface !== 'PUBLIC') return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const reading = await premiumReading();
  if (!reading || reading.days.length === 0) {
    return new Response('The premium cannot be read right now.\n', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '600' } });
  }
  const rows = reading.days.map((d) => [d.day, four(d.usdtMicro), four(d.dollar.micro), d.dollar.date, percent(d.hundredths)].join(','));
  const body = ['date_ist,usdt_inr_market_day_average,usd_inr_ecb_reference,ecb_reference_date,premium_percent', ...rows, ''].join('\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'inline; filename="india-usdt-premium.csv"',
      'cache-control': 'public, max-age=600, s-maxage=600',
    },
  });
}
