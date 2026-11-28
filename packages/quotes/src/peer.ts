import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  DomainError, type MarketReferences, Money, type PeerEconomics, type PeerMeeting, Rate, computePeerEconomics, fitPeerDeal, peerLimitInrMinor, peerMeeting, requireUuid,
} from '@inrp2p/kernel';
import type { Db, DirectionValue, Executor, FixedSideValue, PeerMatchEndReason, TraderSide, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { executeCommand } from '@inrp2p/commands';
import { type ClientActor, type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { assertNewBusinessOpen, newBusinessState } from '@inrp2p/trades';
import { currentPricingPolicy, marketReferences, publishTraderRate } from '@inrp2p/pricing';
import { createTraderRoute, updateTraderRouteRegistration } from '@inrp2p/routes';
import { type OrderRow, closeUnstartedOrder, lockBlock, lockOrder, lockTrader } from '@inrp2p/trader-core';
import { networkFeePolicy, pricingOfUsdtTerms, recordQuoteNetworkFee, usdtNetworkTerms } from '@inrp2p/network';
import { lockRow, requireQuoteDecider } from './actors.ts';
import { memberClientCommand } from './desk-deals.ts';
import type { QuoteDeps } from './policy.ts';
import { businessNow } from './security.ts';

/**
 * One book (ADR 0033): a client waiting for a price is also a price for the other side. Two waiting requests meet; the one
 * that says yes first is the taker — its request is the trade's, it gets the quote — and the other is the maker: its
 * client acts as the route of that one deal through a personal trader profile (`status = 'PERSONAL'`), so the trade, the
 * escrow, the time to pay, the chat, a dispute, an unwind and every journal are the ordinary P2P code (ADR 0019).
 *
 * The taker's yes stands for an hour (`peer_match.taker_yes_until`); the maker's is "Start the deal". When the maker
 * starts, its order is accepted and the taker's quote is made in that transaction; the taker's standing yes accepts it in
 * the next (`peer.accept_standing`). Nothing touches the chain until both said yes.
 */

/** How long a taker's yes stands — and so how long the maker has to start. */
export const PEER_YES_MINUTES = 60;
/** A meeting's quote when the taker must say yes again (its standing yes could not be used): held like a waiting price. */
export const PEER_HELD_SECONDS = 600;
/** Strikes in this many days take a client out of the book… */
export const PEER_STRIKE_DAYS = 7;
/** …at this many. */
export const PEER_STRIKES_OUT = 3;
/** A price this close (basis points of the client's own) is worth telling the client about. */
export const PEER_NEARBY_BPS = 500;
/** And it is told about one at most this often, unless the price moved. */
export const PEER_TOLD_MINUTES = 60;
/** The other side of the book a meeting looks through, oldest first. */
const BOOK_DEPTH = 50;
const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

// ---- the policy -------------------------------------------------------------------------------------------------------

export interface PeerPolicy {
  readonly id: string;
  readonly enabled: boolean;
  readonly feeBps: number;
  readonly minDealUsdtMinor: bigint;
  readonly setAt: string;
}

export async function currentPeerPolicy(ex: Executor): Promise<PeerPolicy> {
  const r = await ex.selectFrom('peer_policy').selectAll().orderBy('set_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'no peer policy is recorded');
  return { id: r.id, enabled: r.enabled, feeBps: r.fee_bps, minDealUsdtMinor: r.min_deal_usdt_minor, setAt: r.set_at.toISOString() };
}

export interface SetPeerPolicyPayload {
  readonly enabled: boolean;
  /** Why, in the person's words — kept with the change. */
  readonly reason?: string;
  readonly feeBps?: number;
  /** Decimal USDT. */
  readonly minDealUsdt?: string;
}

/** `peer_policy.set` — whether waiting clients meet, INRP2P's fee on a meeting and its smallest deal (`pricing:configure`). */
export function setPeerPolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'pricing:configure', async (ctx, p: SetPeerPolicyPayload) => {
    const before = await currentPeerPolicy(ctx.tx);
    const feeBps = p.feeBps ?? before.feeBps;
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) throw new DomainError('INVALID_ARGUMENT', 'the fee is 0 to 100 basis points', { field: 'feeBps' });
    const min = p.minDealUsdt === undefined ? before.minDealUsdtMinor : Money.parse(p.minDealUsdt, 'USDT').minor;
    if (min < 1_000_000n || min > 100_000_000_000n) throw new DomainError('INVALID_ARGUMENT', 'the smallest meeting is 1 to 100,000 USDT', { field: 'minDealUsdt' });
    const row = await ctx.tx.insertInto('peer_policy')
      .values({ enabled: p.enabled === true, fee_bps: feeBps, min_deal_usdt_minor: min, set_by: actor.userId })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'peer_policy.set', entityType: 'peer_policy', entityId: row.id,
      before: { enabled: before.enabled, fee_bps: before.feeBps, min_deal_usdt: Money.ofMinor(before.minDealUsdtMinor, 'USDT') },
      after: { enabled: p.enabled === true, fee_bps: feeBps, min_deal_usdt: Money.ofMinor(min, 'USDT'), reason: typeof p.reason === 'string' ? p.reason.trim().slice(0, 500) : null },
    });
    if (p.enabled && !before.enabled) await lookNow(ctx, null);
    return { id: row.id };
  });
}

// ---- the book ---------------------------------------------------------------------------------------------------------

export interface BookRequest {
  readonly id: string;
  readonly ref: string;
  readonly client_id: string;
  readonly direction: DirectionValue;
  readonly fixed_side: FixedSideValue;
  readonly requested_base_minor: bigint | null;
  readonly requested_quote_minor: bigint | null;
  readonly target_rate_micro: bigint | null;
  readonly bank_account_id: string | null;
  readonly crypto_wallet_id: string | null;
  readonly source_wallet_id: string | null;
  readonly status: string;
  readonly desk_id: string | null;
  readonly waiting_since: Date | null;
  readonly waiting_until: Date | null;
  readonly wait_hours: number | null;
  readonly peer_paused_at: Date | null;
  readonly peer_told_at: Date | null;
  readonly peer_told_rate_micro: bigint | null;
  readonly created_by: string;
  readonly version: number;
}

const BOOK_COLUMNS = [
  'id', 'ref', 'client_id', 'direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor', 'target_rate_micro', 'bank_account_id', 'crypto_wallet_id',
  'source_wallet_id', 'status', 'desk_id', 'waiting_since', 'waiting_until', 'wait_hours', 'peer_paused_at', 'peer_told_at', 'peer_told_rate_micro', 'created_by', 'version',
] as const;

export async function readBookRequest(ex: Executor, requestId: string): Promise<BookRequest> {
  const r = await ex.selectFrom('trade_request').select(BOOK_COLUMNS).where('id', '=', requireUuid(requestId, 'requestId')).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'request not found');
  return r;
}

const amountOf = (r: BookRequest): bigint => (r.fixed_side === 'BASE' ? r.requested_base_minor : r.requested_quote_minor)!;
/** The side a client's request is as a route: a client selling USDT sells it to the taker; one buying buys it. */
const makerSideOf = (direction: DirectionValue): TraderSide => (direction === 'SELL_USDT' ? 'SELL_USDT' : 'BUY_USDT');

/** Where a maker's rupees and USDT come from and go back to — its own, active. */
interface MakerDestinations {
  readonly bankAccountId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly bankName: string;
  readonly last4: string;
}

