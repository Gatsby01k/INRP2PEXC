import { MAX_MARKET_OFFSET_BPS, Rate, marketRateMicro } from '@inrp2p/kernel';
import type { BlockView } from '@inrp2p/traders';

/**
 * A side's rate set against the market (ADR 0028), as the trader types and reads it: a percentage either way, and what it
 * comes to now. The figure itself is the kernel's (`marketRateMicro`), so what the screen shows is what an order gets.
 */

/** Basis points as the trader reads them: +0.30%, −0.25%, 0.00%. */
export const offsetText = (bps: number) => {
  const abs = Math.abs(bps);
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
  return bps > 0 ? `+${text}` : bps < 0 ? `−${text}` : text;
};

/** "0.3", "+0.30", "-0.25" → basis points, without a float; null when it is not a percentage to two places. */
export function parseOffsetBps(text: string): number | null {
  const m = /^\s*([+\-−])?\s*(\d{1,2})(?:[.,](\d{0,2}))?\s*%?\s*$/.exec(text);
  if (!m) return null;
  const bps = Number.parseInt(m[2]!, 10) * 100 + Number.parseInt((m[3] ?? '').padEnd(2, '0') || '0', 10);
  const signed = m[1] === '-' || m[1] === '−' ? -bps : bps;
  return Math.abs(signed) <= MAX_MARKET_OFFSET_BPS ? signed : null;
}

/** What a market rate comes to now, for the trader to see before it saves: null without a market or a valid offset. */
export function marketPreview(block: Pick<BlockView, 'side' | 'market'>, offset: string, limit: string): string | null {
  const bps = parseOffsetBps(offset);
  if (bps === null || block.market === null) return null;
  let limitMicro: bigint | null = null;
  if (limit.trim()) {
    try {
      limitMicro = Rate.parse(limit.trim(), 'ROUTE').micro;
    } catch {
      return null;
    }
  }
  if (limitMicro !== null && limitMicro <= 0n) return null;
  const micro = marketRateMicro({ side: block.side, referenceMicro: Rate.parse(block.market, 'ROUTE').micro, offsetBps: bps, limitMicro });
  return Rate.ofMicro(micro, 'ROUTE').toDecimalString();
}
