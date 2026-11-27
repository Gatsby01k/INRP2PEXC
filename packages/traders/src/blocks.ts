import { sql } from 'kysely';
import { DomainError, Money, Rate, assertMarketOffset, requireOneOf } from '@inrp2p/kernel';
import type { InrRailValue, TraderSide } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor } from '@inrp2p/identity';
import { publishTraderRate } from '@inrp2p/pricing';
import { lockTraderOfClient, traderClientCommand, lockBlock, withdrawOffers } from '@inrp2p/trader-core';
import { switchOnIssues } from '@inrp2p/trader-core';
import { readStanding } from '@inrp2p/trader-core';

const ISSUE_TEXT: Record<string, string> = {
  NOT_APPROVED: 'your application has not been approved yet',
  PAUSED: 'your trader account is paused by INRP2P',
  RESERVE_NOT_SET: 'the Security Reserve has not been set',
  RESERVE_SHORT: 'your Security Reserve is below the required amount',
  DESTINATIONS_INACTIVE: 'your registered bank account or wallet is no longer active',
};

/**
 * `trader.set_availability` — a user who can commit. Switching on makes the trader available for matching; it
 * needs an approved account, a funded Security Reserve and active registered settlement details. Switching off
 * stops new assignments at once and withdraws offers not yet answered; orders already accepted or in progress
 * carry on, and the reserve stays locked until the last of them has finished.
 */
export function setAvailability(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { available: boolean }, member) => {
    const on = p.available === true;
    const trader = await lockTraderOfClient(ctx, member.clientId);
    if (trader.available === on) return { available: on, changed: false, offersWithdrawn: 0 };
    let withdrawn = 0;
    if (on) {
      const { standing } = await readStanding(ctx.tx, trader.id);
      const issues = switchOnIssues(standing);
      if (issues.length > 0) {
        const first = issues[0]!;
        throw new DomainError(first === 'RESERVE_SHORT' || first === 'RESERVE_NOT_SET' ? 'TRADER_RESERVE_SHORT' : first === 'PAUSED' ? 'TRADER_PAUSED' : first === 'DESTINATIONS_INACTIVE' ? 'TRADER_DESTINATION_INVALID' : 'TRADER_NOT_APPROVED', `You cannot switch on: ${ISSUE_TEXT[first] ?? first}.`, { issues });
      }
    } else {
      withdrawn = await withdrawOffers(ctx, { traderId: trader.id }, 'TRADER_OFFLINE');
    }
    await ctx.tx.updateTable('trader_profile').set({ available: on, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 }).where('id', '=', trader.id).execute();
    await appendAudit(ctx, { action: 'trader.availability_changed', entityType: 'trader_profile', entityId: trader.id, before: { available: trader.available }, after: { available: on, offers_withdrawn: withdrawn } });
    // ADR 0033 §2.7: a trader coming online may price a waiting client now, not on the next minute.
    if (on) await enqueueOutbox(ctx, { type: 'waiting.look_now', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { direction: null } });
    return { available: on, changed: true, offersWithdrawn: withdrawn };
  });
}

export interface UpdateBlockPayload {
  readonly side: TraderSide;
  readonly expectedVersion: number;
  /** Decimal in the block's currency: INR for Buy USDT, USDT for Sell USDT. */
  readonly capacity?: string;
  /** Fixed rate, INR per USDT — the side's own number, when its rate basis is FIXED. */
  readonly rate?: string;
  /**
   * ADR 0028: whether the side's rate is its own number (`FIXED`, `rate`) or set against the market (`MARKET`): the confirmed
   * reference of the deals it fills — the bid for a side buying USDT, the ask for one selling — moved by `marketOffsetBps`
   * (whole basis points, within ten percent either way) and never past `rateLimit`. Omitted leaves each as it is.
   */
  readonly rateBasis?: 'FIXED' | 'MARKET';
  readonly marketOffsetBps?: number;
  /** A side selling USDT never sells below it, one buying never buys above it; null clears it. */
  readonly rateLimit?: string | null;
  readonly minOrder?: string;
  readonly maxOrder?: string;
  readonly status?: 'ACTIVE' | 'PAUSED';
  /**
   * ADR 0025: make this side's offer firm for this many hours (1–168) from now — INRP2P then fills orders at its rate,
   * within its limits, without asking — or 0 to stop. Omitted leaves it as it is.
   */
  readonly firmHours?: number;
  /** ADR 0028: on a market rate, make this side's offer firm until the trader turns it off (`firmHours: 0`). */
  readonly firmOpenEnded?: boolean;
  /** The INR rails this side pays or is paid by; at least one. */
  readonly rails?: readonly InrRailValue[];
}

