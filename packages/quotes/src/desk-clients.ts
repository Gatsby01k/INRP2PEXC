import { sql } from 'kysely';
import { DomainError, Money, optionalText, requireOneOf, requireUuid } from '@inrp2p/kernel';
import type { DeskClientSource, DeskClientStatus, Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { ClientActor } from '@inrp2p/identity';
import { closeOrdersForRequests, deskOfTrader, traderClientCommand } from '@inrp2p/trader-core';
import { lockRow } from './actors.ts';
import { cancelSentQuoteOfRequest, closeRequest } from './requests.ts';

/**
 * A desk's clients (docs/adr/0020-desks.md §2.3): the people and companies that deal with it through its page and its
 * links. The desk decides whom it deals with and how much in one deal; it never sees a client's other desks.
 */

export interface SetDeskClientPayload {
  readonly clientId: string;
  readonly expectedVersion: number;
  /** BLOCKED stops new deals at once; deals already open run to their end. */
  readonly status?: DeskClientStatus;
  /** The largest single deal with this client, in USDT; null removes the desk's own limit. */
  readonly maxDeal?: string | null;
  /** The desk's own note about the client; never shown to it. */
  readonly note?: string | null;
}

/**
 * `desk_client.update` — whoever can commit for the desk blocks or unblocks a client, sets its own limit on one deal with
 * it, or writes a note. Blocking also takes back what the client is asking right now: its open requests at the desk, a
 * live price and the capacity it holds, in the same step. A deal already accepted is not touched.
 */
export function setDeskClient(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: SetDeskClientPayload, member) => {
    const trader = await ctx.tx.selectFrom('trader_profile').select('id').where('client_id', '=', member.clientId).executeTakeFirst();
    const desk = trader ? await deskOfTrader(ctx.tx, trader.id) : null;
    if (!desk) throw new DomainError('NOT_FOUND', 'open your desk first');
    const row = await ctx.tx.selectFrom('desk_client').selectAll().where('desk_id', '=', desk.id).where('client_id', '=', requireUuid(p.clientId, 'clientId')).executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 'this is not your client');
    if (!Number.isInteger(p.expectedVersion) || row.version !== p.expectedVersion) throw new DomainError('STALE_VERSION', 'this client changed since you opened it; reload and try again');
    const status = p.status === undefined ? row.status : requireOneOf(p.status, 'status', ['ACTIVE', 'BLOCKED'] as const);
    let maxDeal = row.max_deal_base_minor;
    if (p.maxDeal !== undefined) {
      maxDeal = p.maxDeal === null || p.maxDeal === '' ? null : Money.parse(p.maxDeal, 'USDT').minor;
      if (maxDeal !== null && maxDeal <= 0n) throw new DomainError('INVALID_AMOUNT', 'the limit must be positive', { field: 'maxDeal' });
    }
    const note = p.note === undefined ? row.note : optionalText(p.note, 'note', 500);

    // Blocking ends what the client is asking now (locks: its requests, their quotes, then the desk's orders).
    let withdrawn: string[] = [];
    if (status === 'BLOCKED' && row.status !== 'BLOCKED') {
      const open = await ctx.tx.selectFrom('trade_request').select(['id', 'version']).where('desk_id', '=', desk.id).where('client_id', '=', row.client_id).where('status', 'in', ['OPEN', 'QUOTED']).orderBy('id').execute();
      for (const r of open) await lockRow(ctx.tx, 'trade_request', 'trade_request', r.id);
      for (const r of open) await cancelSentQuoteOfRequest(ctx, r.id, 'WITHDRAWN');
      await closeOrdersForRequests(ctx, open.map((r) => r.id));
      for (const r of open) await closeRequest(ctx.tx, r.id, 'WITHDRAWN', 'the desk is not dealing with this client', r.version);
      withdrawn = open.map((r) => r.id);
    }
    await ctx.tx.updateTable('desk_client')
      .set({ status, max_deal_base_minor: maxDeal, note, updated_at: sql<Date>`inrp2p_now()`, version: row.version + 1 })
      .where('id', '=', row.id).where('version', '=', row.version)
      .execute();
    await appendAudit(ctx, {
      action: 'desk_client.updated', entityType: 'desk_client', entityId: row.id,
      before: { status: row.status, max_deal: row.max_deal_base_minor === null ? null : Money.ofMinor(row.max_deal_base_minor, 'USDT'), note: row.note },
      after: { status, max_deal: maxDeal === null ? null : Money.ofMinor(maxDeal, 'USDT'), note, withdrawn_requests: withdrawn },
    });
    return { status, maxDeal: maxDeal === null ? null : Money.ofMinor(maxDeal, 'USDT').toDecimalString(), version: row.version + 1, withdrawnRequests: withdrawn.length };
  });
}

