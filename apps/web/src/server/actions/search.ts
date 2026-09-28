'use server';

import { clientBook, findByRef, searchOrders } from '@inrp2p/desk';
import { operatorContext } from '../operator.ts';

export interface SearchHit {
  readonly id: string;
  readonly kind: 'trade' | 'client' | 'request' | 'quote' | 'exception';
  readonly label: string;
  readonly detail: string;
  readonly href: string;
}

/**
 * The command palette's search. It runs as the signed-in operator and returns only what that operator may see — a
 * SUPPORT user searching a UTR finds the trade, without its margin. References match exactly (a trade, a request,
 * a quote, a case), evidence matches exactly (a UTR, a transaction hash), and a client matches from the start of
 * its name: a search never offers a "close enough" record someone might act on by mistake.
 */
export async function searchAction(term: string): Promise<readonly SearchHit[]> {
  const ctx = await operatorContext();
  const query = term.trim();
  if (query.length < 2) return [];
  const [trades, clients, refs] = await Promise.all([
    searchOrders(ctx.db, ctx.access, query, { limit: 8 }),
    clientBook(ctx.db, { search: query, limit: 5 }),
    findByRef(ctx.db, query),
  ]);
  return [
    ...trades.map((t) => ({
      id: t.tradeId,
      kind: 'trade' as const,
      label: `${t.ref} · ${t.clientName}`,
      detail: `${t.direction === 'SELL_USDT' ? 'SELL' : 'BUY'} ${t.base} USDT · ${t.hold ? 'on hold' : t.lifecycle.toLowerCase().replace(/_/g, ' ')}`,
      href: `/orders/${encodeURIComponent(t.ref)}`,
    })),
    ...refs.map((r) => {
      const kind = r.kind === 'REQUEST' ? ('request' as const) : r.kind === 'QUOTE' ? ('quote' as const) : ('exception' as const);
      const href =
        r.kind === 'EXCEPTION'
          ? `/exceptions?case=${r.id}`
          : r.tradeRef
            ? `/orders/${encodeURIComponent(r.tradeRef)}`
            : `/?row=${r.kind === 'REQUEST' ? 'request' : 'quote'}:${r.id}`;
      return { id: r.id, kind, label: `${r.ref}${r.clientName ? ` · ${r.clientName}` : ''}`, detail: `${r.status.toLowerCase().replace(/_/g, ' ')}${r.tradeRef ? ` · ${r.tradeRef}` : ''}`, href };
    }),
    ...clients.map((c) => ({
      id: c.clientId,
      kind: 'client' as const,
      label: c.name,
      detail: `${c.openTrades} open · ${c.completedTrades} completed`,
      href: `/clients/${c.clientId}`,
    })),
  ];
}
