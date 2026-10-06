import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';

/**
 * Whether new business is open (migration 0033). While it is paused no request is opened, no quote sent, no quote
 * accepted and no trader offered an order; everything already started settles as usual.
 */
export interface NewBusinessState {
  readonly paused: boolean;
  readonly reason: string | null;
  readonly since: string | null;
  readonly setBy: string | null;
}

export async function newBusinessState(ex: Executor): Promise<NewBusinessState> {
  const r = await sql<{ new_business: string; reason: string; set_at: Date; set_by_label: string | null }>`
    select c.new_business, c.reason, c.set_at, coalesce(u.name, u.email, case when c.set_by like 'SYSTEM:%' then 'the system' end) as set_by_label
      from trading_control c left join auth_user u on u.id::text = c.set_by
     order by c.set_at desc, c.id desc limit 1`.execute(ex);
  const row = r.rows[0];
  if (!row) return { paused: false, reason: null, since: null, setBy: null };
  return { paused: row.new_business === 'PAUSED', reason: row.reason, since: row.set_at.toISOString(), setBy: row.set_by_label };
}

/** Refuses with the reason the desk gave, so the person refused knows why and that it is deliberate. */
export async function assertNewBusinessOpen(ex: Executor): Promise<void> {
  const state = await newBusinessState(ex);
  if (state.paused) throw new DomainError('NEW_BUSINESS_PAUSED', `New trades are paused for now${state.reason ? `: ${state.reason}` : ''}. Trades already under way continue.`);
}

