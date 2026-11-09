import { sql } from 'kysely';
import { type ClientRate, type DeskEconomics, DomainError, type MarketReference, type MarketReferences, Money, computeDeskEconomics, requireUuid, DESK_HANDLE_SHAPE, RESERVED_DESK_HANDLES } from '@inrp2p/kernel';
import type { DeskClientSource, DeskClientStatus, DeskStatus, DirectionValue, Executor, FixedSideValue, TraderSide, TxContext } from '@inrp2p/db';
import { readBlocks } from './standing.ts';

/**
 * Desks (docs/adr/0020-desks.md): every trader runs its own exchange on INRP2P — a name and a page, its own clients and
 * its own prices — and fills its clients' deals with its own liquidity through the P2P escrow. INRP2P earns an explicit
 * fee on each deal. This module is the part quote commands depend on: the fee policy, a desk and its prices, and whose
 * client a client is. The commands a trader runs on its desk are in `@inrp2p/traders`.
 */

export interface FeePolicy {
  readonly id: string;
  /** Basis points of the deal's USDT on a deal the desk fills itself. */
  readonly ownDealBps: number;
  /** Basis points on a deal another desk fills through the network (stage 2). */
  readonly networkDealBps: number;
  readonly setAt: Date;
}

/** The fee policy in force: its latest row (migration 0040 seeds one, so there always is one). */
export async function currentFeePolicy(ex: Executor): Promise<FeePolicy> {
  const r = await ex.selectFrom('fee_policy').select(['id', 'own_deal_bps', 'network_deal_bps', 'set_at']).orderBy('set_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'no fee policy is recorded');
  return { id: r.id, ownDealBps: r.own_deal_bps, networkDealBps: r.network_deal_bps, setAt: r.set_at };
}

/**
 * A deal the desk fills with its own liquidity, priced at the desk's rate with the policy's fee (FI-99). The same function
 * prices the quote and sizes the desk's order, so the two always agree (the database checks it, IX125).
 */
export function priceDeskDeal(input: {
  direction: DirectionValue; fixedSide: FixedSideValue; amountMinor: bigint; clientRate: ClientRate; policy: FeePolicy;
  /** ADR 0022: the network allowance the desk's USDT side carries (what its network credit does not cover). */
  networkFeeMinor?: bigint | null;
}): DeskEconomics {
  const networkFee = input.networkFeeMinor === undefined || input.networkFeeMinor === null ? {} : { networkFee: Money.ofMinor(input.networkFeeMinor, 'USDT') };
  return input.fixedSide === 'BASE'
    ? computeDeskEconomics({ direction: input.direction, fixedSide: 'BASE', amount: Money.ofMinor(input.amountMinor, 'USDT'), clientRate: input.clientRate, feeBps: input.policy.ownDealBps, ...networkFee })
    : computeDeskEconomics({ direction: input.direction, fixedSide: 'QUOTE', amount: Money.ofMinor(input.amountMinor, 'INR'), clientRate: input.clientRate, feeBps: input.policy.ownDealBps, ...networkFee });
}

// ---- handles -----------------------------------------------------------------------------------------------------

/** Paths of the public site and the app a desk's page must never shadow — in the kernel, so the router shares them. */
export { RESERVED_DESK_HANDLES };

const HANDLE_SHAPE = DESK_HANDLE_SHAPE;

/**
 * The address of a desk's page (`inrp2p.com/<handle>`), as the person typed it: trimmed and lower-cased, then held to the
 * shape the database requires — 3 to 30 letters, digits and inner hyphens — and never one of the site's own paths.
 */
export function normalizeDeskHandle(raw: unknown): string {
  const handle = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!HANDLE_SHAPE.test(handle)) {
    throw new DomainError('DESK_HANDLE_INVALID', 'use 3 to 30 lower-case letters, digits or hyphens, starting and ending with a letter or digit', { field: 'handle' });
  }
  if (RESERVED_DESK_HANDLES.has(handle)) throw new DomainError('DESK_HANDLE_INVALID', `“${handle}” is part of the site`, { field: 'handle' });
  return handle;
}

