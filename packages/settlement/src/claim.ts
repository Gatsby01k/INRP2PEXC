import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, Money, type InrRail, requireOneOf, requireText, requireUtrShape, requireUuid } from '@inrp2p/kernel';
import type { Db, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { executeCommand } from '@inrp2p/commands';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';
import { effectiveObligations, lockTrade } from '@inrp2p/trades';
import { recordClientInrInTx } from './firstleg.ts';
import { cancelTradeInTx } from './cancel.ts';

/**
 * `fiat_in.claim` (ADR 0018) — the client says "I paid": from which of its own registered accounts, over which rail,
 * under which reference. A member of the client who may act (not a viewer), on its own BUY trade that is waiting for
 * its rupees. The claim files the payment exactly as the desk would (`recordClientInrInTx`); nothing counts until the
 * desk has seen the credit and who sent it, and confirmed it (⧗).
 *
 * The reference must have its rail's shape — the one moment a typo is cheapest to catch is while the client still has
 * their payment app open.
 */
export function claimIncomingFiat(actor: ClientActor): DomainCommand<{ tradeRef: string; rail: InrRail; utr: string; fromBankAccountId: string; amount?: string | null }, { legRef: string; transferId: string }> {
  let clientId: string | undefined;
  return {
    authorize: async (ctx, p) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const trade = await ctx.tx.selectFrom('trade').select(['client_id']).where('ref', '=', requireText(p.tradeRef, 'tradeRef', 32)).executeTakeFirst();
      if (!trade) throw new DomainError('NOT_FOUND', 'trade not found');
      // An active member of the trade's own client, signed in to the client product: anyone else learns nothing.
      const member = await ctx.tx
        .selectFrom('client_user as cu')
        .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
        .select(['cu.status', 'u.kind', 'u.status as user_status'])
        .where('cu.user_id', '=', actor.userId)
        .where('cu.client_id', '=', trade.client_id)
        .executeTakeFirst();
      if (!member || member.kind !== 'CLIENT' || member.status !== 'ACTIVE' || member.user_status !== 'ACTIVE') throw new DomainError('NOT_FOUND', 'trade not found');
      clientId = trade.client_id;
    },
    handle: async (ctx, p) => {
      if (!clientId) throw new Error('command executed without authorization');
      const row = await ctx.tx.selectFrom('trade').select(['id']).where('ref', '=', p.tradeRef).where('client_id', '=', clientId).executeTakeFirstOrThrow();
      const trade = await lockTrade(ctx.tx, row.id);
      if (trade.lifecycle_state === 'CANCELLED') throw new DomainError('INVALID_TRANSITION', 'this trade was cancelled — if you paid, the desk returns the money to the account it came from');
      const collection = await ctx.tx.selectFrom('trade_collection').select(['inr_account_id', 'reference']).where('trade_id', '=', trade.id).executeTakeFirst();
      if (!collection) throw new DomainError('NO_COLLECTION', 'the desk tells you where to pay this trade — send them your payment reference');
      const rail = requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const);
      const utr = requireUtrShape(rail, p.utr);

      const { receivable } = await effectiveObligations(ctx.tx, trade.id);
      const counted = await sql<{ total: string }>`
        select coalesce(sum(amount_minor), 0)::text as total from settlement_leg
        where trade_id = ${trade.id} and side = 'CLIENT_TO_EXCHANGE' and status in ('PROCESSING', 'COMPLETED')`.execute(ctx.tx);
      const owed = receivable.minor - BigInt(counted.rows[0]!.total);
      if (owed <= 0n) throw new DomainError('NOTHING_OWED', 'your payment for this trade is already with the desk');
      const amount = p.amount ? Money.parse(p.amount, 'INR') : Money.ofMinor(owed, 'INR');
      if (amount.minor > owed) throw new DomainError('INVALID_AMOUNT', `that is more than the ${Money.ofMinor(owed, 'INR').toDecimalString()} INR still due`);

      const recorded = await recordClientInrInTx(ctx, trade, {
        rail, utr, amount, inrAccountId: collection.inr_account_id, payerBankAccountId: requireUuid(p.fromBankAccountId, 'fromBankAccountId'), filedBy: 'CLIENT',
      });
      await appendAudit(ctx, { action: 'fiat_in.claimed', entityType: 'trade', entityId: trade.id, after: { leg_ref: recorded.ref, rail, utr, amount, from_bank_account_id: p.fromBankAccountId } });
      await enqueueOutbox(ctx, { type: 'desk.client_payment_claimed', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id, legId: recorded.legId } });
      return { legRef: recorded.ref, transferId: recorded.transferId };
    },
  };
}

/**
 * The payment window (ADR 0018): a BUY trade whose client neither paid nor said so by its `pay_by` is cancelled by the
 * system, exactly as the desk would cancel it — everything released, the acceptance reversed, the client told. A trade
 * with any payment filed is never touched: that one waits for a person.
 */
export async function expireUnpaidTrades(db: Db, limit = 50): Promise<{ readonly cancelled: number; readonly failures: readonly { tradeId: string; message: string }[] }> {
  const due = await sql<{ trade_id: string }>`
    select c.trade_id
    from trade_collection c
    join trade t on t.id = c.trade_id
    where c.pay_by < inrp2p_now()
      and t.lifecycle_state = 'AWAITING_FIRST_LEG'
      and not t.hold
      and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'CLIENT_TO_EXCHANGE')
    order by c.pay_by
    limit ${limit}`.execute(db);
  let cancelled = 0;
  const failures: { tradeId: string; message: string }[] = [];
  // One trade per transaction: one that cannot be cancelled never keeps the others waiting.
  for (const d of due.rows) {
    const key = randomUUID();
    try {
      const out = await executeCommand(db, {
        authorize: async () => {},
        handle: async (ctx: TxContext) => {
          const trade = await lockTrade(ctx.tx, d.trade_id);
          // Looked at again under the lock: the client may have just said they paid.
          const legs = await ctx.tx.selectFrom('settlement_leg').select('id').where('trade_id', '=', trade.id).where('side', '=', 'CLIENT_TO_EXCHANGE').executeTakeFirst();
          if (trade.lifecycle_state !== 'AWAITING_FIRST_LEG' || trade.hold || legs) return false;
          await cancelTradeInTx(ctx, { trade, reason: 'not paid within the payment window', expiredUnpaid: true });
          return true;
        },
      }, { name: 'trade.expire_unpaid', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { run: key }, idempotencyKey: key, financial: true });
      if (out.result) cancelled += 1;
    } catch (e) {
      failures.push({ tradeId: d.trade_id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { cancelled, failures };
}
