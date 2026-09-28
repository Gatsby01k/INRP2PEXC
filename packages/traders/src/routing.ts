import { sql } from 'kysely';
import { DomainError, Money, Rate, computeTradeEconomics, requireUuid } from '@inrp2p/kernel';
import { type DirectionValue, type FixedSideValue, type TraderSide, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { type FitIssue, type StandingIssue, freeCapacity, orderFit, standingIssues } from './eligibility.ts';
import { traderProgram } from '@inrp2p/trader-core';
import { readBlocks, readStanding } from './standing.ts';

/** The trader side that fills a client request: a client selling USDT needs a trader buying it, and vice versa. */
export const sideForDirection = (direction: DirectionValue): TraderSide => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');
export const directionForSide = (side: TraderSide): DirectionValue => (side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT');

export interface Candidate {
  readonly traderId: string;
  readonly traderRef: string;
  readonly blockId: string;
  readonly routeId: string;
  readonly rateMicro: bigint;
  /** Capacity the block could still promise, in its own currency. */
  readonly freeMinor: bigint;
  /** Orders accepted or in progress. */
  readonly openOrders: number;
  readonly completedOrders: number;
}

/**
 * The routing order (V1, deterministic): the best rate for the exchange first — for a client selling USDT the trader
 * paying the most INR per USDT, for a client buying USDT the one asking the least — then the most capacity left,
 * then the least current exposure, then the longest completion history, and finally the trader reference, so the
 * same inputs always pick the same trader. Eligibility is decided before ranking and is not a ranking factor.
 */
export function rankCandidates(direction: DirectionValue, candidates: readonly Candidate[]): Candidate[] {
  const better = direction === 'SELL_USDT' ? 1n : -1n;
  return [...candidates].sort((a, b) => {
    if (a.rateMicro !== b.rateMicro) return (b.rateMicro - a.rateMicro) * better > 0n ? 1 : -1;
    if (a.freeMinor !== b.freeMinor) return b.freeMinor > a.freeMinor ? 1 : -1;
    if (a.openOrders !== b.openOrders) return a.openOrders - b.openOrders;
    if (a.completedOrders !== b.completedOrders) return b.completedOrders - a.completedOrders;
    return a.traderRef < b.traderRef ? -1 : a.traderRef > b.traderRef ? 1 : 0;
  });
}

export interface SizedOrder {
  readonly baseMinor: bigint;
  /** INR at the trader's rate — what a Buy USDT trader pays, or what a Sell USDT trader is paid. */
  readonly inrMinor: bigint;
}

/**
 * The order's terms at one trader's rate, with the kernel's own economics — the same function the quote will use,
 * so the quote on an accepted order prices exactly what the trader accepted (the database checks they agree).
 *
 * A USDT-fixed request needs nothing else. An INR-fixed request needs the client rate the desk intends to quote,
 * because the USDT amount follows from it.
 */
export function sizeOrder(input: { direction: DirectionValue; fixedSide: FixedSideValue; requestedMinor: bigint; traderRateMicro: bigint; plannedClientRateMicro: bigint | null }): SizedOrder {
  const routeRate = Rate.ofMicro(input.traderRateMicro, 'ROUTE');
  if (input.fixedSide === 'BASE') {
    const econ = computeTradeEconomics({
      direction: input.direction, fixedSide: 'BASE', amount: Money.ofMinor(input.requestedMinor, 'USDT'),
      clientRate: Rate.ofMicro(input.traderRateMicro, 'CLIENT'), routeRate,
    });
    return { baseMinor: econ.base.minor, inrMinor: econ.routeInr.minor };
  }
  if (input.plannedClientRateMicro === null) throw new DomainError('INVALID_ARGUMENT', 'an INR-fixed request needs the client rate you intend to quote', { field: 'plannedClientRate' });
  const econ = computeTradeEconomics({
    direction: input.direction, fixedSide: 'QUOTE', amount: Money.ofMinor(input.requestedMinor, 'INR'),
    clientRate: Rate.ofMicro(input.plannedClientRateMicro, 'CLIENT'), routeRate,
  });
  return { baseMinor: econ.base.minor, inrMinor: econ.routeInr.minor };
}

export type Exclusion = StandingIssue | FitIssue | 'NO_SIDE' | 'ALREADY_OFFERED' | 'OWN_REQUEST';

export interface AssignResult {
  readonly orderId: string;
  readonly ref: string;
  readonly traderRef: string;
  readonly rate: string;
  readonly base: string;
  readonly inr: string;
  readonly offerExpiresAt: string;
}

/** What routing saw, for the desk: how many traders were considered and why each one was left out. */
export interface RoutingMiss {
  readonly considered: number;
  readonly excluded: Readonly<Partial<Record<Exclusion, number>>>;
}

interface RequestRow {
  id: string;
  ref: string;
  client_id: string;
  status: string;
  direction: DirectionValue;
  fixed_side: FixedSideValue;
  requested_base_minor: bigint | null;
  requested_quote_minor: bigint | null;
}

async function lockRequest(ctx: TxContext, requestId: string): Promise<RequestRow> {
  assertLockOrder(ctx.tx, 'trade_request');
  const r = await sql<RequestRow>`
    select id, ref, client_id, status, direction, fixed_side, requested_base_minor, requested_quote_minor
    from trade_request where id = ${requireUuid(requestId, 'requestId')} for update`.execute(ctx.tx);
  const row = r.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'request not found');
  return row;
}

/**
 * Picks the trader for one request and offers it the order. Everything is read in this transaction under the
 * request lock, so two assignments of the same request cannot both succeed (the database also allows only one live
 * order per request). Nothing is held yet: capacity is reserved when the trader accepts, under its own locks.
 */
export async function assignRequestInTx(
  ctx: TxContext,
  input: { requestId: string; plannedClientRateMicro: bigint | null; offeredBy: string },
): Promise<{ assigned: AssignResult } | { miss: RoutingMiss }> {
  const request = await lockRequest(ctx, input.requestId);
  if (request.status !== 'OPEN' && request.status !== 'QUOTED') throw new DomainError('REQUEST_NOT_OPEN', `request is ${request.status}`);
  const live = await ctx.tx.selectFrom('trader_order').select('ref').where('trade_request_id', '=', request.id).where('status', 'in', ['OFFERED', 'ACCEPTED']).executeTakeFirst();
  if (live) throw new DomainError('TRADER_ORDER_NOT_LIVE', `request ${request.ref} is already with a trader (${live.ref})`);
  const side = sideForDirection(request.direction);
  const requestedMinor = (request.fixed_side === 'BASE' ? request.requested_base_minor : request.requested_quote_minor)!;
  const program = await traderProgram(ctx.tx);

  // A trader that already declined this request, or let the offer lapse, is not asked again.
  const tried = await ctx.tx.selectFrom('trader_order').select('trader_id').where('trade_request_id', '=', request.id).where('status', 'in', ['DECLINED', 'EXPIRED']).execute();
  const triedIds = new Set(tried.map((t) => t.trader_id));

  const traders = await sql<{ id: string; ref: string; client_id: string; open: string; completed: string }>`
    select t.id, t.ref, t.client_id,
           (select count(*) from trader_order o where o.trader_id = t.id and o.status in ('ACCEPTED', 'IN_PROGRESS'))::text as open,
           (select count(*) from trader_order o where o.trader_id = t.id and o.status = 'COMPLETED')::text as completed
    from trader_profile t
    where t.status in ('APPROVED', 'PAUSED')
    order by t.ref`.execute(ctx.tx);

  const excluded: Partial<Record<Exclusion, number>> = {};
  const exclude = (why: Exclusion) => {
    excluded[why] = (excluded[why] ?? 0) + 1;
  };
  const candidates: (Candidate & { sized: SizedOrder })[] = [];
  for (const t of traders.rows) {
    if (t.client_id === request.client_id) {
      exclude('OWN_REQUEST');
      continue;
    }
    if (triedIds.has(t.id)) {
      exclude('ALREADY_OFFERED');
      continue;
    }
    const { standing } = await readStanding(ctx.tx, t.id);
    const issues = standingIssues(standing);
    if (issues.length > 0) {
      exclude(issues[0]!);
      continue;
    }
    const block = (await readBlocks(ctx.tx, t.id)).find((b) => b.side === side);
    if (!block) {
      exclude('NO_SIDE');
      continue;
    }
    if (block.rateMicro === null) {
      exclude('NO_RATE');
      continue;
    }
    let sized: SizedOrder;
    try {
      sized = sizeOrder({ direction: request.direction, fixedSide: request.fixed_side, requestedMinor, traderRateMicro: block.rateMicro, plannedClientRateMicro: input.plannedClientRateMicro });
    } catch (e) {
      if (e instanceof DomainError && e.code === 'INVALID_AMOUNT') {
        exclude('BELOW_MINIMUM');
        continue;
      }
      throw e;
    }
    const amount = side === 'BUY_USDT' ? sized.inrMinor : sized.baseMinor;
    const fit = orderFit(block, amount);
    if (fit) {
      exclude(fit);
      continue;
    }
    candidates.push({
      traderId: t.id, traderRef: t.ref, blockId: block.id, routeId: block.routeId, rateMicro: block.rateMicro,
      freeMinor: freeCapacity(block), openOrders: Number.parseInt(t.open, 10), completedOrders: Number.parseInt(t.completed, 10), sized,
    });
  }

  const ranked = rankCandidates(request.direction, candidates);
  const chosen = ranked[0] as (Candidate & { sized: SizedOrder }) | undefined;
  if (!chosen) {
    await appendAudit(ctx, { action: 'trader_order.no_trader', entityType: 'trade_request', entityId: request.id, after: { considered: traders.rows.length, excluded } });
    return { miss: { considered: traders.rows.length, excluded } };
  }

  const capacityMinor = side === 'BUY_USDT' ? chosen.sized.inrMinor : chosen.sized.baseMinor;
  const row = await ctx.tx
    .insertInto('trader_order')
    .values({
      trader_id: chosen.traderId,
      block_id: chosen.blockId,
      route_id: chosen.routeId,
      trade_request_id: request.id,
      side,
      base_minor: chosen.sized.baseMinor,
      inr_minor: chosen.sized.inrMinor,
      rate_micro: chosen.rateMicro,
      capacity_minor: capacityMinor,
      planned_client_rate_micro: request.fixed_side === 'QUOTE' ? input.plannedClientRateMicro : null,
      offered_by: input.offeredBy,
      offer_expires_at: sql<Date>`inrp2p_now() + make_interval(secs => ${program.offerTtlSeconds})`,
    })
    .returning(['id', 'ref', 'offer_expires_at'])
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'trader_order.offered', entityType: 'trader_order', entityId: row.id,
    after: {
      ref: row.ref, request_id: request.id, trader_id: chosen.traderId, side, base: Money.ofMinor(chosen.sized.baseMinor, 'USDT'), inr: Money.ofMinor(chosen.sized.inrMinor, 'INR'),
      rate: Rate.ofMicro(chosen.rateMicro, 'ROUTE'), considered: traders.rows.length, eligible: ranked.length, excluded, offer_expires_at: row.offer_expires_at,
    },
  });
  await enqueueOutbox(ctx, { type: 'trader.order_offered', aggregateType: 'trader_order', aggregateId: row.id, payload: { orderId: row.id, traderId: chosen.traderId, requestId: request.id } });
  return {
    assigned: {
      orderId: row.id,
      ref: row.ref,
      traderRef: chosen.traderRef,
      rate: Rate.ofMicro(chosen.rateMicro, 'ROUTE').toDecimalString(),
      base: Money.ofMinor(chosen.sized.baseMinor, 'USDT').toDecimalString(),
      inr: Money.ofMinor(chosen.sized.inrMinor, 'INR').toDecimalString(),
      offerExpiresAt: row.offer_expires_at.toISOString(),
    },
  };
}

