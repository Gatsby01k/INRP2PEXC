import { DomainError, Money, Rate, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';

/**
 * Client-facing trade shape (SECURITY S5, S14). The ONLY trade shape a client API or link page may serialize:
 * no route, route rate, margin, provider, execution mode, obligation or internal ids beyond the trade ref.
 */
export interface ClientTradeView {
  readonly ref: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly status: 'AWAITING_FIRST_LEG' | 'FIRST_LEG_DETECTED' | 'FIRST_LEG_CONFIRMED' | 'SETTLING' | 'PARTIALLY_SETTLED' | 'COMPLETED' | 'CANCELLED';
  readonly base: { readonly amount: string; readonly currency: 'USDT' };
  readonly inr: { readonly amount: string; readonly currency: 'INR' };
  readonly clientRate: string;
  readonly network: 'TRON';
  readonly openedAt: string;
  /** SELL only: the trade's unique deposit address and the exact amount to send (D-02). */
  readonly depositInstructions: { readonly address: string; readonly amount: string; readonly network: 'TRON' } | null;
}

export async function getClientTradeView(ex: Executor, tradeId: string, clientId: string): Promise<ClientTradeView> {
  const row = await ex
    .selectFrom('trade as t')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .leftJoin('deposit_assignment as a', 'a.trade_id', 't.id')
    .leftJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['t.ref', 't.direction', 't.lifecycle_state', 't.opened_at', 't.client_id', 'e.base_minor', 'e.quote_inr_minor', 'e.client_rate_micro', 'e.network', 'd.address', 'a.expected_amount_minor'])
    .where('t.id', '=', requireUuid(tradeId, 'tradeId'))
    .executeTakeFirst();
  if (!row || row.client_id !== clientId) throw new DomainError('NOT_FOUND', 'trade not found');
  return toClientTradeView(row);
}

export function toClientTradeView(row: {
  ref: string; direction: 'SELL_USDT' | 'BUY_USDT'; lifecycle_state: ClientTradeView['status']; opened_at: Date; base_minor: bigint; quote_inr_minor: bigint;
  client_rate_micro: bigint; network: 'TRON'; address: string | null; expected_amount_minor: bigint | null;
}): ClientTradeView {
  return {
    ref: row.ref,
    direction: row.direction,
    status: row.lifecycle_state,
    base: Money.ofMinor(row.base_minor, 'USDT').toJSON(),
    inr: Money.ofMinor(row.quote_inr_minor, 'INR').toJSON(),
    clientRate: Rate.ofMicro(row.client_rate_micro, 'CLIENT').toDecimalString(),
    network: row.network,
    openedAt: row.opened_at.toISOString(),
    depositInstructions: row.direction === 'SELL_USDT' && row.address && row.expected_amount_minor !== null
      ? { address: row.address, amount: Money.ofMinor(row.expected_amount_minor, 'USDT').toDecimalString(), network: row.network }
      : null,
  };
}