/** Strikes of a client in the last `PEER_STRIKE_DAYS`. */
export async function strikesOf(ex: Executor, clientId: string): Promise<number> {
  const r = await ex.selectFrom('peer_strike').select(({ fn }) => fn.countAll<string>().as('n'))
    .where('client_id', '=', clientId).where('created_at', '>', sql<Date>`inrp2p_now() - make_interval(days => ${PEER_STRIKE_DAYS})`)
    .executeTakeFirstOrThrow();
  return Number.parseInt(r.n, 10);
}

/** Deals a client completed, as a client or as a meeting's maker: what its peer limit grows with. */
export async function completedDealsOf(ex: Executor, clientId: string): Promise<number> {
  const r = await sql<{ n: string }>`
    select (select count(*) from trade where client_id = ${clientId} and lifecycle_state = 'COMPLETED')
         + (select count(*) from trader_order o join trader_profile t on t.id = o.trader_id
             where t.client_id = ${clientId} and t.status = 'PERSONAL' and o.status = 'COMPLETED') as n`.execute(ex);
  return Number.parseInt(r.rows[0]!.n, 10);
}

/**
 * Whether a waiting request's client can be the other side of a meeting now, and with what: an active client of the
 * exchange that is not a trader of the programme, with fewer strikes than take it out, no peer pause, and an active bank
 * account and wallet of its own — the rupees and the USDT go to and come back from them. A personal side serves one deal
 * at a time.
 */
async function makerDestinationsOf(ex: Executor, r: BookRequest): Promise<MakerDestinations | null> {
  if (r.status !== 'OPEN' || r.desk_id !== null || r.waiting_until === null || r.peer_paused_at !== null) return null;
  const client = await ex.selectFrom('client').select(['status', 'exchange_access']).where('id', '=', r.client_id).executeTakeFirst();
  if (!client || client.status !== 'ACTIVE' || !client.exchange_access) return null;
  const profile = await ex.selectFrom('trader_profile').select(['id', 'status']).where('client_id', '=', r.client_id).executeTakeFirst();
  if (profile && profile.status !== 'PERSONAL') return null;
  if (profile) {
    const live = await ex.selectFrom('trader_order').select('id').where('trader_id', '=', profile.id).where('status', 'in', ['OFFERED', 'ACCEPTED', 'IN_PROGRESS']).executeTakeFirst();
    if (live) return null;
  }
  if ((await strikesOf(ex, r.client_id)) >= PEER_STRIKES_OUT) return null;
  const bank = await ex.selectFrom('bank_account').select(['id', 'bank_name', 'account_last4'])
    .where('client_id', '=', r.client_id).where('status', '=', 'ACTIVE')
    .$if(r.direction === 'SELL_USDT', (q) => q.where('id', '=', r.bank_account_id!))
    .orderBy('created_at').orderBy('id').executeTakeFirst();
  const wallet = await ex.selectFrom('crypto_wallet').select(['id', 'address'])
    .where('client_id', '=', r.client_id).where('status', '=', 'ACTIVE').where('purpose', '<>', 'SOURCE')
    .$if(r.direction === 'BUY_USDT', (q) => q.where('id', '=', r.crypto_wallet_id!))
    .orderBy(sql`id = ${r.source_wallet_id ?? r.crypto_wallet_id}`, 'desc').orderBy('created_at').orderBy('id').executeTakeFirst();
  if (!bank || !wallet) return null;
  return { bankAccountId: bank.id, walletId: wallet.id, walletAddress: wallet.address, bankName: bank.bank_name, last4: bank.account_last4 };
}

/** Whether two clients are one owner: a bank account or a wallet address on both files. They never meet. */
async function sameOwner(ex: Executor, a: string, b: string): Promise<boolean> {
  const r = await sql<{ shared: boolean }>`
    select exists (select 1 from bank_account x join bank_account y on y.account_hmac = x.account_hmac
                    where x.client_id = ${a} and y.client_id = ${b} and x.status <> 'ARCHIVED' and y.status <> 'ARCHIVED')
        or exists (select 1 from crypto_wallet x join crypto_wallet y on y.address = x.address
                    where x.client_id = ${a} and y.client_id = ${b} and x.status <> 'ARCHIVED' and y.status <> 'ARCHIVED') as shared`.execute(ex);
  return r.rows[0]!.shared;
}

/** What a meeting is priced on now: the policy, the market, and the network's allowance (GasFree), or why nothing. */
export interface BookContext {
  readonly policy: PeerPolicy;
  readonly market: MarketReferences;
  readonly allowanceMinor: bigint;
}

/** ADR 0034: read by the robot too — the book it points clients at is the book they will meet in. */
export async function bookContext(ex: Executor): Promise<BookContext | null> {
  const policy = await currentPeerPolicy(ex);
  if (!policy.enabled) return null;
  try {
    if ((await networkFeePolicy(ex)).resourceMode !== 'GASFREE') return null;
    const terms = await usdtNetworkTerms(ex, { funderTraderId: null });
    const market = await marketReferences(ex, await currentPricingPolicy(ex));
    return { policy, market, allowanceMinor: terms.allowanceUsdtMinor };
  } catch (e) {
    if (e instanceof DomainError && (e.code === 'NETWORK_FEES_UNKNOWN' || e.code === 'NOT_FOUND')) return null;
    throw e;
  }
}

export interface PeerOffer {
  readonly maker: BookRequest;
  readonly meeting: Extract<PeerMeeting, { kind: 'CROSS' | 'GAP' }>;
  /** For a crossing: the meeting's economics at the largest size both allow; null for a gap. */
  readonly economics: PeerEconomics | null;
}

/** Whether rate `a` is better than `b` for a taker of this direction: a buyer pays less, a seller gets more. */
const betterFor = (direction: DirectionValue, a: bigint, b: bigint): boolean => (direction === 'BUY_USDT' ? a < b : a > b);

/**
 * The other client a taker would meet now: the best crossing price that fits both, else the nearest gap — or null.
 * Read without locks: the meeting itself re-reads both under them.
 */
