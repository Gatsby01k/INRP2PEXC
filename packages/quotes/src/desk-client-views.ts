import { sql } from 'kysely';
import { Money, Rate, requireUuid } from '@inrp2p/kernel';
import type { DeskClientStatus, DeskStatus, DirectionValue, Executor } from '@inrp2p/db';
import { currentDeskPrices } from '@inrp2p/trader-core';
import { type ClientQuoteView, assertClientSafe, toClientQuoteView } from './projections.ts';
import { deskDealLinkView } from './desk-links.ts';
import { linkTokenHash } from './security.ts';

/**
 * A client's side of the desks it deals with (docs/adr/0020-desks.md, stage 1 block 7): where it stands with a desk,
 * the price it holds there right now, its deals with that desk, and the list of its desks. What a client may see of a
 * desk is what the desk publishes, plus the client's own dealings with it — never the desk's USDT, its fee or its other
 * clients. Every projection passes `assertClientSafe`.
 */

function clientSafe<T>(value: T): T {
  assertClientSafe(value);
  return value;
}

export interface ClientDeskDeal {
  readonly tradeRef: string;
  readonly direction: DirectionValue;
  readonly usdt: string;
  readonly inr: string;
  readonly state: string;
  readonly openedAt: string;
}

export interface ClientDeskState {
  /** The client's standing with the desk, once it has asked it for a price or taken one of its links. */
  readonly relation: { readonly status: DeskClientStatus; readonly maxDeal: string | null; readonly since: string } | null;
  /** The firm price the client holds at this desk right now (from its page), if any. */
  readonly liveQuote: ClientQuoteView | null;
  /** The client's trades with this desk, newest first. */
  readonly deals: readonly ClientDeskDeal[];
}

async function deals(ex: Executor, clientId: string, deskId: string, limit: number): Promise<ClientDeskDeal[]> {
  const rows = await ex
    .selectFrom('trade as t')
    .innerJoin('trade_request as r', 'r.id', 't.trade_request_id')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .select(['t.ref', 't.direction', 't.lifecycle_state', 't.opened_at', 'e.base_minor', 'e.quote_inr_minor'])
    .where('r.desk_id', '=', deskId)
    .where('t.client_id', '=', clientId)
    .orderBy('t.opened_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((t) => ({
    tradeRef: t.ref, direction: t.direction, usdt: Money.ofMinor(t.base_minor, 'USDT').toDecimalString(), inr: Money.ofMinor(t.quote_inr_minor, 'INR').toDecimalString(),
    state: t.lifecycle_state, openedAt: t.opened_at.toISOString(),
  }));
}

/** The live quote of a request, if it has one still open to accept (business clock). */
async function liveQuoteOf(ex: Executor, requestId: string): Promise<ClientQuoteView | null> {
  const q = await ex
    .selectFrom('quote')
    .select('id')
    .where('trade_request_id', '=', requestId)
    .where('status', '=', 'SENT')
    .where(sql<boolean>`expires_at > inrp2p_now()`)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return q ? toClientQuoteView(ex, q.id) : null;
}

/** Where the client stands with one desk: its relation, the price it holds from the page, and its deals there. */
export async function clientDeskState(ex: Executor, clientId: string, deskId: string): Promise<ClientDeskState> {
  const client = requireUuid(clientId, 'clientId');
  const desk = requireUuid(deskId, 'deskId');
  const rel = await ex.selectFrom('desk_client').select(['status', 'max_deal_base_minor', 'created_at']).where('desk_id', '=', desk).where('client_id', '=', client).executeTakeFirst();
  const asking = await ex
    .selectFrom('trade_request')
    .select('id')
    .where('desk_id', '=', desk)
    .where('client_id', '=', client)
    .where('desk_deal_link_id', 'is', null)
    .where('status', '=', 'QUOTED')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return clientSafe({
    relation: rel ? { status: rel.status, maxDeal: rel.max_deal_base_minor === null ? null : Money.ofMinor(rel.max_deal_base_minor, 'USDT').toDecimalString(), since: rel.created_at.toISOString() } : null,
    liveQuote: asking ? await liveQuoteOf(ex, asking.id) : null,
    deals: await deals(ex, client, desk, 10),
  });
}

