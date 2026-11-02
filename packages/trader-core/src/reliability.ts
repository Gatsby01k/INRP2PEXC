import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';

/**
 * How reliably a trader finishes the deals it starts (ADR 0025) — counted from its own record, never assumed.
 *
 * A started order (its trade opened) ends one of three ways for the trader's record:
 * - **completed**: the deal finished and no dispute was decided against the trader;
 * - **failed by the trader**: on a client's BUY it never funded the escrow, so the trade was cancelled before its USDT
 *   arrived; on a client's SELL its rupees never came and the client's USDT went back (`p2p_unwind`); or INRP2P decided a
 *   dispute against it — it said rupees had not arrived that had, or it had not paid;
 * - anything else (a client who did not pay, a client who never sent its USDT, a case INRP2P cancelled) says nothing
 *   about the trader and is not counted.
 */
export interface TraderRecord {
  readonly completed: number;
  readonly failed: number;
}

export interface TraderRecords {
  readonly byTrader: ReadonlyMap<string, TraderRecord>;
  /** Every trader's together: what a trader with little record of its own is judged against. */
  readonly network: TraderRecord;
}

export async function traderRecords(ex: Executor, input: { sinceDays: number }): Promise<TraderRecords> {
  const r = await sql<{ trader_id: string; completed: number; failed: number }>`
    select o.trader_id,
           count(*) filter (where o.status = 'COMPLETED' and not lost.against)::int as completed,
           count(*) filter (where lost.against
                               or (o.status = 'CANCELLED' and o.side = 'SELL_USDT' and o.delivered_at is null)
                               or exists (select 1 from p2p_unwind u where u.trade_id = o.trade_id))::int as failed
      from trader_order o
      cross join lateral (
        select exists (
          select 1 from p2p_dispute d
           where d.trade_id = o.trade_id and d.decided_via = 'INRP2P'
             and ((d.payee = 'TRADER' and d.status = 'PAID') or (d.payee = 'CLIENT' and d.status = 'NOT_PAID'))
        ) as against
      ) lost
     where o.trade_id is not null
       and o.status in ('COMPLETED', 'CANCELLED')
       and o.started_at >= inrp2p_now() - make_interval(days => ${input.sinceDays})
     group by o.trader_id`.execute(ex);
  const byTrader = new Map<string, TraderRecord>();
  let completed = 0;
  let failed = 0;
  for (const row of r.rows) {
    byTrader.set(row.trader_id, { completed: row.completed, failed: row.failed });
    completed += row.completed;
    failed += row.failed;
  }
  return { byTrader, network: { completed, failed } };
}

const PPM = 1_000_000n;

/**
 * That a deal given to this trader completes, in parts per million: its own completions against its own failures, leaning
 * on the network's rate (itself a Laplace estimate, even odds with no record at all) with the weight of two deals — so a new
 * trader is judged by the network until its own record speaks, and one failure does not end a long clean record.
 */
export function completionPpm(own: TraderRecord | undefined, network: TraderRecord): bigint {
  const prior = (BigInt(network.completed) * PPM + PPM) / BigInt(network.completed + network.failed + 2);
  const c = BigInt(own?.completed ?? 0);
  const f = BigInt(own?.failed ?? 0);
  return (c * PPM + 2n * prior) / (c + f + 2n);
}
