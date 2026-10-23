import { sql } from 'kysely';
import { DomainError, Money, Rate, optionalText, requireOneOf, requireText } from '@inrp2p/kernel';
import { type DirectionValue, type TraderSide, type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { ClientActor } from '@inrp2p/identity';
import { deskByHandle, deskOfTrader, lockTraderOfClient, normalizeDeskHandle, traderClientCommand } from '@inrp2p/trader-core';

/**
 * A trader's own exchange on INRP2P (docs/adr/0020-desks.md): the commands its people run on it. Opening and naming the
 * desk, and taking it live or pausing it, commit the business — its administrator does them. Prices bind money — whoever
 * can accept quotes for the account sets them (`can_accept_quotes`, D-01), like a trader's rates.
 */

const STATUS_STEPS: Readonly<Record<'LIVE' | 'PAUSED', readonly string[]>> = Object.freeze({ LIVE: ['DRAFT', 'PAUSED'], PAUSED: ['LIVE'] });

function displayNameOf(value: unknown): string {
  const name = requireText(value, 'displayName', 60);
  if (name.length < 2) throw new DomainError('INVALID_ARGUMENT', 'the name needs at least 2 characters', { field: 'displayName' });
  return name;
}

/** `desk.open` — a trader's administrator opens its desk, as a draft: nothing is shown or traded until it goes live. */
export function openDesk(actor: ClientActor) {
  return traderClientCommand(actor, 'ADMIN', async (ctx, p: { handle: string; displayName: string; about?: string | null }, member) => {
    const trader = await lockTraderOfClient(ctx, member.clientId);
    if (await deskOfTrader(ctx.tx, trader.id)) throw new DomainError('DESK_EXISTS', 'your desk is already open');
    const handle = normalizeDeskHandle(p.handle);
    const displayName = displayNameOf(p.displayName);
    const about = optionalText(p.about, 'about', 280);
    if (await deskByHandle(ctx.tx, handle)) throw new DomainError('DESK_HANDLE_TAKEN', `inrp2p.com/${handle} is taken`, { field: 'handle' });
    let row;
    try {
      row = await ctx.tx.insertInto('desk')
        .values({ trader_id: trader.id, handle, display_name: displayName, about, created_by: member.userId })
        .returning(['id', 'status', 'version'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e, 'desk_handle_key')) throw new DomainError('DESK_HANDLE_TAKEN', `inrp2p.com/${handle} is taken`, { field: 'handle' });
      throw e;
    }
    await appendAudit(ctx, { action: 'desk.opened', entityType: 'desk', entityId: row.id, after: { trader_id: trader.id, handle, display_name: displayName, about, status: row.status } });
    return { deskId: row.id, handle, status: row.status, version: row.version };
  });
}

async function lockOwnDesk(ctx: TxContext, clientId: string, expectedVersion: number) {
  const trader = await lockTraderOfClient(ctx, clientId);
  const desk = await deskOfTrader(ctx.tx, trader.id);
  if (!desk) throw new DomainError('NOT_FOUND', 'open your desk first');
  if (!Number.isInteger(expectedVersion) || desk.version !== expectedVersion) throw new DomainError('STALE_VERSION', 'your desk changed since you opened it; reload and try again');
  return { trader, desk };
}

/** `desk.update` — its name and description; the address of its page only while it has never gone live. */
export function updateDesk(actor: ClientActor) {
  return traderClientCommand(actor, 'ADMIN', async (ctx, p: { expectedVersion: number; displayName?: string; about?: string | null; handle?: string }, member) => {
    const { desk } = await lockOwnDesk(ctx, member.clientId, p.expectedVersion);
    const displayName = p.displayName === undefined ? desk.displayName : displayNameOf(p.displayName);
    const about = p.about === undefined ? desk.about : optionalText(p.about, 'about', 280);
    let handle = desk.handle;
    if (p.handle !== undefined && p.handle !== desk.handle) {
      if (desk.status !== 'DRAFT') throw new DomainError('INVALID_TRANSITION', 'the address of your page is fixed once it has gone live: links to it are out there', { field: 'handle' });
      handle = normalizeDeskHandle(p.handle);
      const taken = await deskByHandle(ctx.tx, handle);
      if (taken && taken.id !== desk.id) throw new DomainError('DESK_HANDLE_TAKEN', `inrp2p.com/${handle} is taken`, { field: 'handle' });
    }
    try {
      await ctx.tx.updateTable('desk')
        .set({ handle, display_name: displayName, about, updated_at: sql<Date>`inrp2p_now()`, version: desk.version + 1 })
        .where('id', '=', desk.id).where('version', '=', desk.version)
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, 'desk_handle_key')) throw new DomainError('DESK_HANDLE_TAKEN', `inrp2p.com/${handle} is taken`, { field: 'handle' });
      throw e;
    }
    await appendAudit(ctx, {
      action: 'desk.updated', entityType: 'desk', entityId: desk.id,
      before: { handle: desk.handle, display_name: desk.displayName, about: desk.about }, after: { handle, display_name: displayName, about },
    });
    return { deskId: desk.id, handle, version: desk.version + 1 };
  });
}

/**
 * `desk.set_status` — take the desk live (from a draft, or after a pause) or pause it. Live only while INRP2P has approved
 * the trader (IX121). A pause stops new deals on its page and links; deals already open run to their end.
 */