export async function bestPeerFor(ex: Executor, taker: BookRequest, book: BookContext): Promise<PeerOffer | null> {
  const others: BookRequest[] = await ex.selectFrom('trade_request as r').select(['r.id', 'r.ref', 'r.client_id', 'r.direction', 'r.fixed_side', 'r.requested_base_minor', 'r.requested_quote_minor',
    'r.target_rate_micro', 'r.bank_account_id', 'r.crypto_wallet_id', 'r.source_wallet_id', 'r.status', 'r.desk_id', 'r.waiting_since', 'r.waiting_until', 'r.wait_hours',
    'r.peer_paused_at', 'r.peer_told_at', 'r.peer_told_rate_micro', 'r.created_by', 'r.version'])
    .where('r.status', '=', 'OPEN').where('r.waiting_until', 'is not', null).where('r.desk_id', 'is', null).where('r.peer_paused_at', 'is', null)
    .where('r.direction', '<>', taker.direction).where('r.client_id', '<>', taker.client_id)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('peer_match as pm').select('pm.id').where('pm.status', '=', 'WAITING_MAKER')
      .where((w) => w.or([w('pm.maker_request_id', '=', w.ref('r.id')), w('pm.taker_request_id', '=', w.ref('r.id'))])))))
    .orderBy('r.waiting_since').orderBy('r.id').limit(BOOK_DEPTH).execute();
  if (others.length === 0) return null;
  const takerCap = peerLimitInrMinor(await completedDealsOf(ex, taker.client_id));
  const prices = { bidMicro: book.market.SELL_USDT?.micro ?? null, askMicro: book.market.BUY_USDT?.micro ?? null };
  let cross: PeerOffer | null = null;
  let gap: PeerOffer | null = null;
  for (const m of others) {
    const meeting = peerMeeting({ direction: taker.direction, limitMicro: taker.target_rate_micro }, { direction: m.direction, limitMicro: m.target_rate_micro }, prices, book.policy.feeBps);
    if (meeting.kind === 'NO_MARKET') continue;
    if (!(await makerDestinationsOf(ex, m)) || (await sameOwner(ex, taker.client_id, m.client_id))) continue;
    if (meeting.kind === 'CROSS') {
      if (cross && !betterFor(taker.direction, meeting.takerRateMicro, (cross.meeting as Extract<PeerMeeting, { kind: 'CROSS' }>).takerRateMicro)) continue;
      const makerCap = peerLimitInrMinor(await completedDealsOf(ex, m.client_id));
      const economics = fitPeerDeal({
        direction: taker.direction, fixedSide: taker.fixed_side, takerRateMicro: meeting.takerRateMicro, makerRateMicro: meeting.makerRateMicro,
        allowance: Money.ofMinor(book.allowanceMinor, 'USDT'),
        limits: { takerAmountMinor: amountOf(taker), maker: { fixedSide: m.fixed_side, amountMinor: amountOf(m) }, maxInrMinor: takerCap < makerCap ? takerCap : makerCap, minBaseMinor: book.policy.minDealUsdtMinor },
      });
      if (economics) cross = { maker: m, meeting, economics };
    } else if (!gap || betterFor(taker.direction, meeting.takerMeetsAtMicro, (gap.meeting as Extract<PeerMeeting, { kind: 'GAP' }>).takerMeetsAtMicro)) {
      gap = { maker: m, meeting, economics: null };
    }
  }
  return cross ?? gap;
}

// ---- what a client sees -----------------------------------------------------------------------------------------------

/** Another client's price, as the client of `requestId` would deal at it — all-in for it. */
export interface PeerPriceView {
  /** READY: the two cross, it can meet at once; NEAR: the other client is that far from its own price. */
  readonly kind: 'READY' | 'NEAR';
  /** The rate this client would deal at, all-in. */
  readonly rate: string;
  /** For READY: what the meeting would be, in this client's terms. */
  readonly deal: { readonly base: string; readonly inr: string; readonly network: string } | null;
  /** About how much the other client wants, in whole USDT. */
  readonly otherAmountUsdt: string | null;
}

export interface LiveMeetingView {
  readonly ref: string;
  readonly role: 'TAKER' | 'MAKER';
  readonly status: 'WAITING_MAKER' | 'STARTED' | 'ENDED';
  /** This client's own rate, all-in. */
  readonly rate: string;
  /** This client's own USDT (received or sent), the rupees, and its share of the network. */
  readonly base: string;
  readonly inr: string;
  readonly network: string;
  readonly yesUntil: string;
  readonly orderRef: string | null;
  readonly tradeRef: string | null;
}

export interface PeerFacts {
  readonly enabled: boolean;
  readonly offer: PeerPriceView | null;
  readonly meeting: LiveMeetingView | null;
  /** A maker that stayed silent: not a price for others until it says it is still looking. */
  readonly paused: boolean;
}

const decimal = (micro: bigint): string => Rate.ofMicro(micro, 'CLIENT').toDecimalString();

async function meetingView(ex: Executor, pm: { id: string }, clientId: string): Promise<LiveMeetingView> {
  const m = await ex.selectFrom('peer_match as pm')
    .leftJoin('trader_order as o', 'o.id', 'pm.order_id')
    .leftJoin('trade as t', 't.id', 'pm.trade_id')
    .select(['pm.ref', 'pm.status', 'pm.taker_client_id', 'pm.taker_rate_micro', 'pm.maker_rate_micro', 'pm.base_minor', 'pm.inr_minor', 'pm.route_base_minor',
      'pm.network_allowance_minor', 'pm.taker_yes_until', 'o.ref as order_ref', 't.ref as trade_ref'])
    .where('pm.id', '=', pm.id).executeTakeFirstOrThrow();
  const taker = m.taker_client_id === clientId;
  const takerNet = m.network_allowance_minor / 2n;
  return {
    ref: m.ref, role: taker ? 'TAKER' : 'MAKER', status: m.status,
    rate: decimal(taker ? m.taker_rate_micro : m.maker_rate_micro),
    base: Money.ofMinor(taker ? m.base_minor : m.route_base_minor, 'USDT').toDecimalString(),
    inr: Money.ofMinor(m.inr_minor, 'INR').toDecimalString(),
    network: Money.ofMinor(taker ? takerNet : m.network_allowance_minor - takerNet, 'USDT').toDecimalString(),
    yesUntil: m.taker_yes_until.toISOString(),
    orderRef: m.order_ref ?? null, tradeRef: m.trade_ref ?? null,
  };
}

/** ADR 0033: the book as a waiting client sees it — another client's best price, a meeting it is in, a pause. */
export async function peerFactsOf(ex: Executor, requestId: string): Promise<PeerFacts> {
  const r = await readBookRequest(ex, requestId);
  const live = await ex.selectFrom('peer_match').select(['id']).where('status', '=', 'WAITING_MAKER')
    .where((w) => w.or([w('taker_request_id', '=', r.id), w('maker_request_id', '=', r.id)])).executeTakeFirst();
  const book = r.status === 'OPEN' && r.desk_id === null ? await bookContext(ex) : null;
  const meeting = live ? await meetingView(ex, live, r.client_id) : null;
  if (!book || meeting || r.waiting_until === null) return { enabled: book !== null, offer: null, meeting, paused: r.peer_paused_at !== null };
  const best = await bestPeerFor(ex, r, book);
  const otherUsdt = (m: BookRequest): string | null => {
    const ref = (m.direction === 'SELL_USDT' ? book.market.SELL_USDT : book.market.BUY_USDT)?.micro ?? m.target_rate_micro;
    const usdt = m.fixed_side === 'BASE' ? m.requested_base_minor! : ref ? (m.requested_quote_minor! * 10_000_000_000n) / ref : null;
    return usdt === null ? null : (usdt / 1_000_000n).toString();
  };
  let offer: PeerPriceView | null = null;
  if (best?.meeting.kind === 'CROSS' && best.economics) {
    const e = best.economics;
    offer = {
      kind: 'READY', rate: decimal(best.meeting.takerRateMicro), otherAmountUsdt: otherUsdt(best.maker),
      deal: { base: e.base.toDecimalString(), inr: e.clientInr.toDecimalString(), network: e.clientNetworkBase.toDecimalString() },
    };
  } else if (best?.meeting.kind === 'GAP') {
    const own = r.target_rate_micro;
    const at = best.meeting.takerMeetsAtMicro;
    const near = own === null || (at > own ? at - own : own - at) * 10_000n <= own * BigInt(PEER_NEARBY_BPS);
    if (near) offer = { kind: 'NEAR', rate: decimal(at), deal: null, otherAmountUsdt: otherUsdt(best.maker) };
  }
  return { enabled: true, offer, meeting, paused: r.peer_paused_at !== null };
}

// ---- the maker's personal side ----------------------------------------------------------------------------------------

/**
 * The client's personal side for a meeting's direction: its PERSONAL profile (created the first time), the route of that
 * side and its block — kept on the client's own bank account and wallet of this request. Never a programme trader: no
 * approval, reserve, availability or price of its own. The caller holds the requests' locks; the profile is locked here.
 */
