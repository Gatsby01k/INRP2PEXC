import type { Direction } from '@inrp2p/kernel';

/**
 * Where "Request quote" goes: the client app's Exchange screen, told the direction and amount the visitor already
 * chose. An empty or zero amount is left out rather than sent; the screen asks for one.
 */
export function requestHref(appOrigin: string, direction: Direction, amount: string): string {
  const params = new URLSearchParams({ direction: direction === 'SELL_USDT' ? 'sell' : 'buy' });
  if (/[1-9]/.test(amount)) params.set('amount', amount);
  return `${appOrigin}/exchange?${params.toString()}`;
}
