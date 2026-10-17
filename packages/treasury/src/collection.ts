import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';

/**
 * Where a client pays a BUY trade's rupees (ADR 0018): an account of the exchange's that collects, the trade's own
 * payment reference to put in the transfer's remarks, and how long the client has. Fixed when the quote is accepted
 * (`trade_collection`, IX117) — what the client was shown is what the desk checks the credit against.
 */
export const COLLECTION_POLICY = Object.freeze({
  /** How long a client has to pay and say so, before an unpaid trade is cancelled. IMPS and UPI land in seconds. */
  paymentWindowMinutes: 30,
  /** UPI's usual per-payment limit between people: above it, the screen offers bank transfer only. */
  upiMaxInr: '100000.00',
});

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function paymentReference(): string {
  let s = 'P';
  for (let i = 0; i < 7; i += 1) s += CROCKFORD[randomInt(CROCKFORD.length)];
  return s;
}

/**
 * T1 for a BUY: name the account the client pays. The collecting account that took the fewest trades in the last day
 * gets it, so inflows spread over every account the desk opened rather than concentrating on one. No collecting
 * account means no instructions: the trade still opens, and the desk tells the client where to pay, as before.
 */
export async function assignTradeCollection(ctx: TxContext, input: { readonly tradeId: string }): Promise<{ readonly reference: string; readonly inrAccountId: string; readonly payBy: Date } | null> {
  const account = await sql<{ id: string }>`
    select a.id
    from inr_settlement_account a
    where a.status = 'ACTIVE' and a.direction in ('COLLECTION', 'BOTH')
    order by (select count(*) from trade_collection c where c.inr_account_id = a.id and c.created_at > inrp2p_now() - interval '1 day'), a.label, a.id
    limit 1
    for share of a`.execute(ctx.tx);
  const accountId = account.rows[0]?.id;
  if (!accountId) return null;
  for (let attempt = 0; ; attempt += 1) {
    const reference = paymentReference();
    try {
      const row = await ctx.tx
        .insertInto('trade_collection')
        .values({ trade_id: input.tradeId, inr_account_id: accountId, reference, pay_by: sql<Date>`inrp2p_now() + make_interval(mins => ${COLLECTION_POLICY.paymentWindowMinutes})` })
        .returning(['reference', 'inr_account_id', 'pay_by'])
        .executeTakeFirstOrThrow();
      await appendAudit(ctx, { action: 'trade.collection_assigned', entityType: 'trade', entityId: input.tradeId, after: { inr_account_id: row.inr_account_id, reference: row.reference, pay_by: row.pay_by } });
      return { reference: row.reference, inrAccountId: row.inr_account_id, payBy: row.pay_by };
    } catch (e) {
      // 32^7 references: a collision is a once-in-billions event, and the next draw is another.
      if (attempt < 3 && isUniqueViolation(e, 'trade_collection_reference_key')) continue;
      throw e;
    }
  }
}
