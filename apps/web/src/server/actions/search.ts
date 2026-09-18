'use server';

import { clientBook, searchOrders } from '@inrp2p/desk';
import { operatorContext } from '../operator.ts';

export interface SearchHit {
  readonly id: string;
  readonly kind: 'trade' | 'client';
  readonly label: string;
  readonly detail: string;
  readonly href: string;
}

/**
 * ⌘K search. It runs as the signed-in operator and returns only what that operator may see — a SUPPORT user
 * searching a UTR finds the trade, without its margin.
 */
export async function searchAction(term: string): Promise<readonly SearchHit[]> {
  const ctx = await operatorContext();
  const query = term.trim();
  if (query.length < 2) return [];
  const [trades, clients] = await Promise.all([
    searchOrders(ctx.db, ctx.access, query, { limit: 8 }),
    clientBook(ctx.db, { search: query, limit: 5 }),
  ]);
  return [
    ...trades.map((t) => ({
      id: t.tradeId,
      kind: 'trade' as const,
      label: `${t.ref} · ${t.clientName}`,
      detail: `${t.direction === 'SELL_USDT' ? 'SELL' : 'BUY'} ${t.base} USDT · ${t.lifecycle}`,
      href: `/orders?trade=${t.tradeId}`,
    })),
    ...clients.map((c) => ({
      id: c.clientId,
      kind: 'client' as const,
      label: c.name,
      detail: `${c.openTrades} open · ${c.completedTrades} completed`,
      href: `/clients/${c.clientId}`,
    })),
  ];
}
