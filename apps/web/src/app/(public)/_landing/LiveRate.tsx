'use client';

import type { Direction } from '@inrp2p/kernel';
import { Rate } from '@inrp2p/kernel';
import { formatRate } from '@inrp2p/ui/format';
import { marketEstimate } from './estimate.ts';
import { rateFor, useMarket } from './market.ts';

/**
 * A figure in a drawing of the product, taken from the market rather than made up: the market's rate for a direction,
 * or an example amount of USDT at that rate in rupees. It is the market's own reference (ADR 0025), read once for the
 * page (market.ts); until there is one — or while it is too old to show — the drawing shows `fallback`, words rather
 * than a number. Never a price of ours: the drawings around it say so.
 */
export function LiveRate({ direction, usdt, fallback, className }: { direction: Direction; usdt?: string; fallback: string; className?: string | undefined }) {
  const market = useMarket();
  const rate = rateFor(market, direction);
  if (!rate) return <span className={className} data-fallback="">{fallback}</span>;
  if (usdt) {
    const estimate = marketEstimate(usdt, rate);
    return <span className={className}>{estimate ? `₹${estimate.rupees}` : fallback}</span>;
  }
  return <span className={className}>{formatRate(Rate.parse(rate, 'REFERENCE'))}</span>;
}
