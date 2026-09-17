/**
 * Realistic values from the approved specification (brief "Design validation"): never ₹100 or 10 USDT.
 */
import { Money, Rate, computeTradeEconomics } from '@inrp2p/kernel';

export const inr = (a: string) => Money.parse(a, 'INR');
export const usdt = (a: string) => Money.parse(a, 'USDT');
export const clientRate = (r: string) => Rate.parse(r, 'CLIENT');
export const routeRate = (r: string) => Rate.parse(r, 'ROUTE');

export const CANONICAL_SELL = computeTradeEconomics({
  direction: 'SELL_USDT',
  fixedSide: 'BASE',
  amount: usdt('100000'),
  clientRate: clientRate('102.00'),
  routeRate: routeRate('104.20'),
});

export const CANONICAL_BUY = computeTradeEconomics({
  direction: 'BUY_USDT',
  fixedSide: 'BASE',
  amount: usdt('20000'),
  clientRate: clientRate('101.10'),
  routeRate: routeRate('100.00'),
});

/** Fixed clock for deterministic stories and visual baselines: 16 Sep 2026, 16:11 IST. */
export const NOW = new Date('2026-09-16T10:41:00.000Z');
export const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000);

export const TRADE_REF = 'IX-260916-1842';
export const DEPOSIT_ADDRESS = 'TXqH2JBkDgGWyCFg4GZzg8eUjG5KdK9fA2';
export const CLIENT_WALLET = 'TVq7mNKgjbH1ZC5JrE9xQ8wD2sPLf3u9fA2';
export const TX_HASH = '7c1e5f0a9b3d2e4c6a8b0d1f3e5a7c9b2d4f6a8c0e1b3d5f7a9c1e3b5d7fa90b'; // secret-scan:allow — public on-chain tx hash fixture
