import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';

/**
 * Where traders come from, for the desk (migration 0053): the visitors who first reached `inrp2p.com/traders` in a period,
 * grouped by where they came from, and how far each got — chose a side, tried the earnings example, pressed a call to
 * action, reached the trader sign-in, signed in, applied, were approved, hold a Security Reserve, completed a deal.
 *
 * The first five are what the page recorded. Everything after signing in is read from where it already is — the
 * application (`trader_profile.applied_by`), its review, the reserve on the ledger, the trader's completed orders — so the
 * funnel never disagrees with the business and nothing about the business is copied into analytics.
 *
 * A visitor is counted in the period its first touch fell in (a cohort), and in exactly one group, so a group's figures
 * add up to the total.
 */

export type FunnelGrouping = 'campaign' | 'ref' | 'segment';

export const FUNNEL_STAGES = ['visitors', 'chose', 'estimated', 'clicked', 'entered', 'signedIn', 'applied', 'approved', 'reserved', 'active'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type FunnelCounts = Record<FunnelStage, number>;

export interface FunnelRow extends FunnelCounts {
  /** The group's words: `[source, medium, campaign]`, `[ref]` or `[segment]`; null where the visitor had none. */
  readonly key: readonly (string | null)[];
}

export interface FunnelApplicant {
  readonly traderId: string;
  readonly ref: string;
  readonly name: string;
  readonly status: string;
  readonly appliedAt: Date;
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
  readonly referral: string | null;
  readonly segment: string | null;
  readonly reserved: boolean;
  readonly active: boolean;
}

export interface TraderFunnel {
  readonly days: number;
  readonly by: FunnelGrouping;
  readonly total: FunnelCounts;
  readonly rows: readonly FunnelRow[];
  readonly applicants: readonly FunnelApplicant[];
}

const zero = (): FunnelCounts => Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as FunnelCounts;

interface Raw {
  k1: string | null;
  k2: string | null;
  k3: string | null;
  visitors: number;
  chose: number;
  estimated: number;
  clicked: number;
  entered: number;
  signed_in: number;
  applied: number;
  approved: number;
  reserved: number;
  active: number;
}

export async function traderFunnel(ex: Executor, opts: { days: number; by: FunnelGrouping }): Promise<TraderFunnel> {
  const days = Number.isInteger(opts.days) && opts.days >= 1 && opts.days <= 365 ? opts.days : 30;
  const key =
    opts.by === 'ref'
      ? sql`v.ref as k1, null::text as k2, null::text as k3`
      : opts.by === 'segment'
        ? sql`coalesce(e.segment, v.segment) as k1, null::text as k2, null::text as k3`
        : sql`coalesce(v.source, case when v.referrer_host is not null then 'via ' || v.referrer_host end) as k1, v.medium as k2, v.campaign as k3`;
  const rows = await sql<Raw>`
    with v as (
      select id, source, medium, campaign, ref, segment, referrer_host
        from acquisition_visitor
       where first_at >= inrp2p_now() - make_interval(days => ${days})
    ),
    e as (
      select visitor_id,
             bool_or(kind = 'SEGMENT') as chose,
             bool_or(kind = 'ESTIMATE') as estimated,
             bool_or(kind = 'CTA') as clicked,
             bool_or(kind = 'ENTRY') as entered,
             (array_agg(segment order by at desc) filter (where segment is not null))[1] as segment
        from acquisition_event
       where visitor_id in (select id from v)
       group by visitor_id
    ),
    p as (
      select l.visitor_id,
             bool_or(tp.id is not null) as applied,
             bool_or(tp.status in ('APPROVED', 'PAUSED')) as approved,
             bool_or(coalesce(b.dr_minus_cr_minor, 0) < 0) as reserved,
             bool_or(exists (select 1 from trader_order o where o.trader_id = tp.id and o.status = 'COMPLETED')) as active
        from acquisition_link l
        left join trader_profile tp on tp.applied_by = l.user_id
        left join ledger_account_balance b on b.code = 'LIAB:TRADER_RESERVE:' || tp.id::text and b.currency = 'USDT'
       where l.visitor_id in (select id from v)
       group by l.visitor_id
    )
    select ${key},
           count(*)::int as visitors,
           (count(*) filter (where e.chose))::int as chose,
           (count(*) filter (where e.estimated))::int as estimated,
           (count(*) filter (where e.clicked))::int as clicked,
           (count(*) filter (where e.entered))::int as entered,
           (count(p.visitor_id))::int as signed_in,
           (count(*) filter (where p.applied))::int as applied,
           (count(*) filter (where p.approved))::int as approved,
           (count(*) filter (where p.reserved))::int as reserved,
           (count(*) filter (where p.active))::int as active
      from v
      left join e on e.visitor_id = v.id
      left join p on p.visitor_id = v.id
     group by 1, 2, 3
     order by visitors desc, applied desc
     limit 100`.execute(ex);

  const total = zero();
  const out: FunnelRow[] = rows.rows.map((r) => {
    const counts: FunnelCounts = {
      visitors: r.visitors, chose: r.chose, estimated: r.estimated, clicked: r.clicked, entered: r.entered,
      signedIn: r.signed_in, applied: r.applied, approved: r.approved, reserved: r.reserved, active: r.active,
    };
    for (const s of FUNNEL_STAGES) total[s] += counts[s];
    return { key: opts.by === 'campaign' ? [r.k1, r.k2, r.k3] : [r.k1], ...counts };
  });

  // The latest applications that came through the page, with where each came from (its first touch).
  const applicants = await sql<{
    trader_id: string; ref: string; name: string; status: string; applied_at: Date; source: string | null; medium: string | null; campaign: string | null;
    referral: string | null; segment: string | null; reserved: boolean; active: boolean;
  }>`
    select distinct on (tp.id)
           tp.id as trader_id, tp.ref, c.display_name as name, tp.status, tp.applied_at,
           v.source, v.medium, v.campaign, v.ref as referral, v.segment,
           coalesce(b.dr_minus_cr_minor, 0) < 0 as reserved,
           exists (select 1 from trader_order o where o.trader_id = tp.id and o.status = 'COMPLETED') as active
      from acquisition_link l
      join acquisition_visitor v on v.id = l.visitor_id
      join trader_profile tp on tp.applied_by = l.user_id
      join client c on c.id = tp.client_id
      left join ledger_account_balance b on b.code = 'LIAB:TRADER_RESERVE:' || tp.id::text and b.currency = 'USDT'
     where tp.applied_at >= inrp2p_now() - make_interval(days => ${days})
     order by tp.id, v.first_at asc`.execute(ex);

  return {
    days,
    by: opts.by,
    total,
    rows: out,
    applicants: applicants.rows
      .map((a) => ({
        traderId: a.trader_id, ref: a.ref, name: a.name, status: a.status, appliedAt: a.applied_at, source: a.source, medium: a.medium, campaign: a.campaign,
        referral: a.referral, segment: a.segment, reserved: a.reserved, active: a.active,
      }))
      .sort((x, y) => y.appliedAt.getTime() - x.appliedAt.getTime())
      .slice(0, 25),
  };
}