export interface ClientLinkState {
  /** The deal on the link as anyone holding it sees it; null for a token that is not one. */
  readonly link: NonNullable<Awaited<ReturnType<typeof deskDealLinkView>>>;
  /** This client took the link: its live quote from it, or the trade it became. */
  readonly mine: boolean;
  readonly liveQuote: ClientQuoteView | null;
  readonly tradeRef: string | null;
}

/** A deal link as a signed-in client sees it: the deal, and whether it is already the client's — with its price or trade. */
export async function clientLinkState(ex: Executor, clientId: string, token: string): Promise<ClientLinkState | null> {
  const client = requireUuid(clientId, 'clientId');
  const link = await deskDealLinkView(ex, token);
  if (!link) return null;
  const row = await ex.selectFrom('desk_deal_link').select(['id', 'claimed_client_id']).where('token_hash', '=', linkTokenHash(token)).executeTakeFirstOrThrow();
  const mine = row.claimed_client_id === client;
  let liveQuote: ClientQuoteView | null = null;
  let tradeRef: string | null = null;
  if (mine) {
    const request = await ex.selectFrom('trade_request').select(['id', 'status']).where('desk_deal_link_id', '=', row.id).where('client_id', '=', client).orderBy('created_at', 'desc').executeTakeFirst();
    if (request?.status === 'QUOTED') liveQuote = await liveQuoteOf(ex, request.id);
    const trade = await ex.selectFrom('trade as t').innerJoin('trade_request as r', 'r.id', 't.trade_request_id').select('t.ref').where('r.desk_deal_link_id', '=', row.id).where('t.client_id', '=', client).executeTakeFirst();
    tradeRef = trade?.ref ?? null;
  }
  return clientSafe({ link, mine, liveQuote, tradeRef });
}

export interface ClientDeskRow {
  readonly handle: string;
  readonly displayName: string;
  readonly deskStatus: DeskStatus;
  readonly relation: DeskClientStatus;
  readonly since: string;
  /** The desk's live prices, as its page shows them: what it pays for USDT, what it asks. */
  readonly prices: { readonly SELL_USDT: string | null; readonly BUY_USDT: string | null };
  readonly completedDeals: number;
  readonly completedUsdt: string;
  readonly openDeals: number;
  readonly lastDealAt: string | null;
}

/** "My desks": every desk the client has dealt with or asked, the most recently used first. */
export async function clientDesks(ex: Executor, clientId: string): Promise<ClientDeskRow[]> {
  const client = requireUuid(clientId, 'clientId');
  const r = await sql<{
    desk_id: string; handle: string; display_name: string; desk_status: DeskStatus; status: DeskClientStatus; created_at: Date;
    completed: number; completed_usdt: string; open: number; last_deal_at: Date | null;
  }>`
    select dc.desk_id, d.handle, d.display_name, d.status as desk_status, dc.status, dc.created_at,
           count(t.id) filter (where t.lifecycle_state = 'COMPLETED')::int as completed,
           coalesce(sum(e.base_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as completed_usdt,
           count(t.id) filter (where t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))::int as open,
           max(t.opened_at) as last_deal_at
      from desk_client dc
      join desk d on d.id = dc.desk_id
      left join trade_request r on r.desk_id = dc.desk_id and r.client_id = dc.client_id
      left join trade t on t.trade_request_id = r.id
      left join trade_economics e on e.trade_id = t.id
     where dc.client_id = ${client} and d.status <> 'DRAFT'
     group by dc.id, d.id
     order by coalesce(max(t.opened_at), dc.created_at) desc
     limit 100`.execute(ex);
  const out: ClientDeskRow[] = [];
  for (const x of r.rows) {
    const prices = await currentDeskPrices(ex, x.desk_id);
    const shown = (d: DirectionValue) => (x.desk_status === 'LIVE' && prices[d]?.offered ? Rate.ofMicro(prices[d]!.rateMicro, 'CLIENT').toDecimalString() : null);
    out.push({
      handle: x.handle, displayName: x.display_name, deskStatus: x.desk_status, relation: x.status, since: x.created_at.toISOString(),
      prices: { SELL_USDT: shown('SELL_USDT'), BUY_USDT: shown('BUY_USDT') },
      completedDeals: x.completed, completedUsdt: Money.ofMinor(BigInt(x.completed_usdt), 'USDT').toDecimalString(), openDeals: x.open,
      lastDealAt: x.last_deal_at ? x.last_deal_at.toISOString() : null,
    });
  }
  return clientSafe(out);
}
