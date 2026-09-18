import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { effectiveObligations, legTotals } from '@inrp2p/trades';

/**
 * What the client is allowed to see about settlement (SECURITY S5, FI-62): their own money moving, with the
 * bank reference of each payment. Who funded it — an exchange account or the route — is not their business
 * and never appears here (exit test 11).
 */
export interface ClientSettlementView {
  readonly tradeRef: string;
  readonly status: string;
  readonly expected: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly paid: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly remaining: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly payments: readonly {
    readonly ref: string;
    readonly amount: string;
    readonly status: string;
    readonly reference: string | null;
    readonly confirmedAt: string | null;
  }[];
}

export async function getClientSettlementView(ex: Executor, tradeId: string, clientId: string): Promise<ClientSettlementView> {
  const trade = await ex
    .selectFrom('trade')
    .select(['id', 'ref', 'client_id', 'lifecycle_state', 'hold'])
    .where('id', '=', requireUuid(tradeId, 'tradeId'))
    .executeTakeFirst();
  if (!trade || trade.client_id !== clientId) throw new DomainError('NOT_FOUND', 'trade not found');
  const { payout } = await effectiveObligations(ex, trade.id);
  const totals = await legTotals(ex, trade.id);
  const rows = await sql<{ ref: string; amount_minor: bigint; status: string; utr: string | null; tx_hash: string | null; confirmed_at: Date | null }>`
    select l.ref, l.amount_minor, l.status, f.utr, c.tx_hash, l.confirmed_at
    from settlement_leg l
    left join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null
    left join fiat_transfer f on f.id = a.fiat_transfer_id
    left join crypto_transfer c on c.id = a.crypto_transfer_id
    where l.trade_id = ${trade.id} and l.side = 'EXCHANGE_TO_CLIENT' and l.status in ('PROCESSING', 'COMPLETED')
    order by l.seq`.execute(ex);
  return {
    tradeRef: trade.ref,
    status: trade.hold ? 'ON_HOLD' : trade.lifecycle_state,
    expected: payout.toJSON(),
    paid: Money.ofMinor(totals.paid, payout.currency).toJSON(),
    remaining: Money.ofMinor(payout.minor - totals.paid, payout.currency).toJSON(),
    payments: rows.rows.map((r) => ({
      ref: r.ref,
      amount: Money.ofMinor(r.amount_minor, payout.currency).toDecimalString(),
      status: r.status,
      reference: r.utr ?? r.tx_hash ?? null,
      confirmedAt: r.confirmed_at ? r.confirmed_at.toISOString() : null,
    })),
  };
}

/** Operator-side settlement summary of a trade, including the route side (never shown to a client). */
export async function getDeskSettlementView(ex: Executor, tradeId: string) {
  const { payout, receivable } = await effectiveObligations(ex, tradeId);
  const totals = await legTotals(ex, tradeId);
  const legs = await ex
    .selectFrom('settlement_leg')
    .select(['id', 'ref', 'side', 'asset', 'amount_minor', 'status', 'payer', 'route_id', 'inr_account_id', 'confirmed_at'])
    .where('trade_id', '=', requireUuid(tradeId, 'tradeId'))
    .orderBy('seq')
    .execute();
  return {
    payoutObligation: payout,
    receivableObligation: receivable,
    paid: Money.ofMinor(totals.paid, payout.currency),
    received: Money.ofMinor(totals.received, receivable.currency),
    committed: Money.ofMinor(totals.committed, payout.currency),
    legs,
  };
}
