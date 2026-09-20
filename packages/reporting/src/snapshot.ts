import { sql } from 'kysely';
import { DomainError, Money, Rate, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { assertClientSafe, maskedDestination } from '@inrp2p/quotes';
import { assertCanonical } from './canonical.ts';

/**
 * The immutable record of a settled trade.
 *
 * Everything a receipt will ever say is in here, as strings, once. Not a view over the rows — a copy of them,
 * taken at completion, because the rows keep moving: a destination gets archived, a client is renamed, an
 * adjustment lands on a later trade. A receipt that followed those would be a different document every time it
 * was opened, which is the opposite of what a receipt is for.
 *
 * It is also client-facing, so it carries no route, margin, payer or provider fact (SECURITY §5, S14): the
 * client sees the UTR of each payment, never who remitted it. `assertClientSafe` checks that before it is
 * written, not only in a test.
 */
export const RECEIPT_SNAPSHOT_VERSION = 1;

export interface ReceiptPayment {
  /** The leg's own reference, so a client can quote one payment out of several. */
  readonly ref: string;
  readonly amount: string;
  readonly currency: 'INR' | 'USDT';
  /** Bank reference in full on the client's own receipt (D-09); a masked one would be useless to their bank. */
  readonly reference: string;
  readonly rail: string | null;
  readonly confirmedAt: string;
}

export interface ReceiptSnapshot {
  readonly schema: string;
  readonly tradeRef: string;
  readonly clientName: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly base: { readonly amount: string; readonly currency: 'USDT' };
  readonly inr: { readonly amount: string; readonly currency: 'INR' };
  readonly clientRate: string;
  readonly network: 'TRON';
  readonly destination: string;
  /** What the client sent us, as the chain or the bank recorded it. Null for a trade funded before this existed. */
  readonly funding: { readonly reference: string; readonly amount: string; readonly currency: 'INR' | 'USDT'; readonly confirmedAt: string } | null;
  readonly payments: readonly ReceiptPayment[];
  readonly totalPaid: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly acceptedAt: string;
  readonly completedAt: string;
  readonly issuer: { readonly name: string };
}

/** The exchange's own name on the document. Fixed in V1; it is who the receipt is from, not a configurable label. */
export const ISSUER_NAME = 'INRP2P Exchange';

/**
 * Builds the snapshot from a **completed** trade. Refuses anything else: a receipt for a trade that is still
 * moving would be a promise, and this document only ever describes what already happened.
 */
export async function buildReceiptSnapshot(ex: Executor, tradeId: string): Promise<ReceiptSnapshot> {
  const id = requireUuid(tradeId, 'tradeId');
  const trade = await ex
    .selectFrom('trade as t')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .innerJoin('client as c', 'c.id', 't.client_id')
    .select([
      't.id', 't.ref', 't.direction', 't.lifecycle_state', 't.opened_at', 't.completed_at',
      'e.base_minor', 'e.quote_inr_minor', 'e.client_rate_micro', 'e.network', 'e.bank_account_id', 'e.crypto_wallet_id',
      'c.display_name',
    ])
    .where('t.id', '=', id)
    .executeTakeFirst();
  if (!trade) throw new DomainError('NOT_FOUND', 'trade not found');
  if (trade.lifecycle_state !== 'COMPLETED' || !trade.completed_at) {
    throw new DomainError('INVALID_TRANSITION', `a receipt describes a completed trade; this one is ${trade.lifecycle_state}`);
  }

  const payoutAsset = trade.direction === 'SELL_USDT' ? ('INR' as const) : ('USDT' as const);
  const fundingAsset = trade.direction === 'SELL_USDT' ? ('USDT' as const) : ('INR' as const);

  // Payments the client actually received, in the order they were made. Only confirmed ones: a leg that failed
  // or was cancelled moved no money, and a receipt that listed it would be wrong in the way that matters most.
  const payments = await sql<{ ref: string; amount_minor: bigint; utr: string | null; rail: string | null; tx_hash: string | null; confirmed_at: Date }>`
    select l.ref, l.amount_minor, f.utr, f.rail, c.tx_hash, l.confirmed_at
    from settlement_leg l
    left join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null
    left join fiat_transfer f on f.id = a.fiat_transfer_id
    left join crypto_transfer c on c.id = a.crypto_transfer_id
    where l.trade_id = ${id} and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'COMPLETED' and l.confirmed_at is not null
    order by l.seq`.execute(ex);

  const funding = await sql<{ amount_minor: bigint; utr: string | null; tx_hash: string | null; confirmed_at: Date | null }>`
    select l.amount_minor, f.utr, c.tx_hash, l.confirmed_at
    from settlement_leg l
    left join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null
    left join fiat_transfer f on f.id = a.fiat_transfer_id
    left join crypto_transfer c on c.id = a.crypto_transfer_id
    where l.trade_id = ${id} and l.side = 'CLIENT_TO_EXCHANGE' and l.status = 'COMPLETED'
    order by l.seq
    limit 1`.execute(ex);
  const first = funding.rows[0];

  const paid = payments.rows.reduce((sum, r) => sum + r.amount_minor, 0n);
  const snapshot: ReceiptSnapshot = {
    schema: `inrp2p.receipt.v${RECEIPT_SNAPSHOT_VERSION}`,
    tradeRef: trade.ref,
    clientName: trade.display_name,
    direction: trade.direction,
    base: Money.ofMinor(trade.base_minor, 'USDT').toJSON(),
    inr: Money.ofMinor(trade.quote_inr_minor, 'INR').toJSON(),
    clientRate: Rate.ofMicro(trade.client_rate_micro, 'CLIENT').toDecimalString(),
    network: trade.network,
    destination: await maskedDestination(ex, trade),
    funding:
      first && first.confirmed_at
        ? {
            reference: first.tx_hash ?? first.utr ?? '',
            amount: Money.ofMinor(first.amount_minor, fundingAsset).toDecimalString(),
            currency: fundingAsset,
            confirmedAt: first.confirmed_at.toISOString(),
          }
        : null,
    payments: payments.rows.map((r) => ({
      ref: r.ref,
      amount: Money.ofMinor(r.amount_minor, payoutAsset).toDecimalString(),
      currency: payoutAsset,
      reference: r.utr ?? r.tx_hash ?? '',
      rail: r.rail,
      confirmedAt: r.confirmed_at.toISOString(),
    })),
    totalPaid: Money.ofMinor(paid, payoutAsset).toJSON(),
    acceptedAt: trade.opened_at.toISOString(),
    completedAt: trade.completed_at.toISOString(),
    issuer: { name: ISSUER_NAME },
  };

  // Two fuses, both before anything is written: nothing of the desk's in a client's document, and nothing in it
  // that cannot be serialized the same way twice.
  assertClientSafe(snapshot);
  assertCanonical(snapshot);
  return snapshot;
}
