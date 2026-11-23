import { sql } from 'kysely';
import type { DirectionValue, Executor } from '@inrp2p/db';
import type { AcceptanceEvidence, Tally } from './auto-price.ts';

/**
 * What clients did with INRP2P's automatic quotes (ADR 0025): per price band against the market reference, how many were
 * accepted and how many declined, over the policy's window, for one direction — by size band, and summed. Declined is a
 * client's own "no": the quote ran out, was rejected, or its request was withdrawn while it was live. A quote the client
 * replaced by asking again, or one INRP2P cancelled, says nothing about the price and is not counted; nor is one still live.
 */
export async function acceptanceEvidence(ex: Executor, input: { direction: DirectionValue; sizeBand: number; binBps: number; learningDays: number }): Promise<AcceptanceEvidence> {
  const r = await sql<{ size_band: number; bin: number; accepted: number; declined: number }>`
    select a.size_band, floor(a.position_bps::numeric / ${input.binBps})::int as bin,
           count(*) filter (where q.status = 'ACCEPTED')::int as accepted,
           count(*) filter (where q.status in ('EXPIRED', 'REJECTED') or (q.status = 'CANCELLED' and q.cancel_reason = 'WITHDRAWN'))::int as declined
      from auto_quote a join quote q on q.id = a.quote_id
     where a.direction = ${input.direction}
       -- ADR 0032: a price held for a client who was not on the screen says nothing about how a price is answered.
       and not a.held
       and a.created_at >= inrp2p_now() - make_interval(days => ${input.learningDays})
     group by 1, 2`.execute(ex);
  const band = new Map<number, Tally>();
  const direction = new Map<number, Tally>();
  for (const row of r.rows) {
    if (row.accepted + row.declined === 0) continue;
    if (row.size_band === input.sizeBand) band.set(row.bin, { accepted: row.accepted, declined: row.declined });
    const sum = direction.get(row.bin) ?? { accepted: 0, declined: 0 };
    direction.set(row.bin, { accepted: sum.accepted + row.accepted, declined: sum.declined + row.declined });
  }
  return { band, direction };
}