async function personalSideInTx(ctx: TxContext, maker: BookRequest, dest: MakerDestinations): Promise<{ traderId: string; routeId: string; blockId: string }> {
  const side = makerSideOf(maker.direction);
  let profile = await ctx.tx.selectFrom('trader_profile').select(['id', 'status', 'bank_account_id', 'wallet_id', 'offers_buy', 'offers_sell']).where('client_id', '=', maker.client_id).executeTakeFirst();
  const appliedBy = requireUuid(maker.created_by, 'maker');
  if (!profile) {
    const typicalUsdt = maker.fixed_side === 'BASE' ? maker.requested_base_minor! : 1_000_000n;
    const typicalInr = maker.fixed_side === 'QUOTE' ? maker.requested_quote_minor! : 100n;
    const created = await ctx.tx.insertInto('trader_profile')
      .values({
        client_id: maker.client_id, status: 'PERSONAL', offers_buy: side === 'BUY_USDT', offers_sell: side === 'SELL_USDT',
        typical_inr_minor: side === 'BUY_USDT' ? typicalInr : null, typical_usdt_minor: side === 'SELL_USDT' ? typicalUsdt : null,
        bank_account_id: dest.bankAccountId, wallet_id: dest.walletId, applied_by: appliedBy,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'peer.personal_side_opened', entityType: 'trader_profile', entityId: created.id, after: { client_id: maker.client_id, side, status: 'PERSONAL' } });
    profile = { id: created.id, status: 'PERSONAL', bank_account_id: dest.bankAccountId, wallet_id: dest.walletId, offers_buy: side === 'BUY_USDT', offers_sell: side === 'SELL_USDT' };
  }
  if (profile.status !== 'PERSONAL') throw new DomainError('PEER_NOT_AVAILABLE', 'this client trades as a trader: it meets clients through its own prices');
  await lockTrader(ctx, profile.id);
  const needsOffer = side === 'BUY_USDT' ? !profile.offers_buy : !profile.offers_sell;
  if (profile.bank_account_id !== dest.bankAccountId || profile.wallet_id !== dest.walletId || needsOffer) {
    await ctx.tx.updateTable('trader_profile')
      .set({
        bank_account_id: dest.bankAccountId, wallet_id: dest.walletId,
        ...(side === 'BUY_USDT' ? { offers_buy: true, typical_inr_minor: sql<bigint>`coalesce(typical_inr_minor, 100)` } : { offers_sell: true, typical_usdt_minor: sql<bigint>`coalesce(typical_usdt_minor, 1000000)` }),
        updated_at: sql<Date>`inrp2p_now()`, version: sql<number>`version + 1`,
      })
      .where('id', '=', profile.id).execute();
    await updateTraderRouteRegistration(ctx, { traderId: profile.id, registeredRouteAddress: dest.walletAddress, registeredPayoutIdentity: `${dest.bankName} ••••${dest.last4}`, reason: 'the client’s own details for this meeting' });
  }
  const block = await ctx.tx.selectFrom('trader_block').select(['id', 'route_id']).where('trader_id', '=', profile.id).where('side', '=', side).executeTakeFirst();
  if (block) return { traderId: profile.id, routeId: block.route_id, blockId: block.id };
  const route = await createTraderRoute(ctx, {
    traderId: profile.id,
    name: `Client ${maker.ref.slice(0, 40)} · ${side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT'}`,
    direction: side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT',
    registeredRouteAddress: dest.walletAddress,
    registeredPayoutIdentity: `${dest.bankName} ••••${dest.last4}`,
  });
  const created = await ctx.tx.insertInto('trader_block').values({ trader_id: profile.id, side, route_id: route.routeId }).returning(['id']).executeTakeFirstOrThrow();
  return { traderId: profile.id, routeId: route.routeId, blockId: created.id };
}

// ---- the taker says yes -----------------------------------------------------------------------------------------------

export interface MeetPayload {
  readonly requestId: string;
  /** The rate the client was shown and said yes to, all-in for it (decimal rupees per USDT). */
  readonly rate: string;
}

/** Locks two requests in id order (the global order within one table). */
async function lockRequests(ctx: TxContext, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockRow(ctx.tx, 'trade_request', 'trade_request', id);
}

/** A live meeting of a request, as taker or maker. */
async function liveMatchOf(ex: Executor, requestId: string) {
  return ex.selectFrom('peer_match').selectAll().where('status', '=', 'WAITING_MAKER')
    .where((w) => w.or([w('taker_request_id', '=', requestId), w('maker_request_id', '=', requestId)])).executeTakeFirst();
}

/**
 * `peer.meet` — a waiting client meets another client's price it was shown. Its own bound moves to that price if it has
 * to (its own act, audited); the other client is offered the deal and has an hour to start it; this client's yes stands
 * that long. Refused when the price moved — the client is shown the new one.
 */
