import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireUuid } from '@inrp2p/kernel';
import { type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';

/**
 * Reserves treasury USDT for a BUY trade delivered by the exchange (`TO_EXCHANGE`) at acceptance (FI-33).
 * Picks the ACTIVE HOT wallet with the most available USDT (observed − reserved) and locks it; over-commitment is
 * refused (`TREASURY_INSUFFICIENT`), never silent. The database re-checks reserved ≤ observed.
 */
export async function reserveTreasuryUsdt(ctx: TxContext, input: { tradeId: string; amount: Money<'USDT'> }): Promise<{ reservationId: string; walletId: string }> {
  const tradeId = requireUuid(input.tradeId, 'tradeId');
  if (input.amount.currency !== 'USDT' || !input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'treasury reservation must be positive USDT');
  assertLockOrder(ctx.tx, 'treasury_wallet');
  const candidates = await sql<{ id: string; observed_balance_minor: bigint; reserved_minor: bigint }>`
    select id, observed_balance_minor, reserved_minor from treasury_wallet
    where network = 'TRON' and role = 'HOT' and status = 'ACTIVE'
    order by id
    for update`.execute(ctx.tx);
  const best = candidates.rows
    .map((w) => ({ ...w, available: w.observed_balance_minor - w.reserved_minor }))
    .sort((a, b) => (a.available === b.available ? a.id.localeCompare(b.id) : a.available > b.available ? -1 : 1))[0];
  if (!best || best.available < input.amount.minor) {
    throw new DomainError('TREASURY_INSUFFICIENT', 'no ACTIVE HOT treasury wallet has enough available USDT', {
      requested: input.amount.minor.toString(), bestAvailable: (best?.available ?? 0n).toString(),
    });
  }
  await ctx.tx.updateTable('treasury_wallet').set({ reserved_minor: best.reserved_minor + input.amount.minor, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', best.id).execute();
  const row = await ctx.tx
    .insertInto('treasury_reservation')
    .values({ treasury_wallet_id: best.id, trade_id: tradeId, amount_minor: input.amount.minor, created_by: ctx.actor.id ?? 'SYSTEM' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'treasury.reserved', entityType: 'treasury_reservation', entityId: row.id, after: { trade_id: tradeId, wallet_id: best.id, amount: input.amount, available_after: Money.ofMinor(best.available - input.amount.minor, 'USDT') } });
  return { reservationId: row.id, walletId: best.id };
}

/** Releases the unconsumed remainder exactly once (state-idempotent). Used by cancellation/completion in Phase 4. */
export async function releaseTreasuryReservation(ctx: TxContext, input: { tradeId: string; reason: 'TRADE_CANCELLED' | 'TRADE_COMPLETED' | 'OPERATOR' }): Promise<{ released: boolean }> {
  const reason = requireOneOf(input.reason, 'reason', ['TRADE_CANCELLED', 'TRADE_COMPLETED', 'OPERATOR'] as const);
  const r = await ctx.tx.selectFrom('treasury_reservation').select(['id', 'treasury_wallet_id']).where('trade_id', '=', requireUuid(input.tradeId, 'tradeId')).executeTakeFirst();
  if (!r) return { released: false };
  assertLockOrder(ctx.tx, 'treasury_wallet');
  const w = await ctx.tx.selectFrom('treasury_wallet').select(['reserved_minor']).where('id', '=', r.treasury_wallet_id).forUpdate().executeTakeFirstOrThrow();
  const res = await ctx.tx.selectFrom('treasury_reservation').selectAll().where('id', '=', r.id).forUpdate().executeTakeFirstOrThrow();
  if (res.status !== 'ACTIVE') return { released: false };
  const remainder = res.amount_minor - res.consumed_minor;
  await ctx.tx.updateTable('treasury_wallet').set({ reserved_minor: w.reserved_minor - remainder, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', r.treasury_wallet_id).execute();
  await ctx.tx.updateTable('treasury_reservation').set({ status: 'RELEASED', released_reason: reason, closed_at: sql<Date>`statement_timestamp()` }).where('id', '=', r.id).execute();
  await appendAudit(ctx, { action: 'treasury.released', entityType: 'treasury_reservation', entityId: r.id, after: { released: Money.ofMinor(remainder, 'USDT'), reason } });
  return { released: true };
}