export interface DeskClientRow {
  readonly clientId: string;
  readonly name: string;
  readonly source: DeskClientSource;
  readonly status: DeskClientStatus;
  readonly maxDeal: string | null;
  readonly note: string | null;
  readonly since: string;
  readonly version: number;
  /** Deals with this desk that completed, and their USDT. */
  readonly completedDeals: number;
  readonly completedUsdt: string;
  /** Deals accepted and not yet finished. */
  readonly openDeals: number;
  /** A price the client holds right now. */
  readonly asking: boolean;
  readonly lastDealAt: string | null;
}

/**
 * The desk's list of its clients — the most recently active first — with what it did with each of them, from the books.
 * Only this desk's deals count; a client's other desks are not this desk's business.
 */
export async function deskClients(ex: Executor, deskId: string, opts: { readonly status?: DeskClientStatus; readonly limit?: number } = {}): Promise<DeskClientRow[]> {
  const id = requireUuid(deskId, 'deskId');
  const r = await sql<{
    client_id: string; name: string; source: DeskClientSource; status: DeskClientStatus; max_deal_base_minor: string | null; note: string | null; created_at: Date; version: number;
    completed: number; completed_usdt: string; open: number; asking: boolean; last_deal_at: Date | null;
  }>`
    select dc.client_id, c.display_name as name, dc.source, dc.status, dc.max_deal_base_minor::text, dc.note, dc.created_at, dc.version,
           count(t.id) filter (where t.lifecycle_state = 'COMPLETED')::int as completed,
           coalesce(sum(e.base_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as completed_usdt,
           count(t.id) filter (where t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))::int as open,
           exists (select 1 from trade_request q where q.desk_id = dc.desk_id and q.client_id = dc.client_id and q.status = 'QUOTED') as asking,
           max(t.opened_at) as last_deal_at
      from desk_client dc
      join client c on c.id = dc.client_id
      left join trade_request r on r.desk_id = dc.desk_id and r.client_id = dc.client_id
      left join trade t on t.trade_request_id = r.id
      left join trade_economics e on e.trade_id = t.id
     where dc.desk_id = ${id} ${opts.status ? sql`and dc.status = ${opts.status}` : sql``}
     group by dc.id, c.display_name
     order by coalesce(max(t.opened_at), dc.created_at) desc, dc.client_id
     limit ${opts.limit ?? 200}`.execute(ex);
  return r.rows.map((x) => ({
    clientId: x.client_id, name: x.name, source: x.source, status: x.status,
    maxDeal: x.max_deal_base_minor === null ? null : Money.ofMinor(BigInt(x.max_deal_base_minor), 'USDT').toDecimalString(),
    note: x.note, since: x.created_at.toISOString(), version: x.version,
    completedDeals: x.completed, completedUsdt: Money.ofMinor(BigInt(x.completed_usdt), 'USDT').toDecimalString(), openDeals: x.open,
    asking: x.asking, lastDealAt: x.last_deal_at ? x.last_deal_at.toISOString() : null,
  }));
}