export function meetPeer(actor: ClientActor) {
  return memberClientCommand(actor, async (ctx, p: MeetPayload, clientId) => {
    await requireQuoteDecider(ctx.tx, actor.userId, clientId, { requireVerifiedEmail: false });
    await assertNewBusinessOpen(ctx.tx);
    const requestId = requireUuid(p.requestId, 'requestId');
    const shown = Rate.parse(p.rate, 'CLIENT').micro;
    await lockRow(ctx.tx, 'trade_request', 'trade_request', requestId);
    let taker = await readBookRequest(ctx.tx, requestId);
    if (taker.client_id !== clientId) throw new DomainError('NOT_FOUND', 'request not found');
    if (taker.status !== 'OPEN' || taker.desk_id !== null) throw new DomainError('REQUEST_NOT_OPEN', `request is ${taker.status}`);
    if (await liveMatchOf(ctx.tx, taker.id)) throw new DomainError('PEER_MATCH_LIVE', 'this request is already meeting another client');
    const book = await bookContext(ctx.tx);
    if (!book) throw new DomainError('PEER_OFF', 'meeting other clients is not open right now');

    // The client's own bound moves to the price it said yes to, if it has to — never the other way.
    const buy = taker.direction === 'BUY_USDT';
    const bound = taker.target_rate_micro;
    if (bound === null || (buy ? bound < shown : bound > shown)) {
      await ctx.tx.updateTable('trade_request').set({ target_rate_micro: shown, last_activity_at: sql<Date>`inrp2p_now()`, version: taker.version + 1 }).where('id', '=', taker.id).execute();
      await appendAudit(ctx, { action: 'request.bound_moved', entityType: 'trade_request', entityId: taker.id, before: { target_rate: bound === null ? null : Rate.ofMicro(bound, 'CLIENT') }, after: { target_rate: Rate.ofMicro(shown, 'CLIENT'), to_meet: true } });
      taker = await readBookRequest(ctx.tx, taker.id);
    }
    // A request that never waited starts waiting now: it stays open, and the search goes on, while the other side decides.
    if (taker.waiting_until === null) {
      const now = await businessNow(ctx.tx);
      const until = new Date(now.getTime() + (taker.wait_hours ?? 24) * 3_600_000);
      await ctx.tx.updateTable('trade_request').set({ waiting_since: now, waiting_until: until, no_price_reason: 'NO_OFFER', version: taker.version + 1 }).where('id', '=', taker.id).execute();
      taker = await readBookRequest(ctx.tx, taker.id);
    }

    const best = await bestPeerFor(ctx.tx, taker, book);
    if (!best || best.meeting.kind !== 'CROSS' || !best.economics) throw new DomainError('PEER_PRICE_MOVED', 'that price is not there any more');
    await lockRow(ctx.tx, 'trade_request', 'trade_request', best.maker.id);
    const maker = await readBookRequest(ctx.tx, best.maker.id);
    const dest = await makerDestinationsOf(ctx.tx, maker);
    if (!dest || (await liveMatchOf(ctx.tx, maker.id))) throw new DomainError('PEER_PRICE_MOVED', 'that price is not there any more');
    const meeting = best.meeting;
    if (betterFor(taker.direction, shown, meeting.takerRateMicro)) throw new DomainError('PEER_PRICE_MOVED', `the price is now ₹${decimal(meeting.takerRateMicro)}`, { rate: decimal(meeting.takerRateMicro) });
    const e = best.economics;

    const sideOf = await personalSideInTx(ctx, maker, dest);
    const now = await businessNow(ctx.tx);
    const until = new Date(now.getTime() + PEER_YES_MINUTES * 60_000);
    const yesUntil = maker.waiting_until! < until ? maker.waiting_until! : until;
    const order = await ctx.tx.insertInto('trader_order')
      .values({
        trader_id: sideOf.traderId, block_id: sideOf.blockId, route_id: sideOf.routeId, trade_request_id: taker.id, side: makerSideOf(maker.direction),
        base_minor: e.routeBase.minor, inr_minor: e.clientInr.minor, rate_micro: meeting.makerRateMicro,
        capacity_minor: taker.direction === 'SELL_USDT' ? e.clientInr.minor : e.routeBase.minor,
        planned_client_rate_micro: meeting.takerRateMicro, offered_by: `PEER:${taker.ref}`, offer_expires_at: yesUntil,
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    const pm = await ctx.tx.insertInto('peer_match')
      .values({
        policy_id: book.policy.id, taker_request_id: taker.id, maker_request_id: maker.id, taker_client_id: taker.client_id, maker_client_id: maker.client_id,
        maker_trader_id: sideOf.traderId, direction: taker.direction, fixed_side: taker.fixed_side,
        amount_minor: taker.fixed_side === 'BASE' ? e.base.minor : e.clientInr.minor,
        taker_rate_micro: meeting.takerRateMicro, maker_rate_micro: meeting.makerRateMicro, reference_mid_micro: meeting.midMicro, fee_bps: book.policy.feeBps,
        base_minor: e.base.minor, inr_minor: e.clientInr.minor, route_base_minor: e.routeBase.minor, network_allowance_minor: e.networkFeeBase.minor,
        taker_yes_by: actor.userId, taker_yes_at: now, taker_yes_until: yesUntil, order_id: order.id,
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await ctx.tx.updateTable('trade_request').set({ last_activity_at: sql<Date>`inrp2p_now()` }).where('id', 'in', [taker.id, maker.id]).execute();
    await appendAudit(ctx, {
      action: 'peer.met', entityType: 'peer_match', entityId: pm.id,
      after: {
        ref: pm.ref, taker_request_id: taker.id, maker_request_id: maker.id, order_id: order.id, direction: taker.direction,
        taker_rate: Rate.ofMicro(meeting.takerRateMicro, 'CLIENT'), maker_rate: Rate.ofMicro(meeting.makerRateMicro, 'ROUTE'),
        base: e.base, inr: e.clientInr, maker_base: e.routeBase, network: e.networkFeeBase, taker_network: e.clientNetworkBase, net_margin: e.netMarginBase,
        fee_bps: book.policy.feeBps, yes_until: yesUntil, by: actor.userId,
      },
    });
    // One event per person told (an inbox row is one event's): the maker is asked to start, the taker told its yes stands.
    await enqueueOutbox(ctx, { type: 'peer.offered', aggregateType: 'peer_match', aggregateId: pm.id, payload: { matchId: pm.id, clientId: maker.client_id, role: 'MAKER' } });
    await enqueueOutbox(ctx, { type: 'peer.waiting', aggregateType: 'peer_match', aggregateId: pm.id, payload: { matchId: pm.id, clientId: taker.client_id, role: 'TAKER' } });
    return { matchRef: pm.ref, yesUntil: yesUntil.toISOString() };
  });
}

// ---- the maker starts -------------------------------------------------------------------------------------------------

async function matchByRef(ex: Executor, ref: unknown) {
  if (typeof ref !== 'string' || !/^PM-[0-9A-Za-z-]{1,40}$/.test(ref)) throw new DomainError('NOT_FOUND', 'meeting not found');
  const m = await ex.selectFrom('peer_match').selectAll().where('ref', '=', ref).executeTakeFirst();
  if (!m) throw new DomainError('NOT_FOUND', 'meeting not found');
  return m;
}

/**
 * `peer.start` — the maker says yes. Its order is accepted at the meeting's rate, its side holds the deal, and the
 * taker's quote is made at once; the taker's standing yes accepts it in the next step (`peer.accept_standing`). If the
 * deal's network was read anew and the amounts moved, the taker is asked again instead, its quote held ten minutes.
 */
export function startPeer(actor: ClientActor) {
  return memberClientCommand(actor, async (ctx, p: { matchRef: string }, clientId) => {
    await requireQuoteDecider(ctx.tx, actor.userId, clientId, { requireVerifiedEmail: false });
    await assertNewBusinessOpen(ctx.tx);
    const m0 = await matchByRef(ctx.tx, p.matchRef);
    if (m0.maker_client_id !== clientId) throw new DomainError('NOT_FOUND', 'meeting not found');
    await lockRequests(ctx, [m0.taker_request_id, m0.maker_request_id]);
    const m = await ctx.tx.selectFrom('peer_match').selectAll().where('id', '=', m0.id).executeTakeFirstOrThrow();
    const now = await businessNow(ctx.tx);
    if (m.status !== 'WAITING_MAKER' || m.taker_yes_until <= now) throw new DomainError('PEER_MATCH_OVER', 'this meeting is over: the other client is no longer waiting for you');
    const taker = await readBookRequest(ctx.tx, m.taker_request_id);
    const maker = await readBookRequest(ctx.tx, m.maker_request_id);
    if (taker.status !== 'OPEN' || maker.status !== 'OPEN') throw new DomainError('PEER_MATCH_OVER', 'this meeting is over');

    await lockTrader(ctx, m.maker_trader_id);
    const order = await lockOrder(ctx, m.order_id!);
    if (order.status !== 'OFFERED' || order.offer_expires_at <= now) throw new DomainError('PEER_MATCH_OVER', 'this meeting is over');

    // The deal as it stands now: the network read again; a different allowance moves the amounts, and the taker is asked again.
    const terms = await usdtNetworkTerms(ctx.tx, { funderTraderId: null });
    const e = computePeerEconomics(m.fixed_side === 'BASE'
      ? { direction: m.direction, fixedSide: 'BASE', amount: Money.ofMinor(m.amount_minor, 'USDT'), takerRateMicro: m.taker_rate_micro, makerRateMicro: m.maker_rate_micro, allowance: Money.ofMinor(terms.allowanceUsdtMinor, 'USDT') }
      : { direction: m.direction, fixedSide: 'QUOTE', amount: Money.ofMinor(m.amount_minor, 'INR'), takerRateMicro: m.taker_rate_micro, makerRateMicro: m.maker_rate_micro, allowance: Money.ofMinor(terms.allowanceUsdtMinor, 'USDT') });
    const same = e.base.minor === m.base_minor && e.clientInr.minor === m.inr_minor && e.routeBase.minor === m.route_base_minor;
    if (!same && (e.routeBase.minor !== order.base_minor || e.clientInr.minor !== order.inr_minor)) {
      throw new DomainError('PEER_MATCH_OVER', 'the network’s fee changed: this meeting has to be made again');
    }

    const snapshot = await publishTraderRate(ctx, { routeId: order.route_id, direction: m.direction, rate: Rate.ofMicro(m.maker_rate_micro, 'ROUTE') });
    const expiresAt = new Date(now.getTime() + PEER_HELD_SECONDS * 1000);
    const holdUntil = new Date(expiresAt.getTime() + 60_000);
    const block = await lockBlock(ctx, order.block_id);
    const reserved = block.reserved_minor + order.capacity_minor;
    await ctx.tx.updateTable('trader_block')
      .set({ capacity_minor: block.capacity_minor > reserved ? block.capacity_minor : reserved, reserved_minor: reserved, updated_at: sql<Date>`inrp2p_now()`, version: block.version + 1 })
      .where('id', '=', block.id).execute();
    await ctx.tx.updateTable('trader_order')
      .set({ status: 'ACCEPTED', accepted_at: now, accepted_by: actor.userId, route_rate_snapshot_id: snapshot.snapshotId, hold_until: holdUntil, version: order.version + 1 })
      .where('id', '=', order.id).execute();

    const quote = await ctx.tx.insertInto('quote')
      .values({
        trade_request_id: taker.id, client_id: taker.client_id, direction: m.direction, fixed_side: m.fixed_side,
        base_minor: e.base.minor, quote_inr_minor: e.clientInr.minor, client_rate_micro: m.taker_rate_micro, route_rate_micro: m.maker_rate_micro,
        route_rate_snapshot_id: snapshot.snapshotId, route_id: order.route_id, route_value_inr_minor: e.routeInr.minor, gross_margin_inr_minor: e.grossMargin.minor,
        route_base_minor: e.routeBase.minor, gross_margin_base_minor: e.grossMarginBase.minor, network_fee_base_minor: e.networkFeeBase.minor,
        client_network_base_minor: e.clientNetworkBase.minor, network: 'TRON', bank_account_id: taker.bank_account_id, crypto_wallet_id: taker.crypto_wallet_id,
        valid_for_seconds: PEER_HELD_SECONDS, is_counter: false, negative_margin_reason: null, created_by: 'SYSTEM:peer_match',
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    // A meeting keeps INRP2P's fee, not the policy's minimum margin: its terms say so (the network is the clients').
    const network = pricingOfUsdtTerms({ ...terms, minNetMarginInrMinor: 0n }, { direction: m.direction, clientRateMicro: m.taker_rate_micro, grossMarginBaseMinor: e.grossMarginBase.minor, traderOrderId: order.id });
    await recordQuoteNetworkFee(ctx, quote.id, network);
    await ctx.tx.updateTable('quote').set({ status: 'SENT', sent_at: now, expires_at: expiresAt, sent_by: 'SYSTEM:peer_match' }).where('id', '=', quote.id).execute();
    await ctx.tx.updateTable('trade_request').set({ status: 'QUOTED', waiting_until: null, last_activity_at: sql<Date>`inrp2p_now()`, version: taker.version + 1 }).where('id', '=', taker.id).execute();
    await ctx.tx.updateTable('peer_match').set({ maker_yes_by: actor.userId, maker_yes_at: now, quote_id: quote.id }).where('id', '=', m.id).execute();
    await appendAudit(ctx, {
      action: 'peer.started', entityType: 'peer_match', entityId: m.id,
      after: { ref: m.ref, order_id: order.id, quote_id: quote.id, quote_ref: quote.ref, by: actor.userId, terms_held: same, expires_at: expiresAt },
    });
    if (!same) {
      await endMatchRow(ctx, m.id, 'TERMS_CHANGED');
      await enqueueOutbox(ctx, { type: 'quote.sent', aggregateType: 'quote', aggregateId: quote.id, payload: { quoteId: quote.id, expiresAt: expiresAt.toISOString(), clientId: taker.client_id, held: true } });
    }
    return { matchId: m.id, matchRef: m.ref, quoteRef: quote.ref, standing: same };
  });
}

/** The trade a meeting's quote opened: the maker's request closes MATCHED and the meeting is STARTED. Called by acceptance. */
export async function peerTradeOpenedInTx(ctx: TxContext, input: { quoteId: string; tradeId: string; tradeRef: string; routeId: string }): Promise<void> {
  const personal = await ctx.tx.selectFrom('liquidity_route as r').innerJoin('trader_profile as t', 't.id', 'r.trader_id').select('t.id')
    .where('r.id', '=', input.routeId).where('t.status', '=', 'PERSONAL').executeTakeFirst();
  if (!personal) return;
  const m = await ctx.tx.selectFrom('peer_match').selectAll().where('quote_id', '=', input.quoteId).executeTakeFirst();
  if (!m) throw new DomainError('INVALID_ARGUMENT', 'a quote on a client’s personal side belongs to a meeting');
  if (m.status === 'WAITING_MAKER') {
    await ctx.tx.updateTable('peer_match').set({ status: 'STARTED', trade_id: input.tradeId }).where('id', '=', m.id).execute();
  }
  // The maker's request is done: its client is the other side of this trade. Updated in place — the request lock was taken
  // by the meeting's start; acceptance comes after it in the global order.
  const maker = await ctx.tx.selectFrom('trade_request').select(['status', 'version']).where('id', '=', m.maker_request_id).executeTakeFirstOrThrow();
  if (maker.status === 'OPEN') {
    await ctx.tx.updateTable('trade_request')
      .set({ status: 'MATCHED', status_reason: `the other side of ${input.tradeRef}`, waiting_until: null, closed_at: sql<Date>`inrp2p_now()`, last_activity_at: sql<Date>`inrp2p_now()`, version: maker.version + 1 })
      .where('id', '=', m.maker_request_id).execute();
    await appendAudit(ctx, { action: 'request.matched', entityType: 'trade_request', entityId: m.maker_request_id, before: { status: 'OPEN' }, after: { status: 'MATCHED', trade_id: input.tradeId, match: m.ref } });
  }
  await appendAudit(ctx, { action: 'peer.deal_started', entityType: 'peer_match', entityId: m.id, after: { ref: m.ref, trade_id: input.tradeId, trade_ref: input.tradeRef } });
  await enqueueOutbox(ctx, { type: 'peer.deal_started', aggregateType: 'peer_match', aggregateId: m.id, payload: { matchId: m.id, tradeId: input.tradeId, clientId: m.maker_client_id, role: 'MAKER' } });
}

// ---- endings ----------------------------------------------------------------------------------------------------------

/** Ends a live meeting's row; the caller has settled its order. */
async function endMatchRow(ctx: TxContext, matchId: string, reason: PeerMatchEndReason): Promise<void> {
  await ctx.tx.updateTable('peer_match').set({ status: 'ENDED', end_reason: reason, ended_at: sql<Date>`inrp2p_now()` }).where('id', '=', matchId).execute();
}

/**
 * Ends a live meeting: a silent maker gets a strike and its request a pause, both clients are told, and both requests are
 * looked at again. With `closeOrder`, its maker's offered order is closed here too — for a caller that has locked nothing
 * past the two requests; otherwise the request's own closing takes it (the taker's), or the peer sweep does (`closeEndedOffers`).
 * The caller holds the locks of the requests whose state it changes.
 */
export async function endMeetingInTx(ctx: TxContext, matchId: string, reason: PeerMatchEndReason, opts: { closeOrder?: boolean } = {}): Promise<void> {
  const m = await ctx.tx.selectFrom('peer_match').selectAll().where('id', '=', matchId).executeTakeFirstOrThrow();
  if (m.status !== 'WAITING_MAKER') return;
  if (m.order_id && opts.closeOrder !== false) {
    await lockTrader(ctx, m.maker_trader_id);
    const order: OrderRow = await lockOrder(ctx, m.order_id);
    if (order.status === 'OFFERED') await closeUnstartedOrder(ctx, order, reason === 'MAKER_DECLINED' ? 'DECLINED' : reason === 'MAKER_SILENT' ? 'EXPIRED' : 'WITHDRAWN', 'REQUEST_CLOSED', peerCloseNote(reason));
  }
  await endMatchRow(ctx, m.id, reason);
  if (reason === 'MAKER_SILENT') {
    await ctx.tx.insertInto('peer_strike').values({ client_id: m.maker_client_id, kind: 'MAKER_SILENT', peer_match_id: m.id }).onConflict((oc) => oc.doNothing()).execute();
    await ctx.tx.updateTable('trade_request').set({ peer_paused_at: sql<Date>`inrp2p_now()` }).where('id', '=', m.maker_request_id).where('status', '=', 'OPEN').execute();
  }
  await appendAudit(ctx, { action: 'peer.ended', entityType: 'peer_match', entityId: m.id, before: { status: 'WAITING_MAKER' }, after: { status: 'ENDED', reason } });
  // Each side is told what it did not do itself.
  if (reason !== 'MAKER_DECLINED' && reason !== 'MAKER_WITHDREW') {
    await enqueueOutbox(ctx, { type: 'peer.ended', aggregateType: 'peer_match', aggregateId: m.id, payload: { matchId: m.id, reason, clientId: m.maker_client_id, role: 'MAKER' } });
  }
  if (reason !== 'TAKER_WITHDREW') {
    await enqueueOutbox(ctx, { type: 'peer.ended', aggregateType: 'peer_match', aggregateId: m.id, payload: { matchId: m.id, reason, clientId: m.taker_client_id, role: 'TAKER' } });
  }
  await lookNow(ctx, null);
}

const peerCloseNote = (reason: PeerMatchEndReason): string =>
  reason === 'MAKER_DECLINED' ? 'You did not start this deal.'
    : reason === 'MAKER_SILENT' ? 'The hour to start this deal passed.'
      : 'The other client is no longer waiting.';

/**
 * A request that closes or changes ends its live meeting first — as taker or as maker. Called by every path that closes a
 * request (withdraw, replace, decline, expire, the end of a wait) while it holds that request's lock.
 */
export async function endMeetingsOfRequestInTx(ctx: TxContext, requestId: string, reason: 'TAKER_WITHDREW' | 'MAKER_WITHDREW' | 'CLOSED'): Promise<void> {
  const m = await liveMatchOf(ctx.tx, requestId);
  if (!m) return;
  // Only the meeting's own row and its notes: no lock is taken here, so any closing path may call it right after locking
  // its request — the taker's offered order closes with the taker's request, the maker's with the peer sweep.
  await endMeetingInTx(ctx, m.id, reason === 'CLOSED' ? 'CLOSED' : m.taker_request_id === requestId ? 'TAKER_WITHDREW' : 'MAKER_WITHDREW', { closeOrder: false });
}

/** Offered orders of meetings that ended without closing them (a maker's request withdrawn): closed, one step each. */
async function closeEndedOffers(db: Db, limit: number): Promise<number> {
  const due = await db.selectFrom('peer_match as pm').innerJoin('trader_order as o', 'o.id', 'pm.order_id').select(['o.id', 'pm.maker_trader_id', 'pm.end_reason'])
    .where('pm.status', '=', 'ENDED').where('o.status', '=', 'OFFERED').limit(limit).execute();
  for (const d of due) {
    await step(db, 'peer.close_offer', { orderId: d.id }, async (ctx) => {
      await lockTrader(ctx, d.maker_trader_id);
      const order = await lockOrder(ctx, d.id);
      if (order.status === 'OFFERED') await closeUnstartedOrder(ctx, order, 'WITHDRAWN', 'REQUEST_CLOSED', peerCloseNote(d.end_reason ?? 'CLOSED'));
    });
  }
  return due.length;
}

/** `peer.decline` — the maker does not start this one. No strike: it said so. */
export function declinePeer(actor: ClientActor) {
  return memberClientCommand(actor, async (ctx, p: { matchRef: string }, clientId) => {
    const m = await matchByRef(ctx.tx, p.matchRef);
    if (m.maker_client_id !== clientId) throw new DomainError('NOT_FOUND', 'meeting not found');
    await lockRequests(ctx, [m.taker_request_id, m.maker_request_id]);
    const live = await ctx.tx.selectFrom('peer_match').select('status').where('id', '=', m.id).executeTakeFirstOrThrow();
    if (live.status !== 'WAITING_MAKER') throw new DomainError('PEER_MATCH_OVER', 'this meeting is over');
    await endMeetingInTx(ctx, m.id, 'MAKER_DECLINED');
    return { status: 'DECLINED' as const };
  });
}

/** `peer.still_looking` — a maker that stayed silent says it is still looking: its request is a price for others again. */
export function stillLooking(actor: ClientActor) {
  return memberClientCommand(actor, async (ctx, p: { requestId: string }, clientId) => {
    const id = requireUuid(p.requestId, 'requestId');
    await lockRow(ctx.tx, 'trade_request', 'trade_request', id);
    const r = await readBookRequest(ctx.tx, id);
    if (r.client_id !== clientId) throw new DomainError('NOT_FOUND', 'request not found');
    if (r.status !== 'OPEN' || r.waiting_until === null) throw new DomainError('REQUEST_NOT_OPEN', 'this request is not waiting');
    if (r.peer_paused_at === null) return { paused: false };
    await ctx.tx.updateTable('trade_request').set({ peer_paused_at: null, last_activity_at: sql<Date>`inrp2p_now()`, version: r.version + 1 }).where('id', '=', id).execute();
    await appendAudit(ctx, { action: 'request.still_looking', entityType: 'trade_request', entityId: id, after: { peer_paused: false } });
    await lookNow(ctx, null);
    return { paused: false };
  });
}

// ---- the standing yes, in its own step ---------------------------------------------------------------------------------

export type StandingResult = 'ACCEPTED' | 'GONE';

/**
 * The step after a maker started (`peer.start`), in its own transaction: the taker's quote is accepted on its standing
 * yes, by the user who said it, while it stands. Run right after the start by the same request (the app holds the custody
 * adapter a selling taker's escrow address comes from); if it cannot be done that way — the taker's rights changed, its
 * hour passed — the quote stays held for the taker to accept itself, the meeting ends, and the taker is told its price is
 * ready. The peer sweep does the same for a start whose second step never ran.
 */
export async function completePeerStart(db: Db, accept: (ctx: TxContext, quoteId: string, userId: string) => Promise<unknown>, matchId: string): Promise<StandingResult> {
  try {
    const out = await executeCommand(db, {
      authorize: async () => {},
      handle: async (ctx): Promise<StandingResult> => {
        const m = await ctx.tx.selectFrom('peer_match').selectAll().where('id', '=', requireUuid(matchId, 'matchId')).executeTakeFirstOrThrow();
        if (m.status !== 'WAITING_MAKER' || !m.quote_id) return 'GONE';
        await lockRequests(ctx, [m.taker_request_id, m.maker_request_id]);
        await accept(ctx, m.quote_id, m.taker_yes_by);
        return 'ACCEPTED';
      },
    }, { name: 'peer.accept_standing', actor: SYSTEM, payload: { matchId }, idempotencyKey: `peer_standing:${matchId}`, financial: true });
    return out.result;
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    await askTakerAgain(db, matchId, e.code);
    return 'GONE';
  }
}

/** The taker's standing yes could not be used: the meeting ends and its quote, held, is the taker's to accept. */
async function askTakerAgain(db: Db, matchId: string, why: string): Promise<void> {
  await step(db, 'peer.standing_refused', { matchId }, async (ctx) => {
    const m = await ctx.tx.selectFrom('peer_match').selectAll().where('id', '=', matchId).executeTakeFirstOrThrow();
    if (m.status !== 'WAITING_MAKER' || !m.quote_id) return;
    await lockRequests(ctx, [m.taker_request_id, m.maker_request_id]);
    await endMatchRow(ctx, m.id, 'TAKER_SILENT');
    await appendAudit(ctx, { action: 'peer.standing_refused', entityType: 'peer_match', entityId: m.id, after: { code: why.slice(0, 80), quote_id: m.quote_id } });
    const q = await ctx.tx.selectFrom('quote').select(['expires_at', 'client_id', 'status']).where('id', '=', m.quote_id).executeTakeFirstOrThrow();
    if (q.status === 'SENT') {
      await enqueueOutbox(ctx, { type: 'quote.sent', aggregateType: 'quote', aggregateId: m.quote_id, payload: { quoteId: m.quote_id, expiresAt: q.expires_at!.toISOString(), clientId: q.client_id, held: true } });
    }
  });
}

// ---- the sweep: silent makers and prices near yours -------------------------------------------------------------------

export interface PeerSweepReport {
  readonly ended: number;
  readonly told: number;
  readonly failures: readonly { readonly id: string; readonly code: string; readonly message: string }[];
}

/**
 * `peer_sweep` (cron, every minute): a meeting whose hour passed with no start ends — its maker gets a strike and a pause —
 * and waiting clients near another client's price are told once (an hour apart, unless it moved).
 */
export async function runPeerSweep(db: Db, limit = 100): Promise<PeerSweepReport> {
  const failures: { id: string; code: string; message: string }[] = [];
  let ended = 0;
  let told = 0;
  const due = await db.selectFrom('peer_match').select(['id', 'taker_request_id', 'maker_request_id']).where('status', '=', 'WAITING_MAKER').where('quote_id', 'is', null)
    .where('taker_yes_until', '<=', sql<Date>`inrp2p_now()`).orderBy('taker_yes_until').limit(limit).execute();
  for (const m of due) {
    try {
      await step(db, 'peer.end_silent', { matchId: m.id }, async (ctx) => {
        await lockRequests(ctx, [m.taker_request_id, m.maker_request_id]);
        await endMeetingInTx(ctx, m.id, 'MAKER_SILENT');
      });
      ended += 1;
    } catch (e) {
      failures.push({ id: m.id, code: e instanceof DomainError ? e.code : 'UNEXPECTED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  await closeEndedOffers(db, limit).catch((e: unknown) => failures.push({ id: 'close_offers', code: e instanceof DomainError ? e.code : 'UNEXPECTED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) }));
  // A start whose second step never ran (the app went away between them): the taker is asked to accept its held price.
  const stranded = await db.selectFrom('peer_match').select('id').where('status', '=', 'WAITING_MAKER').where('quote_id', 'is not', null)
    .where('maker_yes_at', '<=', sql<Date>`inrp2p_now() - interval '2 minutes'`).limit(limit).execute();
  for (const m of stranded) {
    try {
      await askTakerAgain(db, m.id, 'STEP_NOT_RUN');
    } catch (e) {
      failures.push({ id: m.id, code: e instanceof DomainError ? e.code : 'UNEXPECTED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  if ((await newBusinessState(db)).paused) return { ended, told, failures };
  const book = await bookContext(db);
  if (!book) return { ended, told, failures };
  const waiting = await db.selectFrom('trade_request').select('id').where('status', '=', 'OPEN').where('waiting_until', 'is not', null).where('desk_id', 'is', null)
    .where((w) => w.or([w('peer_told_at', 'is', null), w('peer_told_at', '<=', sql<Date>`inrp2p_now() - make_interval(mins => ${PEER_TOLD_MINUTES})`)]))
    .orderBy('waiting_since').limit(limit).execute();
  for (const { id } of waiting) {
    try {
      if (await tellNearby(db, id)) told += 1;
    } catch (e) {
      failures.push({ id, code: e instanceof DomainError ? e.code : 'UNEXPECTED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  return { ended, told, failures };
}

/** One waiting client told of another client's price near its own — once per price, an hour apart. */
async function tellNearby(db: Db, requestId: string): Promise<boolean> {
  return step(db, 'peer.tell_nearby', { requestId }, async (ctx) => {
    await lockRow(ctx.tx, 'trade_request', 'trade_request', requestId);
    const r = await readBookRequest(ctx.tx, requestId);
    if (r.status !== 'OPEN' || r.waiting_until === null || (await liveMatchOf(ctx.tx, r.id))) return false;
    const facts = await peerFactsOf(ctx.tx, r.id);
    if (!facts.offer) return false;
    const rate = Rate.parse(facts.offer.rate, 'CLIENT').micro;
    if (r.peer_told_rate_micro === rate) return false;
    await ctx.tx.updateTable('trade_request').set({ peer_told_at: sql<Date>`inrp2p_now()`, peer_told_rate_micro: rate }).where('id', '=', r.id).execute();
    await enqueueOutbox(ctx, {
      type: 'client.peer_nearby', aggregateType: 'trade_request', aggregateId: r.id,
      payload: { requestId: r.id, clientId: r.client_id, kind: facts.offer.kind, rate: facts.offer.rate, direction: r.direction },
    });
    return true;
  });
}

async function step<R>(db: Db, name: string, payload: Record<string, unknown>, fn: (ctx: TxContext) => Promise<R>): Promise<R> {
  const key = randomUUID();
  const out = await executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: SYSTEM, payload: { ...payload, run: key }, idempotencyKey: key, financial: true });
  return out.result;
}

/**
 * ADR 0033 §2.7: something changed that could price a waiting request — the waiting sweep runs for it now
 * (`waiting.look_now`), not only on its minute.
 */
export async function lookNow(ctx: TxContext, direction: DirectionValue | null): Promise<void> {
  await enqueueOutbox(ctx, { type: 'waiting.look_now', aggregateType: 'trade_request', aggregateId: randomUUID(), payload: { direction } });
}

/** For the operator's Rates page and the deployment notes. */
export async function peerBookSummary(ex: Executor): Promise<{ readonly policy: PeerPolicy; readonly live: number; readonly started7d: number; readonly ended7d: number }> {
  const policy = await currentPeerPolicy(ex);
  const r = await sql<{ live: string; started: string; ended: string }>`
    select count(*) filter (where status = 'WAITING_MAKER') as live,
           count(*) filter (where status = 'STARTED' and created_at > inrp2p_now() - interval '7 days') as started,
           count(*) filter (where status = 'ENDED' and created_at > inrp2p_now() - interval '7 days') as ended
      from peer_match`.execute(ex);
  const row = r.rows[0]!;
  return { policy, live: Number.parseInt(row.live, 10), started7d: Number.parseInt(row.started, 10), ended7d: Number.parseInt(row.ended, 10) };
}

export type { QuoteDeps };
