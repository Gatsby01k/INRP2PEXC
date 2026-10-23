import { sql } from 'kysely';
import { DomainError, Money, Rate, optionalText, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { DeskDealLinkStatus, DirectionValue, Executor, FixedSideValue } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { ClientActor } from '@inrp2p/identity';
import {
  attachDeskClientInTx, closeOrdersForRequests, currentFeePolicy, deskById, deskOfTrader, priceDeskDeal, traderClientCommand,
} from '@inrp2p/trader-core';
import { lockRow } from './actors.ts';
import { type QuoteDeps, policyOf } from './policy.ts';
import { type CreateRequestPayload, cancelSentQuoteOfRequest, closeRequest, openRequestInTx } from './requests.ts';
import { type DeskDealQuote, memberClientCommand, quoteDeskDealInTx, quoteLockedDeskDealInTx } from './desk-deals.ts';
import { linkTokenHash, newLinkToken } from './security.ts';

/**
 * A deal link (docs/adr/0020-desks.md §2.8): the deal a desk offers one client by a link it sends in a chat — the
 * direction, the amount and the desk's rate for it. Whoever takes it first is the only one who can; it becomes at most one
 * trade; and its quote is at the link's rate (IX126). Taking it makes the taker the desk's client, opens the request and
 * hands it a firm quote at once, through the same desk deal as the desk's page (`quoteDeskDealInTx`). If that quote lapses,
 * the same client takes the link again for a fresh one, until the link itself expires.
 *
 * The link's secret is handed to the caller once (`onToken`) and never stored: only its hash, as for quote links.
 */

export interface CreateDeskDealLinkPayload {
  readonly direction: DirectionValue;
  readonly fixedSide: FixedSideValue;
  /** USDT (BASE) or INR (QUOTE), in the fixed side's currency. */
  readonly amount: string;
  /** The desk's rate for this deal, INR per USDT. */
  readonly rate: string;
  /** How long the link can be taken: 5 minutes to 7 days; an hour by default. */
  readonly validMinutes?: number;
  /** The desk's own label for whom it is; never shown to the client. */
  readonly note?: string | null;
}

const sideOf = (direction: DirectionValue) => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');

/** `desk_deal_link.create` — whoever can commit for the desk makes a link for one deal at its own rate. */
export function createDeskDealLink(actor: ClientActor, onToken: (token: string) => void) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: CreateDeskDealLinkPayload, member) => {
    const trader = await ctx.tx.selectFrom('trader_profile').select(['id', 'status']).where('client_id', '=', member.clientId).executeTakeFirst();
    if (!trader) throw new DomainError('NOT_FOUND', 'this account is not a trader');
    const desk = await deskOfTrader(ctx.tx, trader.id);
    if (!desk) throw new DomainError('NOT_FOUND', 'open your desk first');
    if (desk.status !== 'LIVE') throw new DomainError('DESK_NOT_LIVE', 'take your desk live before you send deal links');
    const direction = requireOneOf(p.direction, 'direction', ['SELL_USDT', 'BUY_USDT'] as const);
    const fixedSide = requireOneOf(p.fixedSide, 'fixedSide', ['BASE', 'QUOTE'] as const);
    const block = await ctx.tx.selectFrom('trader_block').select('id').where('trader_id', '=', trader.id).where('side', '=', sideOf(direction)).executeTakeFirst();
    if (!block) throw new DomainError('INVALID_ARGUMENT', direction === 'SELL_USDT' ? 'you do not buy USDT' : 'you do not sell USDT', { field: 'direction' });
    const amount = fixedSide === 'BASE' ? Money.parse(requireText(p.amount, 'amount', 32), 'USDT') : Money.parse(requireText(p.amount, 'amount', 32), 'INR');
    const rate = Rate.parse(requireText(p.rate, 'rate', 32), 'CLIENT');
    if (rate.micro <= 0n) throw new DomainError('INVALID_RATE', 'the rate must be positive', { field: 'rate' });
    // The deal must be priceable now: an amount too small to carry the fee is refused here, not when the client takes it.
    priceDeskDeal({ direction, fixedSide, amountMinor: amount.minor, clientRate: rate, policy: await currentFeePolicy(ctx.tx) });
    const minutes = p.validMinutes ?? 60;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10_080) throw new DomainError('INVALID_ARGUMENT', 'a link is valid for 5 minutes to 7 days', { field: 'validMinutes' });
    const note = optionalText(p.note, 'note', 140);
    const token = newLinkToken();
    const link = await ctx.tx.insertInto('desk_deal_link')
      .values({
        desk_id: desk.id, token_hash: linkTokenHash(token), direction, fixed_side: fixedSide, amount_minor: amount.minor, rate_micro: rate.micro, note,
        expires_at: sql<Date>`inrp2p_now() + make_interval(mins => ${minutes})`, created_by: member.userId,
      })
      .returning(['id', 'ref', 'expires_at'])
      .executeTakeFirstOrThrow();
    onToken(token);
    await appendAudit(ctx, {
      action: 'desk_deal_link.created', entityType: 'desk_deal_link', entityId: link.id,
      after: { ref: link.ref, desk_id: desk.id, direction, fixed_side: fixedSide, amount, rate, expires_at: link.expires_at, note },
    });
    return { linkId: link.id, ref: link.ref, expiresAt: link.expires_at.toISOString() };
  });
}

