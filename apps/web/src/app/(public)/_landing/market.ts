'use client';

import { useEffect, useState } from 'react';
import type { Direction } from '@inrp2p/kernel';
import { MARKET_RATE_PATH } from '../../../server/surface.ts';

/** The market's USDT/INR reference as `/api/market-rate` gives it (ADR 0025): both directions, and the last day's line. */
export interface Market {
  readonly SELL_USDT: string | null;
  readonly BUY_USDT: string | null;
  readonly trail?: readonly string[];
  /** India's USDT premium over the dollar, in hundredths of a percent (`1236` is +12.36%); absent without a dollar. */
  readonly premium?: number | null;
}

/** How often the rate is asked for again while the page is looked at; the edge keeps it for a minute. */
const POLL_MS = 60_000;

/**
 * One reading of the market for the whole page. The masthead's ticker, the converter and the drawings of the workspace
 * all show the same rate, so they share one request rather than each asking: the first island to subscribe starts it,
 * the page's HTML never waits for it, and a missing or stale rate simply leaves every reader with its words.
 */
let current: Market | null = null;
let started = false;
const listeners = new Set<(m: Market | null) => void>();

async function read(): Promise<void> {
  if (document.visibilityState !== 'visible') return;
  try {
    const res = await fetch(MARKET_RATE_PATH, { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const next = (await res.json()) as Market;
    current = next.SELL_USDT || next.BUY_USDT ? next : null;
    for (const listener of listeners) listener(current);
  } catch {
    // A missed read keeps what is shown; the next one tries again.
  }
}

function start(): void {
  if (started) return;
  started = true;
  void read();
  window.setInterval(() => void read(), POLL_MS);
  document.addEventListener('visibilitychange', () => void read());
}

/** The market as last read, outside React (the robot's display reads it); starts the reading if nothing has. */
export function marketNow(): Market | null {
  if (typeof window !== 'undefined') start();
  return current;
}

/** The market, once read; null until then and while the reference is too old to show. */
export function useMarket(): Market | null {
  const [market, setMarket] = useState<Market | null>(current);
  useEffect(() => {
    listeners.add(setMarket);
    start();
    setMarket(current);
    return () => {
      listeners.delete(setMarket);
    };
  }, []);
  return market;
}

/** The rate for one direction, or the other one when only it is known. */
export const rateFor = (m: Market | null, d: Direction): string | null => (m ? (m[d] ?? null) : null);

/** The market's mid — the two directions averaged — or the one there is. */
export function marketMid(m: Market | null): number | null {
  if (!m) return null;
  const s = m.SELL_USDT ? Number(m.SELL_USDT) : null;
  const b = m.BUY_USDT ? Number(m.BUY_USDT) : null;
  return s !== null && b !== null ? (s + b) / 2 : (s ?? b);
}
