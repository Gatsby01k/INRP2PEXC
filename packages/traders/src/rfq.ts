import { sql } from 'kysely';
import { DomainError, Money, Rate, divRound, requireText } from '@inrp2p/kernel';
import type { Executor, TraderSide } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor } from '@inrp2p/identity';
import { freeCapacity, lockTraderOfClient, readBlocks, readStanding, standingIssues, traderClientCommand } from '@inrp2p/trader-core';

/**
 * A trader's side of a price request (ADR 0025): INRP2P asks a few traders for their rate on one amount no firm offer
 * covers, and the best bid — by the same expected margin as any price — becomes the client's firm price. The trader sees
 * the side, the amount and when it closes; never who asks. A bid is firm until the request is awarded: the winner's order
 * is opened and accepted on it, with its capacity held then (not before, so a bid never holds capacity twice).
 */
export interface PriceAskView {
  readonly ref: string;
  /** The trader's side: buying USDT (it pays rupees) or selling it (it delivers USDT). */
  readonly side: TraderSide;
  /** The amount as it was asked: USDT, or rupees. */
  readonly amount: string;
  readonly currency: 'USDT' | 'INR';
  readonly closesAt: string;
  /** This trader's live bid, if it placed one. */
  readonly yourRate: string | null;
}

const sideFor = (direction: 'SELL_USDT' | 'BUY_USDT'): TraderSide => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');

/** The price requests this trader was asked to bid on and that are still open, soonest to close first. */
export async function priceAsksFor(ex: Executor, traderId: string): Promise<PriceAskView[]> {
  const r = await sql<{ ref: string; direction: 'SELL_USDT' | 'BUY_USDT'; fixed_side: 'BASE' | 'QUOTE'; requested_base_minor: bigint | null; requested_quote_minor: bigint | null; closes_at: Date; bid: bigint | null }>`
    select q.ref, q.direction, r.fixed_side, r.requested_base_minor, r.requested_quote_minor, q.closes_at,
           (select b.rate_micro from rfq_bid b where b.rfq_id = q.id and b.trader_id = i.trader_id and b.status = 'LIVE') as bid
      from rfq_invite i
      join rfq q on q.id = i.rfq_id
      join trade_request r on r.id = q.trade_request_id
     where i.trader_id = ${traderId} and q.status = 'OPEN' and q.closes_at > inrp2p_now() and r.status = 'OPEN'
     order by q.closes_at`.execute(ex);
  return r.rows.map((row) => ({
    ref: row.ref,
    side: sideFor(row.direction),
    amount: row.fixed_side === 'BASE' ? Money.ofMinor(BigInt(row.requested_base_minor!), 'USDT').toDecimalString() : Money.ofMinor(BigInt(row.requested_quote_minor!), 'INR').toDecimalString(),
    currency: row.fixed_side === 'BASE' ? 'USDT' : 'INR',
    closesAt: row.closes_at.toISOString(),
    yourRate: row.bid === null ? null : Rate.ofMicro(BigInt(row.bid), 'ROUTE').toDecimalString(),
  }));
}

/**
 * `rfq.bid` — a user who can commit for the trader, while the price request is open. The rate is for the whole amount and
 * firm until the request is awarded; bidding again replaces the earlier bid. The trader must be in standing, and the amount
 * must fit INRP2P's ceiling on one order and what its side has free now — capacity is held only if the bid wins, and checked
 * again then. The database refuses a bid after the request closes (IX139).
 */
export function bidOnRfq(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; rate: string }, member) => {
    const trader = await lockTraderOfClient(ctx, member.clientId);
    const ask = await ctx.tx
      .selectFrom('rfq as q')
      .innerJoin('rfq_invite as i', 'i.rfq_id', 'q.id')
      .innerJoin('trade_request as r', 'r.id', 'q.trade_request_id')
      .select(['q.id', 'q.ref', 'q.status', 'q.closes_at', 'q.direction', 'i.block_id', 'r.status as request_status', 'r.fixed_side', 'r.requested_base_minor', 'r.requested_quote_minor'])
      .where('q.ref', '=', requireText(p.ref, 'ref', 32))
      .where('i.trader_id', '=', trader.id)
      .executeTakeFirst();
    if (!ask) throw new DomainError('NOT_FOUND', 'price request not found');
    const now = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ctx.tx)).rows[0]!.now;
    if (ask.status !== 'OPEN' || now >= ask.closes_at || ask.request_status !== 'OPEN') throw new DomainError('INVALID_TRANSITION', 'this price request has closed');
    const { standing } = await readStanding(ctx.tx, trader.id);
    const issues = standingIssues(standing);
    if (issues.length > 0) throw new DomainError('TRADER_NOT_ELIGIBLE', 'you cannot take orders right now', { issues });
    const rate = Rate.parse(p.rate, 'ROUTE');

    // What the order would hold at this rate: the rupees a buyer of USDT pays, at most the amount at its own rate; the USDT
    // a seller delivers, at least the client's (the client's price, not known yet, only adds to it).
    const block = (await readBlocks(ctx.tx, trader.id)).find((b) => b.id === ask.block_id);
    if (!block || block.status !== 'ACTIVE') throw new DomainError('TRADER_NOT_ELIGIBLE', 'this side is paused', { issues: ['BLOCK_PAUSED'] });
    const buying = block.side === 'BUY_USDT';
    const base = ask.requested_base_minor;
    const inr = ask.requested_quote_minor;
    const holds = buying
      ? (ask.fixed_side === 'QUOTE' ? inr! : divRound(base! * rate.micro, 10_000_000_000n, 'DOWN'))
      : (ask.fixed_side === 'BASE' ? base! : divRound(inr! * 10_000_000_000n, rate.micro, 'UP'));
    const currency = buying ? 'INR' : 'USDT';
    const fmt = (m: bigint) => Money.ofMinor(m, currency).toDecimalString();
    if (block.operatorMaxOrderMinor !== null && holds > block.operatorMaxOrderMinor) {
      throw new DomainError('TRADER_LIMIT_EXCEEDED', `INRP2P limits one order to ${fmt(block.operatorMaxOrderMinor)} ${currency}`);
    }
    const free = freeCapacity(block);
    if (holds > free) throw new DomainError('CAPACITY_INSUFFICIENT', `this needs ${fmt(holds)} ${currency} and your side has ${fmt(free)} available: raise its capacity to bid`, { available: fmt(free) });

    const replaced = await ctx.tx.updateTable('rfq_bid').set({ status: 'REPLACED' }).where('rfq_id', '=', ask.id).where('trader_id', '=', trader.id).where('status', '=', 'LIVE').returning(['rate_micro']).executeTakeFirst();
    const bid = await ctx.tx.insertInto('rfq_bid').values({ rfq_id: ask.id, trader_id: trader.id, rate_micro: rate.micro, placed_by: member.userId }).returning(['id']).executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'rfq.bid_placed', entityType: 'rfq_bid', entityId: bid.id,
      before: replaced ? { rate: Rate.ofMicro(replaced.rate_micro, 'ROUTE') } : null,
      after: { rfq_id: ask.id, trader_id: trader.id, rate, holds: fmt(holds), currency },
    });
    await enqueueOutbox(ctx, { type: 'rfq.bid_placed', aggregateType: 'rfq', aggregateId: ask.id, payload: { rfqId: ask.id, traderId: trader.id } });
    return { ref: ask.ref, rate: rate.toDecimalString(), replaced: replaced !== undefined };
  });
}