/**
 * `desk_deal_link.revoke` — the desk takes a link back before it became a trade. A price the client holds from it is
 * cancelled and its capacity given back in the same step.
 */
export function revokeDeskDealLink(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { linkId: string; reason: string }, member) => {
    const reason = requireText(p.reason, 'reason', 500);
    const trader = await ctx.tx.selectFrom('trader_profile').select('id').where('client_id', '=', member.clientId).executeTakeFirst();
    const desk = trader ? await deskOfTrader(ctx.tx, trader.id) : null;
    const link = await ctx.tx.selectFrom('desk_deal_link').selectAll().where('id', '=', requireUuid(p.linkId, 'linkId')).executeTakeFirst();
    if (!desk || !link || link.desk_id !== desk.id) throw new DomainError('NOT_FOUND', 'deal link not found');
    if (link.status === 'REVOKED') return { ref: link.ref, status: 'REVOKED' as const };
    const requests = await ctx.tx.selectFrom('trade_request').select(['id', 'status', 'version']).where('desk_deal_link_id', '=', link.id).orderBy('id').execute();
    if (requests.some((r) => r.status === 'ACCEPTED')) throw new DomainError('INVALID_TRANSITION', `deal link ${link.ref} has already become a trade`);
    const open = requests.filter((r) => r.status === 'OPEN' || r.status === 'QUOTED');
    for (const r of open) await lockRow(ctx.tx, 'trade_request', 'trade_request', r.id);
    for (const r of open) await cancelSentQuoteOfRequest(ctx, r.id, 'WITHDRAWN');
    await closeOrdersForRequests(ctx, open.map((r) => r.id));
    for (const r of open) await closeRequest(ctx.tx, r.id, 'WITHDRAWN', 'the desk revoked the deal link', r.version);
    await ctx.tx.updateTable('desk_deal_link')
      .set({ status: 'REVOKED', revoked_by: member.userId, revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: reason, version: link.version + 1 })
      .where('id', '=', link.id).where('version', '=', link.version)
      .execute();
    await appendAudit(ctx, { action: 'desk_deal_link.revoked', entityType: 'desk_deal_link', entityId: link.id, before: { status: link.status }, after: { status: 'REVOKED', reason, withdrawn_requests: open.map((r) => r.id) } });
    return { ref: link.ref, status: 'REVOKED' as const };
  });
}

export interface ClaimDeskDealLinkPayload {
  readonly token: string;
  /** Client sells: its own bank account the desk pays. */
  readonly bankAccountId?: string | null;
  /** Client buys: its own wallet the USDT goes to. */
  readonly walletId?: string | null;
  readonly sourceWalletId?: string | null;
}

/**
 * `desk_deal_link.claim` — a signed-in client takes the link: the first one to do so is the only one who ever can. It
 * becomes the desk's client and gets a firm quote at the link's rate, valid as long as a link quote is (180 s by
 * default). Taking it again while that quote is live gives the same quote; after it lapsed, a fresh one.
 */
