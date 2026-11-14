import { sql } from 'kysely';
import { DomainError, Money, type InrRail, requireOneOf, requireText, requireUtrShape, requireUuid } from '@inrp2p/kernel';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';
import { effectiveObligations, lockTrade } from '@inrp2p/trades';
import { recordClientInrInTx } from './firstleg.ts';
import { obligationOfTrade, obligationRemaining } from './obligations.ts';

/**
 * `fiat_in.claim` (ADR 0018) — the client says "I paid": from which of its own registered accounts, over which rail,
 * under which reference. A member of the client who may act (not a viewer), on its own BUY trade that is waiting for
 * its rupees. Nothing counts until its trader has seen the credit and who sent it (ADR 0019).
 *
 * The reference must have its rail's shape — the one moment a typo is cheapest to catch is while the client still has
 * their payment app open.
 */
export function claimIncomingFiat(actor: ClientActor): DomainCommand<{ tradeRef: string; rail: InrRail; utr: string; fromBankAccountId?: string | null; fromUpiId?: string | null; amount?: string | null }, { legRef: string; transferId: string }> {
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
      // The client pays its trader directly — and only once the trader's USDT is in the escrow, final (ADR 0019).
      const e = await ctx.tx.selectFrom('trade_economics').select('route_id').where('trade_id', '=', trade.id).executeTakeFirstOrThrow();
      const obligation = await obligationOfTrade(ctx.tx, trade.id);
      const remaining = await obligationRemaining(ctx.tx, obligation.id);
      if (!remaining.routeDelivers.isZero()) throw new DomainError('ESCROW_NOT_FUNDED', 'wait until the trader’s USDT is in escrow — you will see the account to pay then');
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
      // ADR 0019: a deal's rupees are one payment of the whole amount — its steps, its deadlines and the escrow's
      // release all follow that one payment; a part of it would leave the deal waiting on nothing.
      if (amount.minor !== owed) throw new DomainError('INVALID_AMOUNT', `pay the whole ${Money.ofMinor(owed, 'INR').toDecimalString()} INR in one payment`);

      // From one of its own: a registered bank account, or a verified UPI ID (ADR 0029) — exactly one of the two.
      if (Boolean(p.fromBankAccountId) === Boolean(p.fromUpiId)) {
        throw new DomainError('INVALID_ARGUMENT', 'say which of your own you paid from: a registered bank account or a verified UPI ID', { field: 'fromBankAccountId' });
      }
      const recorded = await recordClientInrInTx(ctx, trade, {
        rail, utr, amount, routeId: e.route_id,
        ...(p.fromBankAccountId ? { payerBankAccountId: requireUuid(p.fromBankAccountId, 'fromBankAccountId') } : { payerUpiId: requireUuid(p.fromUpiId, 'fromUpiId') }),
      });
      await appendAudit(ctx, { action: 'fiat_in.claimed', entityType: 'trade', entityId: trade.id, after: { leg_ref: recorded.ref, rail, utr, amount, from_bank_account_id: p.fromBankAccountId ?? null, from_upi_id: p.fromUpiId ?? null } });
      await enqueueOutbox(ctx, { type: 'desk.client_payment_claimed', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id, legId: recorded.legId } });
      return { legRef: recorded.ref, transferId: recorded.transferId };
    },
  };
}