/**
 * `trader_order.assign` — `traders:assign`. The desk routes a request to the best eligible trader. For an
 * INR-fixed request it names the client rate it intends to quote, because the order's USDT follows from it.
 * When nobody is eligible, the refusal says why each trader was left out.
 */
export function assignRequest(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:assign', async (ctx, p: { requestId: string; plannedClientRate?: string | null }) => {
    const planned = p.plannedClientRate ? Rate.parse(p.plannedClientRate, 'CLIENT').micro : null;
    const out = await assignRequestInTx(ctx, { requestId: p.requestId, plannedClientRateMicro: planned, offeredBy: ctx.actor.id ?? 'SYSTEM' });
    if ('miss' in out) throw new DomainError('TRADER_NONE_ELIGIBLE', 'no trader can take this order right now', { considered: out.miss.considered, excluded: out.miss.excluded });
    return out.assigned;
  });
}

/**
 * System step after an offer is declined, lapses or is withdrawn: the request goes to the next eligible trader, at
 * the same planned client rate, unless it is closed, already with a trader, or nobody is left. Never throws for
 * "nobody": the desk sees the request back in its queue instead.
 */
export async function rerouteRequestInTx(ctx: TxContext, requestId: string): Promise<AssignResult | null> {
  const request = await ctx.tx.selectFrom('trade_request').select(['status']).where('id', '=', requireUuid(requestId, 'requestId')).executeTakeFirst();
  if (!request || (request.status !== 'OPEN' && request.status !== 'QUOTED')) return null;
  const live = await ctx.tx.selectFrom('trader_order').select('id').where('trade_request_id', '=', requestId).where('status', 'in', ['OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED']).executeTakeFirst();
  if (live) return null;
  const last = await ctx.tx.selectFrom('trader_order').select(['planned_client_rate_micro']).where('trade_request_id', '=', requestId).orderBy('offered_at', 'desc').executeTakeFirst();
  const out = await assignRequestInTx(ctx, { requestId, plannedClientRateMicro: last?.planned_client_rate_micro ?? null, offeredBy: `SYSTEM:${ctx.commandName}` });
  return 'assigned' in out ? out.assigned : null;
}

/**
 * System step for a new request when the programme routes automatically: a USDT-fixed request (the order's size
 * is known without a client rate) goes straight to the best eligible trader. INR-fixed requests wait for the desk.
 */
export async function autoAssignInTx(ctx: TxContext, requestId: string): Promise<AssignResult | null> {
  const program = await traderProgram(ctx.tx);
  if (!program.autoAssign) return null;
  const request = await ctx.tx.selectFrom('trade_request').select(['status', 'fixed_side']).where('id', '=', requireUuid(requestId, 'requestId')).executeTakeFirst();
  if (!request || request.status !== 'OPEN' || request.fixed_side !== 'BASE') return null;
  const live = await ctx.tx.selectFrom('trader_order').select('id').where('trade_request_id', '=', requestId).executeTakeFirst();
  if (live) return null;
  const out = await assignRequestInTx(ctx, { requestId, plannedClientRateMicro: null, offeredBy: `SYSTEM:${ctx.commandName}` });
  return 'assigned' in out ? out.assigned : null;
}
