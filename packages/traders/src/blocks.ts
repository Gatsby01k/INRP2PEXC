import { sql } from 'kysely';
import { DomainError, Money, Rate, requireOneOf } from '@inrp2p/kernel';
import type { TraderSide } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { ClientActor } from '@inrp2p/identity';
import { publishTraderRate } from '@inrp2p/pricing';
import { lockTraderOfClient, traderClientCommand, lockBlock, withdrawOffers } from '@inrp2p/trader-core';
import { switchOnIssues } from './eligibility.ts';
import { readStanding } from './standing.ts';

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
    return { available: on, changed: true, offersWithdrawn: withdrawn };
  });
}

export interface UpdateBlockPayload {
  readonly side: TraderSide;
  readonly expectedVersion: number;
  /** Decimal in the block's currency: INR for Buy USDT, USDT for Sell USDT. */
  readonly capacity?: string;
  /** Fixed rate, INR per USDT. */
  readonly rate?: string;
  readonly minOrder?: string;
  readonly maxOrder?: string;
  readonly status?: 'ACTIVE' | 'PAUSED';
}

/**
 * `trader.update_block` — a user who can commit. The trader's own terms for one side: how much it can provide,
 * its fixed rate, and the order size it takes. Capacity never goes below what open orders already hold, and never
 * above the operator's ceiling. A new rate is published as the trader route's rate at once (source TRADER), and
 * any offer made at the old rate is withdrawn — an offer is always at the rate the trader currently stands behind.
 *
 * Reference-based pricing is not offered: the only market reference in the product is context the desk may record
 * (FI-01), and nothing may derive an executable rate from it.
 */
export function updateBlock(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: UpdateBlockPayload, member) => {
    const side = requireOneOf(p.side, 'side', ['BUY_USDT', 'SELL_USDT'] as const);
    const currency = side === 'BUY_USDT' ? 'INR' : 'USDT';
    const trader = await lockTraderOfClient(ctx, member.clientId);
    if (trader.status !== 'APPROVED' && trader.status !== 'PAUSED') throw new DomainError('TRADER_NOT_APPROVED', 'your application has not been approved yet');
    const peek = await ctx.tx.selectFrom('trader_block').select(['id', 'rate_micro', 'version']).where('trader_id', '=', trader.id).where('side', '=', side).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', `you are not set up to ${side === 'BUY_USDT' ? 'buy' : 'sell'} USDT`);
    if (peek.version !== p.expectedVersion) throw new DomainError('STALE_VERSION', 'these settings changed since you opened them; reload and try again');

    const rate = p.rate !== undefined ? Rate.parse(p.rate, 'ROUTE') : null;
    const rateChanged = rate !== null && rate.micro !== peek.rate_micro;
    // Offers at the old rate are withdrawn before the block is locked (lock order: orders, then blocks).
    const withdrawn = rateChanged ? await withdrawOffers(ctx, { traderId: trader.id, blockId: peek.id }, 'RATE_CHANGED') : 0;
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
    const nextRate = rate?.micro ?? block.rate_micro;
    const fmt = (minor: bigint) => Money.ofMinor(minor, currency).toDecimalString();

    if (capacity < block.reserved_minor) {
      throw new DomainError('TRADER_CAPACITY_BELOW_RESERVED', `open orders already hold ${fmt(block.reserved_minor)} ${currency}; capacity cannot go below that`, { reserved: fmt(block.reserved_minor) });
    }
    if (maxCapacity !== null && capacity > maxCapacity) throw new DomainError('TRADER_LIMIT_EXCEEDED', `INRP2P limits your capacity to ${fmt(maxCapacity)} ${currency}`, { field: 'capacity' });
    if (minOrder !== null && minOrder <= 0n) throw new DomainError('INVALID_AMOUNT', 'the minimum order must be positive', { field: 'minOrder' });
    if (maxOrder !== null && maxOrder <= 0n) throw new DomainError('INVALID_AMOUNT', 'the maximum order must be positive', { field: 'maxOrder' });
    if (minOrder !== null && maxOrder !== null && minOrder > maxOrder) throw new DomainError('INVALID_ARGUMENT', 'the minimum order is above the maximum', { field: 'minOrder' });
    if (maxOrderCeiling !== null && maxOrder !== null && maxOrder > maxOrderCeiling) throw new DomainError('TRADER_LIMIT_EXCEEDED', `INRP2P limits one order to ${fmt(maxOrderCeiling)} ${currency}`, { field: 'maxOrder' });
    if (status === 'ACTIVE' && (nextRate === null || minOrder === null || maxOrder === null)) {
      throw new DomainError('TRADER_BLOCK_INCOMPLETE', 'set a rate and an order size before making this side active');
    }

    const after = await ctx.tx
      .updateTable('trader_block')
      .set({ capacity_minor: capacity, min_order_minor: minOrder, max_order_minor: maxOrder, rate_micro: nextRate, status, updated_at: sql<Date>`inrp2p_now()`, version: block.version + 1 })
      .where('id', '=', block.id)
      .returning(['capacity_minor', 'rate_micro', 'min_order_minor', 'max_order_minor', 'status', 'version'])
      .executeTakeFirstOrThrow();
    if (rateChanged && rate) {
      await publishTraderRate(ctx, { routeId: block.route_id, direction: side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT', rate });
    }
    await appendAudit(ctx, {
      action: 'trader.block_updated', entityType: 'trader_block', entityId: block.id,
      before: { capacity_minor: block.capacity_minor, rate_micro: block.rate_micro, min_order_minor: block.min_order_minor, max_order_minor: block.max_order_minor, status: block.status, version: block.version },
      after: { ...after, offers_withdrawn: withdrawn },
    });
    return { version: after.version, offersWithdrawn: withdrawn };
  });
}