// ---- desks -------------------------------------------------------------------------------------------------------

export interface DeskRow {
  readonly id: string;
  readonly traderId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly about: string | null;
  readonly status: DeskStatus;
  /** Block 11: why INRP2P suspended the desk (status SUSPENDED), and why it hid the desk's page — null when it did not. */
  readonly suspensionReason: string | null;
  readonly pageHiddenReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

const DESK_COLUMNS = ['id', 'trader_id', 'handle', 'display_name', 'about', 'status', 'suspension_reason', 'page_hidden_reason', 'created_at', 'version'] as const;

function deskRow(r: {
  id: string; trader_id: string; handle: string; display_name: string; about: string | null; status: DeskStatus;
  suspension_reason: string | null; page_hidden_reason: string | null; created_at: Date; version: number;
}): DeskRow {
  return {
    id: r.id, traderId: r.trader_id, handle: r.handle, displayName: r.display_name, about: r.about, status: r.status,
    suspensionReason: r.suspension_reason, pageHiddenReason: r.page_hidden_reason, createdAt: r.created_at, version: r.version,
  };
}

export async function deskOfTrader(ex: Executor, traderId: string): Promise<DeskRow | null> {
  const r = await ex.selectFrom('desk').select(DESK_COLUMNS).where('trader_id', '=', requireUuid(traderId, 'traderId')).executeTakeFirst();
  return r ? deskRow(r) : null;
}

export async function deskById(ex: Executor, deskId: string): Promise<DeskRow | null> {
  const r = await ex.selectFrom('desk').select(DESK_COLUMNS).where('id', '=', requireUuid(deskId, 'deskId')).executeTakeFirst();
  return r ? deskRow(r) : null;
}

/** A desk by the address of its page; a handle that is not well-formed is simply not found. */
export async function deskByHandle(ex: Executor, handle: string): Promise<DeskRow | null> {
  const h = typeof handle === 'string' ? handle.trim().toLowerCase() : '';
  if (!HANDLE_SHAPE.test(h)) return null;
  const r = await ex.selectFrom('desk').select(DESK_COLUMNS).where('handle', '=', h).executeTakeFirst();
  return r ? deskRow(r) : null;
}

// ---- prices ------------------------------------------------------------------------------------------------------

export interface DeskPrice {
  readonly id: string;
  readonly direction: DirectionValue;
  /** Migration 0048: the desk's own number (`OWN`), or its side's rate on Traders as it is now (`SIDE`). */
  readonly basis: 'OWN' | 'SIDE';
  /** The rate a deal is priced at now; null for a price following a side that has no rate (no fresh market reference). */
  readonly rateMicro: bigint | null;
  readonly minBaseMinor: bigint;
  readonly maxBaseMinor: bigint;
  readonly live: boolean;
  /** Until when an own price is offered; null for one following a side, which is as fresh as the side. */
  readonly validUntil: Date | null;
  readonly setAt: Date;
  /** The desk's person who set it: whose standing commitment a deal priced on it is. */
  readonly setBy: string;
  /** Live, with a rate, and an own price not past its time: a deal may be priced on it now (business clock). */
  readonly offered: boolean;
  /** For a price following a side at a market rate: the reference and the terms the rate is derived from (IX143). */
  readonly market: { readonly reference: MarketReference; readonly offsetBps: number; readonly limitMicro: bigint | null } | null;
}

/** The trader side that fills a client direction: a client selling USDT needs the desk buying it, and vice versa. */
const deskSideFor = (direction: DirectionValue): TraderSide => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');

/**
 * The desk's latest price per client direction, and whether each may be dealt on right now. A price following its side is
 * read at the side's rate as it is now — on `market`, the references fresh enough to price on, for a side at a market rate.
 */
export async function currentDeskPrices(ex: Executor, deskId: string, market: MarketReferences): Promise<Readonly<Record<DirectionValue, DeskPrice | null>>> {
  const r = await sql<{ id: string; direction: DirectionValue; basis: 'OWN' | 'SIDE'; rate_micro: string | null; min_base_minor: string; max_base_minor: string; live: boolean; valid_until: Date | null; set_at: Date; set_by: string; current: boolean; trader_id: string }>`
    select distinct on (p.direction) p.id, p.direction, p.basis, p.rate_micro::text, p.min_base_minor::text, p.max_base_minor::text, p.live, p.valid_until, p.set_at, p.set_by,
           (p.valid_until is null or p.valid_until > inrp2p_now()) as current, d.trader_id
      from desk_price p join desk d on d.id = p.desk_id
     where p.desk_id = ${requireUuid(deskId, 'deskId')}
     order by p.direction, p.set_at desc, p.id desc`.execute(ex);
  const out: Record<DirectionValue, DeskPrice | null> = { SELL_USDT: null, BUY_USDT: null };
  const blocks = r.rows.some((p) => p.basis === 'SIDE') ? await readBlocks(ex, r.rows[0]!.trader_id, market) : [];
  for (const p of r.rows) {
    const side = p.basis === 'SIDE' ? blocks.find((b) => b.side === deskSideFor(p.direction)) : undefined;
    const rateMicro = p.basis === 'OWN' ? BigInt(p.rate_micro!) : (side?.rateMicro ?? null);
    out[p.direction] = {
      id: p.id, direction: p.direction, basis: p.basis, rateMicro, minBaseMinor: BigInt(p.min_base_minor), maxBaseMinor: BigInt(p.max_base_minor),
      live: p.live, validUntil: p.valid_until, setAt: p.set_at, setBy: p.set_by, offered: p.live && p.current && rateMicro !== null,
      market: side && side.rateBasis === 'MARKET' && side.market ? { reference: side.market, offsetBps: side.marketOffsetBps!, limitMicro: side.rateLimitMicro } : null,
    };
  }
  return out;
}

// ---- clients -----------------------------------------------------------------------------------------------------

export interface DeskClientRow {
  readonly id: string;
  readonly deskId: string;
  readonly clientId: string;
  readonly source: DeskClientSource;
  readonly status: DeskClientStatus;
  readonly maxDealBaseMinor: bigint | null;
}

export async function deskClient(ex: Executor, deskId: string, clientId: string): Promise<DeskClientRow | null> {
  const r = await ex.selectFrom('desk_client').select(['id', 'desk_id', 'client_id', 'source', 'status', 'max_deal_base_minor'])
    .where('desk_id', '=', requireUuid(deskId, 'deskId')).where('client_id', '=', requireUuid(clientId, 'clientId')).executeTakeFirst();
  return r ? { id: r.id, deskId: r.desk_id, clientId: r.client_id, source: r.source, status: r.status, maxDealBaseMinor: r.max_deal_base_minor } : null;
}

/**
 * Makes a client the desk's client the first time it comes through the desk's page, a deal link or an invitation, and
 * returns the relationship as it stands — a client the desk blocked stays blocked. Idempotent: the pair is unique.
 */
export async function attachDeskClientInTx(ctx: TxContext, input: { deskId: string; clientId: string; source: DeskClientSource }): Promise<DeskClientRow & { readonly created: boolean }> {
  const inserted = await ctx.tx.insertInto('desk_client')
    .values({ desk_id: requireUuid(input.deskId, 'deskId'), client_id: requireUuid(input.clientId, 'clientId'), source: input.source })
    .onConflict((oc) => oc.columns(['desk_id', 'client_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  const row = await deskClient(ctx.tx, input.deskId, input.clientId);
  if (!row) throw new DomainError('NOT_FOUND', 'desk client not found');
  return { ...row, created: inserted !== undefined };
}
