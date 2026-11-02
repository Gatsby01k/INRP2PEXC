import { sql } from 'kysely';
import { type Exposure, type RiskPolicy, type TrackRecord, requireRiskPolicy, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';

/**
 * The facts a trader's level and limits are decided on (ADR 0024), read from the books. The policy and the arithmetic are
 * the kernel's (`trader-risk.ts`), so the desk's form and the trader's screen speak the same terms.
 */
export {
  DEFAULT_RISK_POLICY, TIER_NAMES, type Exposure, type RiskIssue, type RiskLimits, type RiskPolicy, type RiskTier, type TierName, type TierStanding, type TrackRecord,
  backingFor, limitsOf, requireRiskPolicy, riskFit, tierOf,
} from '@inrp2p/kernel';

export async function riskPolicyOf(ex: Executor): Promise<RiskPolicy | null> {
  const r = await ex.selectFrom('trader_program').select('risk_policy').where('id', '=', 1).executeTakeFirstOrThrow();
  return r.risk_policy === null ? null : requireRiskPolicy(r.risk_policy);
}

export async function readTrackRecord(ex: Executor, traderId: string, policy: RiskPolicy): Promise<TrackRecord> {
  const id = requireUuid(traderId, 'traderId');
  // A failed deal: the client said the trader's rupees never came and INRP2P agreed; the trader said the client's did not
  // come and INRP2P found they had; or the client's escrow went back because the trader did not pay. One per deal.
  const r = await sql<{ completed: number; days: number | null; strikes: number }>`
    select (select count(*) from trader_order o where o.trader_id = ${id} and o.status = 'COMPLETED')::int as completed,
           (select floor(extract(epoch from inrp2p_now() - t.approved_at) / 86400)::int from trader_profile t where t.id = ${id}) as days,
           (select count(distinct x.trade_id) from (
               select d.trade_id, d.decided_at as at from p2p_dispute d
                where (d.payee = 'CLIENT' and d.status = 'NOT_PAID') or (d.payee = 'TRADER' and d.status = 'PAID' and d.decided_via = 'INRP2P')
               union all
               select u.trade_id, u.created_at from p2p_unwind u
             ) x
             join trader_order o on o.trade_id = x.trade_id
            where o.trader_id = ${id} and x.at > inrp2p_now() - make_interval(days => ${policy.cleanDays}))::int as strikes`.execute(ex);
  const row = r.rows[0]!;
  return { completedDeals: row.completed, daysApproved: row.days, strikes: row.strikes };
}

/**
 * What is open on the trader in USDT (`trader_order.base_minor`, the trader's own USDT on either side): offers still
 * live, orders held, and orders started whose trade has not finished. An order whose trade completed or was cancelled
 * no longer counts even before the sweep closes it.
 */
export async function readExposure(ex: Executor, traderId: string): Promise<Exposure> {
  const r = await sql<{ total: string; largest: string }>`
    select coalesce(sum(o.base_minor), 0)::text as total, coalesce(max(o.base_minor), 0)::text as largest
      from trader_order o left join trade t on t.id = o.trade_id
     where o.trader_id = ${requireUuid(traderId, 'traderId')}
       and ((o.status = 'OFFERED' and o.offer_expires_at > inrp2p_now())
            or o.status = 'ACCEPTED'
            or (o.status = 'IN_PROGRESS' and (t.id is null or t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))))`.execute(ex);
  return { totalMinor: BigInt(r.rows[0]!.total), largestMinor: BigInt(r.rows[0]!.largest) };
}