export function setDeskStatus(actor: ClientActor) {
  return traderClientCommand(actor, 'ADMIN', async (ctx, p: { expectedVersion: number; status: 'LIVE' | 'PAUSED' }, member) => {
    const status = requireOneOf(p.status, 'status', ['LIVE', 'PAUSED'] as const);
    const { trader, desk } = await lockOwnDesk(ctx, member.clientId, p.expectedVersion);
    if (desk.status === status) return { deskId: desk.id, status, version: desk.version };
    // Suspended by INRP2P (block 11): only INRP2P lifts it.
    if (desk.status === 'SUSPENDED') throw new DomainError('DESK_NOT_LIVE', `INRP2P has suspended your desk: ${desk.suspensionReason ?? 'ask INRP2P why'}. Open deals go on; no new deal until INRP2P lifts it`);
    if (!STATUS_STEPS[status].includes(desk.status)) throw new DomainError('INVALID_TRANSITION', `a ${desk.status.toLowerCase()} desk cannot be ${status.toLowerCase()}`);
    if (status === 'LIVE' && trader.status !== 'APPROVED') throw new DomainError('DESK_NOT_LIVE', 'your desk goes live once INRP2P has approved you as a trader');
    await ctx.tx.updateTable('desk')
      .set({ status, updated_at: sql<Date>`inrp2p_now()`, version: desk.version + 1 })
      .where('id', '=', desk.id).where('version', '=', desk.version)
      .execute();
    await appendAudit(ctx, { action: 'desk.status_changed', entityType: 'desk', entityId: desk.id, before: { status: desk.status }, after: { status } });
    return { deskId: desk.id, status, version: desk.version + 1 };
  });
}

export interface DeskPriceInput {
  /** The client's direction: SELL_USDT is what the desk pays a client for USDT, BUY_USDT what a client pays for it. */
  readonly direction: DirectionValue;
  readonly rate: string;
  /** Smallest and largest deal on this price, in USDT. */
  readonly min: string;
  readonly max: string;
  readonly live: boolean;
}

/** The trader side that fills a client direction: a client selling USDT needs a desk buying it, and vice versa. */
const sideFor = (direction: DirectionValue): TraderSide => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');

/**
 * `desk.set_prices` — the prices the desk's clients see and deal on, per direction, with the smallest and largest deal,
 * valid for a number of hours (1 to 168, 24 by default): a desk that stops updating stops trading on stale prices. A
 * direction the desk does not fill (it has no side for it) cannot be priced. Prices are append-only; the latest counts.
 */
export function setDeskPrices(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { prices: readonly DeskPriceInput[]; validForHours?: number }, member) => {
    const trader = await lockTraderOfClient(ctx, member.clientId);
    const desk = await deskOfTrader(ctx.tx, trader.id);
    if (!desk) throw new DomainError('NOT_FOUND', 'open your desk first');
    if (!Array.isArray(p.prices) || p.prices.length < 1 || p.prices.length > 2) throw new DomainError('INVALID_ARGUMENT', 'give a price for one or both directions', { field: 'prices' });
    const hours = p.validForHours ?? 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new DomainError('INVALID_ARGUMENT', 'prices are valid for 1 to 168 hours', { field: 'validForHours' });
    const sides = new Set((await ctx.tx.selectFrom('trader_block').select('side').where('trader_id', '=', trader.id).execute()).map((b) => b.side));
    const seen = new Set<string>();
    const rows = p.prices.map((price) => {
      const direction = requireOneOf(price.direction, 'direction', ['SELL_USDT', 'BUY_USDT'] as const);
      if (seen.has(direction)) throw new DomainError('INVALID_ARGUMENT', 'one price per direction', { field: 'prices' });
      seen.add(direction);
      if (!sides.has(sideFor(direction))) {
        throw new DomainError('INVALID_ARGUMENT', direction === 'SELL_USDT' ? 'you do not buy USDT, so you cannot price it for clients selling' : 'you do not sell USDT, so you cannot price it for clients buying', { field: 'prices' });
      }
      const rate = Rate.parse(requireText(price.rate, 'rate', 32), 'CLIENT');
      const min = Money.parse(requireText(price.min, 'min', 32), 'USDT');
      const max = Money.parse(requireText(price.max, 'max', 32), 'USDT');
      if (rate.micro <= 0n) throw new DomainError('INVALID_RATE', 'the rate must be positive', { field: 'rate' });
      if (!min.isPositive() || max.minor < min.minor) throw new DomainError('INVALID_AMOUNT', 'the smallest deal must be positive and no larger than the largest', { field: 'min' });
      if (typeof price.live !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'say whether the price is live', { field: 'live' });
      return { direction, rate, min, max, live: price.live };
    });
    const inserted = await ctx.tx.insertInto('desk_price')
      .values(rows.map((r) => ({
        desk_id: desk.id, direction: r.direction, rate_micro: r.rate.micro, min_base_minor: r.min.minor, max_base_minor: r.max.minor, live: r.live,
        valid_until: sql<Date>`inrp2p_now() + make_interval(hours => ${hours})`, set_by: member.userId,
      })))
      .returning(['id', 'direction', 'valid_until'])
      .execute();
    await appendAudit(ctx, {
      action: 'desk.prices_set', entityType: 'desk', entityId: desk.id,
      after: { prices: rows.map((r) => ({ direction: r.direction, rate: r.rate, min: r.min, max: r.max, live: r.live })), valid_for_hours: hours },
    });
    return { deskId: desk.id, prices: inserted.map((r) => ({ id: r.id, direction: r.direction, validUntil: r.valid_until.toISOString() })) };
  });
}