export function claimDeskDealLink(actor: ClientActor, deps: QuoteDeps) {
  return memberClientCommand(actor, async (ctx, p: ClaimDeskDealLinkPayload, clientId): Promise<DeskDealQuote & { readonly linkRef: string }> => {
    const link = await ctx.tx.selectFrom('desk_deal_link').selectAll().where('token_hash', '=', linkTokenHash(p.token)).executeTakeFirst();
    if (!link) throw new DomainError('NOT_FOUND', 'this link is not valid');
    if (link.status === 'REVOKED') throw new DomainError('DESK_LINK_UNAVAILABLE', 'the desk took this link back');
    const now = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ctx.tx)).rows[0]!.now;
    if (link.expires_at <= now) throw new DomainError('DESK_LINK_UNAVAILABLE', 'this link has expired: ask the desk for a new one');
    if (link.claimed_client_id && link.claimed_client_id !== clientId) throw new DomainError('DESK_LINK_UNAVAILABLE', 'this link was already taken');
    const desk = await deskById(ctx.tx, link.desk_id);
    if (!desk || desk.status !== 'LIVE') throw new DomainError('DESK_NOT_LIVE', 'this desk is not taking deals right now');
    const done = await ctx.tx.selectFrom('trade_request').select('id').where('desk_deal_link_id', '=', link.id).where('status', '=', 'ACCEPTED').executeTakeFirst();
    if (done) throw new DomainError('DESK_LINK_UNAVAILABLE', 'this deal is already done');
    const validity = policyOf(deps).linkDefaultValiditySeconds;

    // Taken again: the client's open request from this link keeps its live quote, or gets a fresh one.
    const open = await ctx.tx.selectFrom('trade_request').select(['id', 'status']).where('desk_deal_link_id', '=', link.id).where('status', 'in', ['OPEN', 'QUOTED']).executeTakeFirst();
    if (open) {
      await lockRow(ctx.tx, 'trade_request', 'trade_request', open.id);
      const live = await ctx.tx.selectFrom('quote').selectAll().where('trade_request_id', '=', open.id).where('status', '=', 'SENT').where('expires_at', '>', now).executeTakeFirst();
      if (live) return { ...(await liveQuote(ctx.tx, live.id)), linkRef: link.ref };
      if (open.status === 'QUOTED') await cancelSentQuoteOfRequest(ctx, open.id, 'SUPERSEDED');
      const fresh = await quoteDeskDealOnLockedRequest(ctx, deps, open.id, link.rate_micro, validity, link.created_by);
      return { ...fresh, linkRef: link.ref };
    }

    // First time: the client takes the link — atomically, so two clients racing for it cannot both have it (IX126).
    const claimed = await ctx.tx.updateTable('desk_deal_link')
      .set({ status: 'CLAIMED', claimed_client_id: clientId, claimed_at: sql<Date>`coalesce(claimed_at, inrp2p_now())`, version: sql<number>`version + 1` })
      .where('id', '=', link.id).where('status', 'in', ['OPEN', 'CLAIMED'])
      .where((eb) => eb.or([eb('claimed_client_id', 'is', null), eb('claimed_client_id', '=', clientId)]))
      .returning('id')
      .executeTakeFirst();
    if (!claimed) throw new DomainError('DESK_LINK_UNAVAILABLE', 'this link was already taken');
    const relation = await attachDeskClientInTx(ctx, { deskId: desk.id, clientId, source: 'LINK' });
    if (relation.status !== 'ACTIVE') throw new DomainError('DESK_CLIENT_BLOCKED', 'this desk is not dealing with this client');
    const amount = link.fixed_side === 'BASE' ? Money.ofMinor(link.amount_minor, 'USDT').toDecimalString() : Money.ofMinor(link.amount_minor, 'INR').toDecimalString();
    const payload: CreateRequestPayload = {
      clientId, direction: link.direction, fixedSide: link.fixed_side, amount, deskId: desk.id,
      bankAccountId: p.bankAccountId ?? null, walletId: p.walletId ?? null, sourceWalletId: p.sourceWalletId ?? null,
    };
    const opened = await openRequestInTx(ctx, deps, { clientId, payload, channel: 'LINK', deskDealLinkId: link.id });
    await appendAudit(ctx, { action: 'desk_deal_link.claimed', entityType: 'desk_deal_link', entityId: link.id, after: { ref: link.ref, client_id: clientId, request_id: opened.requestId } });
    const quote = await quoteDeskDealInTx(ctx, deps, { requestId: opened.requestId, clientRateMicro: link.rate_micro, validitySeconds: validity, committedBy: link.created_by });
    return { ...quote, linkRef: link.ref };
  });
}

/** A fresh quote for a request whose lock the caller holds (a link taken again after its quote lapsed). */
async function quoteDeskDealOnLockedRequest(ctx: Parameters<typeof quoteDeskDealInTx>[0], deps: QuoteDeps, requestId: string, rateMicro: bigint, validity: number, committedBy: string): Promise<DeskDealQuote> {
  // A lapsed quote leaves the request QUOTED until the expiry job runs; it opens again here so the new quote can be made.
  const r = await ctx.tx.selectFrom('trade_request').select(['status', 'version']).where('id', '=', requestId).executeTakeFirstOrThrow();
  if (r.status === 'QUOTED') await ctx.tx.updateTable('trade_request').set({ status: 'OPEN', last_activity_at: sql<Date>`inrp2p_now()`, version: r.version + 1 }).where('id', '=', requestId).execute();
  return quoteLockedDeskDealInTx(ctx, deps, { requestId, clientRateMicro: rateMicro, validitySeconds: validity, committedBy });
}