const RAILS: readonly InrRailValue[] = ['UPI', 'IMPS', 'NEFT', 'RTGS'];

/**
 * `trader.update_block` — a user who can commit. The trader's own terms for one side: how much it can provide,
 * its rate, and the order size it takes. Capacity never goes below what open orders already hold, and never
 * above the operator's ceiling. A new fixed rate is published as the trader route's rate at once (source TRADER), and
 * any offer made on the old terms is withdrawn — an offer is always at a rate the trader currently stands behind.
 *
 * ADR 0028: the rate may instead be set against the market. It is then the trader's standing instruction — an offset from
 * the confirmed reference of the deals the side fills, and a bound it never goes past — and the only way a route rate is
 * ever derived from a reference (FI-01): applied to a reference fresh enough to price on, recorded with every order it
 * gives a rate to (IX143). A market rate never goes stale, so only it may be firm until the trader turns it off.
 */
export function updateBlock(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: UpdateBlockPayload, member) => {
    const side = requireOneOf(p.side, 'side', ['BUY_USDT', 'SELL_USDT'] as const);
    const currency = side === 'BUY_USDT' ? 'INR' : 'USDT';
    const trader = await lockTraderOfClient(ctx, member.clientId);
    if (trader.status !== 'APPROVED' && trader.status !== 'PAUSED') throw new DomainError('TRADER_NOT_APPROVED', 'your application has not been approved yet');
    const peek = await ctx.tx.selectFrom('trader_block').select(['id', 'rate_micro', 'rate_basis', 'market_offset_bps', 'rate_limit_micro', 'version'])
      .where('trader_id', '=', trader.id).where('side', '=', side).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', `you are not set up to ${side === 'BUY_USDT' ? 'buy' : 'sell'} USDT`);
    if (peek.version !== p.expectedVersion) throw new DomainError('STALE_VERSION', 'these settings changed since you opened them; reload and try again');

    // The rate terms as they will be: the side's own number, or an offset from the market and a bound.
    const basis = p.rateBasis === undefined ? peek.rate_basis : requireOneOf(p.rateBasis, 'rateBasis', ['FIXED', 'MARKET'] as const);
    const rate = p.rate !== undefined ? Rate.parse(p.rate, 'ROUTE') : null;
    if (rate !== null && rate.micro <= 0n) throw new DomainError('INVALID_RATE', 'the rate must be positive', { field: 'rate' });
    if (basis === 'MARKET' && rate !== null) throw new DomainError('INVALID_ARGUMENT', 'a rate set against the market has no number of its own: set its offset instead', { field: 'rate' });
    const nextRate = basis === 'FIXED' ? (rate?.micro ?? (peek.rate_basis === 'FIXED' ? peek.rate_micro : null)) : null;
    let offset: number | null = null;
    let limit: bigint | null = null;
    if (basis === 'MARKET') {
      offset = p.marketOffsetBps === undefined ? peek.market_offset_bps : p.marketOffsetBps;
      if (offset === null) throw new DomainError('INVALID_ARGUMENT', 'set how far from the market this side’s rate is', { field: 'marketOffset' });
      assertMarketOffset(offset);
      if (p.rateLimit === undefined) limit = peek.rate_basis === 'MARKET' ? peek.rate_limit_micro : null;
      else if (p.rateLimit !== null && p.rateLimit !== '') {
        limit = Rate.parse(p.rateLimit, 'ROUTE').micro;
        if (limit <= 0n) throw new DomainError('INVALID_RATE', 'the rate limit must be positive', { field: 'rateLimit' });
      }
    }
    const termsChanged = basis !== peek.rate_basis || nextRate !== peek.rate_micro || offset !== peek.market_offset_bps || limit !== peek.rate_limit_micro;
    const rateChanged = basis === 'FIXED' && rate !== null && rate.micro !== peek.rate_micro;
    // Offers on the old terms are withdrawn before the block is locked (lock order: orders, then blocks).
    const withdrawn = termsChanged ? await withdrawOffers(ctx, { traderId: trader.id, blockId: peek.id }, 'RATE_CHANGED') : 0;
    const block = await lockBlock(ctx, peek.id);
    const limits = await ctx.tx
      .selectFrom('trader_profile')
      .select(['max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor', 'max_capacity_usdt_minor'])
      .where('id', '=', trader.id)
      .executeTakeFirstOrThrow();
    const maxCapacity = side === 'BUY_USDT' ? limits.max_capacity_inr_minor : limits.max_capacity_usdt_minor;
    const maxOrderCeiling = side === 'BUY_USDT' ? limits.max_order_inr_minor : limits.max_order_usdt_minor;

    const amount = (value: string | undefined, field: string): bigint | undefined => {
      if (value === undefined) return undefined;
      const m = Money.parse(value, currency);
      if (m.isNegative()) throw new DomainError('INVALID_AMOUNT', `${field} must not be negative`, { field });
      return m.minor;
    };
    const capacity = amount(p.capacity, 'capacity') ?? block.capacity_minor;
    const minOrder = amount(p.minOrder, 'minOrder') ?? block.min_order_minor;
    const maxOrder = amount(p.maxOrder, 'maxOrder') ?? block.max_order_minor;
    const status = p.status ? requireOneOf(p.status, 'status', ['ACTIVE', 'PAUSED'] as const) : block.status;
    const hasRate = basis === 'FIXED' ? nextRate !== null : offset !== null;
    const fmt = (minor: bigint) => Money.ofMinor(minor, currency).toDecimalString();

    if (capacity < block.reserved_minor) {
      throw new DomainError('TRADER_CAPACITY_BELOW_RESERVED', `open orders already hold ${fmt(block.reserved_minor)} ${currency}; capacity cannot go below that`, { reserved: fmt(block.reserved_minor) });
    }
    if (maxCapacity !== null && capacity > maxCapacity) throw new DomainError('TRADER_LIMIT_EXCEEDED', `INRP2P limits your capacity to ${fmt(maxCapacity)} ${currency}`, { field: 'capacity' });
    if (minOrder !== null && minOrder <= 0n) throw new DomainError('INVALID_AMOUNT', 'the minimum order must be positive', { field: 'minOrder' });
    if (maxOrder !== null && maxOrder <= 0n) throw new DomainError('INVALID_AMOUNT', 'the maximum order must be positive', { field: 'maxOrder' });
    if (minOrder !== null && maxOrder !== null && minOrder > maxOrder) throw new DomainError('INVALID_ARGUMENT', 'the minimum order is above the maximum', { field: 'minOrder' });
    if (maxOrderCeiling !== null && maxOrder !== null && maxOrder > maxOrderCeiling) throw new DomainError('TRADER_LIMIT_EXCEEDED', `INRP2P limits one order to ${fmt(maxOrderCeiling)} ${currency}`, { field: 'maxOrder' });
    if (status === 'ACTIVE' && (!hasRate || minOrder === null || maxOrder === null)) {
      throw new DomainError('TRADER_BLOCK_INCOMPLETE', 'set a rate and an order size before making this side active');
    }
    // A firm offer stands only on an active side with its rate and order size; pausing the side ends it. One with no end
    // of its own stands only on a market rate: a fixed number would be left behind by the market.
    type Firm = { until: ReturnType<typeof sql<Date>> | Date | null; by: string | null; open: boolean };
    let firm: Firm = { until: block.instant_until, by: block.instant_set_by, open: block.instant_open_ended };
    if (p.firmHours !== undefined) {
      if (typeof p.firmHours !== 'number' || !Number.isInteger(p.firmHours) || p.firmHours < 0 || p.firmHours > 168) {
        throw new DomainError('INVALID_ARGUMENT', 'a firm offer lasts a whole number of hours, at most 168', { field: 'firmHours' });
      }
      firm = p.firmHours === 0 ? { until: null, by: null, open: false } : { until: sql<Date>`inrp2p_now() + make_interval(hours => ${p.firmHours})`, by: member.userId, open: false };
    }
    if (p.firmOpenEnded === true) {
      if (p.firmHours !== undefined && p.firmHours !== 0) throw new DomainError('INVALID_ARGUMENT', 'a firm offer either lasts some hours or until you turn it off', { field: 'firmHours' });
      if (basis !== 'MARKET') throw new DomainError('INVALID_ARGUMENT', 'only a rate set against the market can stay firm until you turn it off: a fixed rate would be left behind by the market', { field: 'firmOpenEnded' });
      firm = { until: null, by: member.userId, open: true };
    }
    if (status === 'PAUSED') firm = { until: null, by: null, open: false };
    // Back to a fixed number, an offer with no end of its own ends with the market rate it stood on.
    if (basis === 'FIXED' && firm.open) firm = { until: null, by: null, open: false };
    if ((firm.until !== null || firm.open) && (status !== 'ACTIVE' || !hasRate || minOrder === null || maxOrder === null)) {
      throw new DomainError('TRADER_BLOCK_INCOMPLETE', 'a firm offer needs this side active, with a rate and an order size');
    }
    const rails = p.rails === undefined ? block.rails : [...new Set(p.rails)];
    if (rails.length === 0 || rails.some((r) => !RAILS.includes(r))) throw new DomainError('INVALID_ARGUMENT', 'choose at least one of UPI, IMPS, NEFT and RTGS', { field: 'rails' });

    const after = await ctx.tx
      .updateTable('trader_block')
      .set({
        capacity_minor: capacity, min_order_minor: minOrder, max_order_minor: maxOrder, rate_micro: nextRate, status, instant_until: firm.until, instant_set_by: firm.by, rails,
        rate_basis: basis, market_offset_bps: offset, rate_limit_micro: limit, instant_open_ended: firm.open,
        updated_at: sql<Date>`inrp2p_now()`, version: block.version + 1,
      })
      .where('id', '=', block.id)
      .returning(['capacity_minor', 'rate_micro', 'min_order_minor', 'max_order_minor', 'status', 'version', 'instant_until', 'rails', 'rate_basis', 'market_offset_bps', 'rate_limit_micro', 'instant_open_ended'])
      .executeTakeFirstOrThrow();
    if (rateChanged && rate) {
      await publishTraderRate(ctx, { routeId: block.route_id, direction: side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT', rate });
    }
    await appendAudit(ctx, {
      action: 'trader.block_updated', entityType: 'trader_block', entityId: block.id,
      before: {
        capacity_minor: block.capacity_minor, rate_micro: block.rate_micro, min_order_minor: block.min_order_minor, max_order_minor: block.max_order_minor, status: block.status, version: block.version,
        instant_until: block.instant_until, rails: block.rails, rate_basis: block.rate_basis, market_offset_bps: block.market_offset_bps, rate_limit_micro: block.rate_limit_micro,
        instant_open_ended: block.instant_open_ended,
      },
      after: { ...after, offers_withdrawn: withdrawn },
    });
    // ADR 0033 §2.7: a side that changed may price a waiting client of that direction now.
    await enqueueOutbox(ctx, { type: 'waiting.look_now', aggregateType: 'trader_block', aggregateId: block.id, payload: { direction: block.side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT' } });
    return { version: after.version, offersWithdrawn: withdrawn, firmUntil: after.instant_until ? after.instant_until.toISOString() : null, firmOpenEnded: after.instant_open_ended };
  });
}