/** The client's view of a live quote it already holds, in the shape a fresh one is returned in. */
async function liveQuote(ex: Executor, quoteId: string): Promise<DeskDealQuote> {
  const r = await ex.selectFrom('quote').selectAll().where('id', '=', quoteId).executeTakeFirstOrThrow();
  const order = await ex.selectFrom('trader_order').select(['id', 'ref']).where('trade_request_id', '=', r.trade_request_id).where('status', '=', 'ACCEPTED').executeTakeFirstOrThrow();
  return {
    quoteId: r.id, ref: r.ref, requestId: r.trade_request_id, orderId: order.id, orderRef: order.ref, direction: r.direction,
    clientRate: Rate.ofMicro(r.client_rate_micro, 'CLIENT').toDecimalString(), base: Money.ofMinor(r.base_minor, 'USDT').toDecimalString(),
    clientInr: Money.ofMinor(r.quote_inr_minor, 'INR').toDecimalString(), deskBase: Money.ofMinor(r.route_base_minor!, 'USDT').toDecimalString(),
    platformFee: Money.ofMinor(r.platform_fee_base_minor!, 'USDT').toDecimalString(), expiresAt: r.expires_at!.toISOString(),
  };
}

// ---- views ---------------------------------------------------------------------------------------------------------

export type DeskDealLinkState = 'OPEN' | 'TAKEN' | 'DONE' | 'EXPIRED' | 'REVOKED';

function linkState(l: { status: DeskDealLinkStatus; expires_at: Date }, done: boolean, now: Date): DeskDealLinkState {
  if (done) return 'DONE';
  if (l.status === 'REVOKED') return 'REVOKED';
  if (l.expires_at <= now) return 'EXPIRED';
  return l.status === 'CLAIMED' ? 'TAKEN' : 'OPEN';
}

/**
 * What anyone holding a deal link sees before signing in: the desk, the deal and the exact amounts the client pays and
 * receives — never the desk's own USDT or INRP2P's fee, which are the desk's business. Null for a token that is not one.
 */
export async function deskDealLinkView(ex: Executor, token: string) {
  const l = await ex.selectFrom('desk_deal_link as l').innerJoin('desk as d', 'd.id', 'l.desk_id')
    .select(['l.id', 'l.ref', 'l.direction', 'l.fixed_side', 'l.amount_minor', 'l.rate_micro', 'l.expires_at', 'l.status', 'd.handle', 'd.display_name', 'd.status as desk_status'])
    .where('l.token_hash', '=', linkTokenHash(token)).executeTakeFirst();
  if (!l) return null;
  const now = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex)).rows[0]!.now;
  const done = Boolean(await ex.selectFrom('trade_request').select('id').where('desk_deal_link_id', '=', l.id).where('status', '=', 'ACCEPTED').executeTakeFirst());
  const econ = priceDeskDeal({ direction: l.direction, fixedSide: l.fixed_side, amountMinor: l.amount_minor, clientRate: Rate.ofMicro(l.rate_micro, 'CLIENT'), policy: await currentFeePolicy(ex) });
  return {
    ref: l.ref,
    desk: { handle: l.handle, displayName: l.display_name, live: l.desk_status === 'LIVE' },
    direction: l.direction,
    rate: Rate.ofMicro(l.rate_micro, 'CLIENT').toDecimalString(),
    /** The client's USDT: what it sends (sells) or receives (buys). */
    base: econ.base.toDecimalString(),
    /** The client's rupees: what it receives (sells) or pays (buys). */
    inr: econ.clientInr.toDecimalString(),
    expiresAt: l.expires_at.toISOString(),
    state: linkState(l, done, now),
  };
}

/** The desk's own list of its links, newest first, with who took each and the trade it became. */
export async function deskDealLinks(ex: Executor, deskId: string, limit = 100) {
  const rows = await ex.selectFrom('desk_deal_link as l')
    .leftJoin('client as c', 'c.id', 'l.claimed_client_id')
    .select(['l.id', 'l.ref', 'l.direction', 'l.fixed_side', 'l.amount_minor', 'l.rate_micro', 'l.note', 'l.expires_at', 'l.status', 'l.created_at', 'c.display_name as client_name'])
    .select((eb) => eb.selectFrom('trade as t').innerJoin('trade_request as r', 'r.id', 't.trade_request_id').select('t.ref').whereRef('r.desk_deal_link_id', '=', 'l.id').limit(1).as('trade_ref'))
    .where('l.desk_id', '=', requireUuid(deskId, 'deskId'))
    .orderBy('l.created_at', 'desc').limit(limit)
    .execute();
  const now = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex)).rows[0]!.now;
  return rows.map((l) => ({
    linkId: l.id, ref: l.ref, direction: l.direction,
    amount: l.fixed_side === 'BASE' ? `${Money.ofMinor(l.amount_minor, 'USDT').toDecimalString()} USDT` : `${Money.ofMinor(l.amount_minor, 'INR').toDecimalString()} INR`,
    rate: Rate.ofMicro(l.rate_micro, 'CLIENT').toDecimalString(), note: l.note, createdAt: l.created_at.toISOString(), expiresAt: l.expires_at.toISOString(),
    state: linkState(l, l.trade_ref !== null, now), clientName: l.client_name, tradeRef: l.trade_ref,
  }));
}
