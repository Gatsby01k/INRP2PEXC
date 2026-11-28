import { sql } from 'kysely';
import type { DirectionValue, Executor } from '@inrp2p/db';
import { PLAYBOOK_LABELS } from './playbooks.ts';
import { type RobotPolicy, currentRobotPolicy } from './policy.ts';
import { wholeUsdt } from './format.ts';
import { type RobotWorld, loadWorld, usdtOf } from './world.ts';

/**
 * The robot's view of the exchange for INRP2P's desk (ADR 0034 §2.9): who is stuck where and for how long, the demand
 * nobody served, what liquidity is online, what the robot sent and what came of it, the questions waiting for a person —
 * and, from those facts alone, the few things worth doing about them. Read-only and deterministic; trader names appear
 * only for a viewer who may see traders.
 */
export interface Recommendation {
  readonly key: string;
  readonly severity: 'ACT' | 'WATCH';
  readonly title: string;
  readonly detail: string;
  /** Where in the desk it is done. */
  readonly href: string | null;
}

export interface FunnelStep {
  readonly key: string;
  readonly label: string;
  readonly people: number;
  /** How long the longest of them has been there, in hours. */
  readonly oldestHours: number | null;
}

export interface PlaybookStat {
  readonly key: string;
  readonly label: string;
  readonly sent: number;
  readonly dryRun: number;
  readonly acted: number;
  readonly failed: number;
}

export interface RobotIntel {
  readonly policy: RobotPolicy;
  readonly aiConfigured: boolean;
  readonly market: { readonly fresh: boolean };
  readonly switches: { readonly autoQuote: boolean; readonly autoReview: boolean; readonly peer: boolean };
  readonly liquidity: Readonly<Record<DirectionValue, { readonly sidesOnline: number; readonly tradersWithSide: number }>>;
  readonly demand: {
    readonly waiting: Readonly<Record<DirectionValue, { readonly requests: number; readonly usdt: string }>>;
    readonly unpriced7d: { readonly requests: number; readonly byReason: Readonly<Record<string, number>> };
    readonly asked7d: Readonly<Record<DirectionValue, { readonly requests: number; readonly usdt: string }>>;
  };
  readonly funnel: readonly FunnelStep[];
  readonly playbooks: readonly PlaybookStat[];
  readonly answers7d: { readonly rule: number; readonly ai: number; readonly toPerson: number; readonly topIntents: readonly { intent: string; n: number }[] };
  readonly openCases: readonly { readonly ref: string; readonly channel: 'APP' | 'TELEGRAM'; readonly who: string; readonly question: string; readonly context: string | null; readonly createdAt: string; readonly updatedAt: string }[];
  readonly recent: readonly { readonly at: string; readonly playbook: string; readonly label: string; readonly who: string; readonly title: string; readonly mode: 'LIVE' | 'DRY_RUN'; readonly channel: string | null; readonly delivery: string; readonly acted: boolean }[];
  readonly recommendations: readonly Recommendation[];
}

const DIRECTIONS: readonly DirectionValue[] = ['SELL_USDT', 'BUY_USDT'];

async function funnel(ex: Executor): Promise<FunnelStep[]> {
  const r = await sql<{ key: string; n: string; oldest: string | null }>`
    with person as (
      select u.id, u.created_at, cu.client_id
        from auth_user u left join client_user cu on cu.user_id = u.id and cu.status = 'ACTIVE'
       where u.kind = 'CLIENT' and u.status = 'ACTIVE'
    )
    select 'NEW_ACCOUNT' as key, count(*)::text as n, extract(epoch from inrp2p_now() - min(created_at))::text as oldest
      from person where client_id is null and created_at > inrp2p_now() - interval '30 days'
    union all
    select 'NEEDS_DESTINATION', count(*)::text, extract(epoch from inrp2p_now() - min(c.created_at))::text
      from client c where c.status = 'ACTIVE' and c.exchange_access and c.created_at > inrp2p_now() - interval '30 days'
       and not exists (select 1 from bank_account b where b.client_id = c.id and b.status in ('ACTIVE', 'PENDING_REVIEW'))
       and not exists (select 1 from crypto_wallet w where w.client_id = c.id and w.status in ('ACTIVE', 'PENDING_REVIEW') and w.purpose <> 'SOURCE')
    union all
    select 'DESTINATION_IN_REVIEW', count(distinct client_id)::text, extract(epoch from inrp2p_now() - min(created_at))::text
      from (select client_id, created_at from bank_account where status = 'PENDING_REVIEW'
            union all select client_id, created_at from crypto_wallet where status = 'PENDING_REVIEW') x
    union all
    select 'READY', count(*)::text, extract(epoch from inrp2p_now() - min(c.created_at))::text
      from client c where c.status = 'ACTIVE' and c.exchange_access and c.created_at > inrp2p_now() - interval '30 days'
       and (exists (select 1 from bank_account b where b.client_id = c.id and b.status = 'ACTIVE')
            or exists (select 1 from crypto_wallet w where w.client_id = c.id and w.status = 'ACTIVE' and w.purpose <> 'SOURCE'))
       and not exists (select 1 from trade_request r where r.client_id = c.id)
    union all
    select 'WAITING', count(*)::text, extract(epoch from inrp2p_now() - min(waiting_since))::text
      from trade_request where status = 'OPEN' and waiting_until is not null and desk_id is null
    union all
    select 'TRADER_RESERVE_DUE', count(*)::text, extract(epoch from inrp2p_now() - min(applied_at))::text
      from trader_profile where status = 'UNDER_REVIEW' and not ('BANK_NAME_MISMATCH' = any(auto_review_flags))
    union all
    select 'TRADER_FLAGGED', count(*)::text, extract(epoch from inrp2p_now() - min(applied_at))::text
      from trader_profile where status = 'UNDER_REVIEW' and cardinality(auto_review_flags) > 0 and not ('RESERVE_SHORT' = any(auto_review_flags) and cardinality(auto_review_flags) = 1)
    union all
    select 'TRADER_NO_PRICE', count(*)::text, extract(epoch from inrp2p_now() - min(coalesce(approved_at, applied_at)))::text
      from trader_profile t where t.status = 'APPROVED'
       and not exists (select 1 from trader_block b where b.trader_id = t.id and ((b.rate_basis = 'FIXED' and b.rate_micro is not null) or (b.rate_basis = 'MARKET' and b.market_offset_bps is not null)))
    union all
    select 'TRADER_OFFLINE', count(*)::text, null
      from trader_profile t where t.status = 'APPROVED' and not t.available`.execute(ex);
  const LABELS: Record<string, string> = {
    NEW_ACCOUNT: 'Signed in, no account', NEEDS_DESTINATION: 'Account, nowhere to be paid', DESTINATION_IN_REVIEW: 'Payout details waiting for the desk',
    READY: 'Set up, never asked', WAITING: 'Waiting for a trader now', TRADER_RESERVE_DUE: 'Applicants: reserve not in',
    TRADER_FLAGGED: 'Applicants waiting for a person', TRADER_NO_PRICE: 'Approved traders with no price', TRADER_OFFLINE: 'Approved traders offline',
  };
  return r.rows.map((x) => {
    const secs = x.oldest === null ? null : Number.parseInt(x.oldest.split('.')[0]!, 10);
    return { key: x.key, label: LABELS[x.key] ?? x.key, people: Number.parseInt(x.n, 10), oldestHours: secs === null || Number.isNaN(secs) ? null : (secs - (secs % 3600)) / 3600 };
  });
}

export async function robotIntel(ex: Executor, opts: { aiConfigured: boolean; canSeeTraders: boolean }): Promise<RobotIntel> {
  const [policy, w] = await Promise.all([currentRobotPolicy(ex), loadWorld(ex)]);
  const [steps, waitingRows, unpriced, traderSides, playbookRows, answerRows, intents, cases, recent] = await Promise.all([
    funnel(ex),
    ex.selectFrom('trade_request').select(['direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor'])
      .where('status', '=', 'OPEN').where('waiting_until', 'is not', null).where('desk_id', 'is', null).execute(),
    ex.selectFrom('trade_request').select(['no_price_reason']).select((eb) => eb.fn.countAll<string>().as('n'))
      .where('desk_id', 'is', null).where('status', 'in', ['DECLINED', 'EXPIRED']).where('no_price_reason', 'is not', null)
      .where('closed_at', '>', sql<Date>`inrp2p_now() - interval '7 days'`).groupBy('no_price_reason').execute(),
    ex.selectFrom('trader_block as b').innerJoin('trader_profile as t', 't.id', 'b.trader_id').innerJoin('liquidity_route as r', 'r.id', 'b.route_id')
      .select(['b.side']).select(sql<string>`count(distinct t.id)`.as('n'))
      .where('t.status', '=', 'APPROVED').where('r.execution_mode', '=', 'P2P').groupBy('b.side').execute(),
    ex.selectFrom('robot_touch').select(['playbook', 'mode', 'delivery'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .select(sql<string>`count(*) filter (where acted_at is not null)`.as('acted'))
      .where('created_at', '>', sql<Date>`inrp2p_now() - interval '30 days'`).groupBy(['playbook', 'mode', 'delivery']).execute(),
    ex.selectFrom('robot_exchange').select(['source']).select((eb) => eb.fn.countAll<string>().as('n'))
      .where('created_at', '>', sql<Date>`inrp2p_now() - interval '7 days'`).groupBy('source').execute(),
    ex.selectFrom('robot_exchange').select(['intent']).select((eb) => eb.fn.countAll<string>().as('n'))
      .where('created_at', '>', sql<Date>`inrp2p_now() - interval '7 days'`).groupBy('intent').orderBy(sql`count(*)`, 'desc').limit(6).execute(),
    ex.selectFrom('robot_case as c').leftJoin('client as cl', 'cl.id', 'c.client_id').leftJoin('auth_user as u', 'u.id', 'c.user_id')
      .select(['c.ref', 'c.channel', 'c.question', 'c.context', 'c.created_at', 'c.updated_at', 'cl.display_name', 'u.email'])
      .where('c.status', '=', 'OPEN').orderBy('c.created_at').limit(50).execute(),
    ex.selectFrom('robot_touch as t').leftJoin('client as cl', 'cl.id', 't.client_id').innerJoin('auth_user as u', 'u.id', 't.user_id')
      .select(['t.created_at', 't.playbook', 't.title', 't.mode', 't.channel', 't.delivery', 't.acted_at', 'cl.display_name', 'u.email'])
      .orderBy('t.created_at', 'desc').limit(40).execute(),
  ]);

  const waiting = Object.fromEntries(DIRECTIONS.map((d) => [d, { requests: 0, usdtMinor: 0n }])) as Record<DirectionValue, { requests: number; usdtMinor: bigint }>;
  for (const r of waitingRows) {
    const t = waiting[r.direction];
    t.requests += 1;
    if (r.fixed_side === 'BASE' && r.requested_base_minor !== null) t.usdtMinor += r.requested_base_minor;
    else if (r.requested_quote_minor !== null && w.market[r.direction] !== null) t.usdtMinor += usdtOf(r.requested_quote_minor, w.market[r.direction]!);
  }
  const byReason: Record<string, number> = {};
  let unpricedTotal = 0;
  for (const u of unpriced) {
    const n = Number.parseInt(u.n, 10);
    byReason[u.no_price_reason ?? 'UNKNOWN'] = n;
    unpricedTotal += n;
  }
  const sideCount = (side: string) => Number.parseInt(traderSides.find((s) => s.side === side)?.n ?? '0', 10);
  const liquidity = {
    SELL_USDT: { sidesOnline: w.sides.filter((s) => s.side === 'BUY_USDT').length, tradersWithSide: sideCount('BUY_USDT') },
    BUY_USDT: { sidesOnline: w.sides.filter((s) => s.side === 'SELL_USDT').length, tradersWithSide: sideCount('SELL_USDT') },
  };

  const stats = new Map<string, { sent: number; dryRun: number; acted: number; failed: number }>();
  for (const r of playbookRows) {
    const s = stats.get(r.playbook) ?? { sent: 0, dryRun: 0, acted: 0, failed: 0 };
    const n = Number.parseInt(r.n, 10);
    if (r.mode === 'DRY_RUN') s.dryRun += n;
    else s.sent += n;
    if (r.delivery === 'FAILED') s.failed += n;
    s.acted += Number.parseInt(r.acted, 10);
    stats.set(r.playbook, s);
  }
  const answers = { rule: 0, ai: 0, toPerson: 0 };
  for (const a of answerRows) {
    const n = Number.parseInt(a.n, 10);
    if (a.source === 'RULE') answers.rule += n;
    else if (a.source === 'AI') answers.ai += n;
    else answers.toPerson += n;
  }
  const who = (name: string | null, email: string | null) => name ?? (email && !email.endsWith('telegram.invalid') ? email : 'Someone with no account yet');

  return {
    policy,
    aiConfigured: opts.aiConfigured,
    market: { fresh: w.market.SELL_USDT !== null && w.market.BUY_USDT !== null },
    switches: { autoQuote: w.autoQuote, autoReview: w.autoReview, peer: w.peer.enabled },
    liquidity,
    demand: {
      waiting: Object.fromEntries(DIRECTIONS.map((d) => [d, { requests: waiting[d].requests, usdt: wholeUsdt(waiting[d].usdtMinor) }])) as RobotIntel['demand']['waiting'],
      unpriced7d: { requests: unpricedTotal, byReason },
      asked7d: Object.fromEntries(DIRECTIONS.map((d) => [d, { requests: w.demand[d].requests, usdt: wholeUsdt(w.demand[d].usdtMinor) }])) as RobotIntel['demand']['asked7d'],
    },
    funnel: steps,
    playbooks: [...stats.entries()].map(([key, s]) => ({ key, label: PLAYBOOK_LABELS[key] ?? key, ...s })).sort((a, b) => b.sent + b.dryRun - (a.sent + a.dryRun)),
    answers7d: { ...answers, topIntents: intents.map((i) => ({ intent: i.intent, n: Number.parseInt(i.n, 10) })) },
    openCases: cases.map((c) => {
      const ctx = c.context as { facts?: unknown } | null;
      return {
        ref: c.ref, channel: c.channel, who: who(c.display_name, c.email), question: c.question,
        context: typeof ctx?.facts === 'string' ? ctx.facts : null, createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString(),
      };
    }),
    recent: recent.map((t) => ({
      at: t.created_at.toISOString(), playbook: t.playbook, label: PLAYBOOK_LABELS[t.playbook] ?? t.playbook, who: who(t.display_name, t.email), title: t.title,
      mode: t.mode, channel: t.channel, delivery: t.delivery, acted: t.acted_at !== null,
    })),
    recommendations: recommend({ policy, w, steps, waiting, liquidity, unpricedTotal, byReason, openCases: cases.length, aiConfigured: opts.aiConfigured }),
  };
}

/** The few things worth doing, from the facts above — each with where it is done. Nothing here acts by itself. */
export function recommend(x: {
  policy: RobotPolicy;
  w: RobotWorld;
  steps: readonly FunnelStep[];
  waiting: Record<DirectionValue, { requests: number; usdtMinor: bigint }>;
  liquidity: Record<DirectionValue, { sidesOnline: number; tradersWithSide: number }>;
  unpricedTotal: number;
  byReason: Record<string, number>;
  openCases: number;
  aiConfigured: boolean;
}): Recommendation[] {
  const out: Recommendation[] = [];
  const step = (k: string) => x.steps.find((s) => s.key === k);
  if (x.w.market.SELL_USDT === null || x.w.market.BUY_USDT === null) {
    out.push({ key: 'market_stale', severity: 'ACT', title: 'No fresh market reading', detail: 'Automatic prices and every market-rate trader side are paused until the reference is read again. Check the reference feed.', href: '/system' });
  }
  if (!x.w.autoQuote) {
    out.push({ key: 'auto_off', severity: 'ACT', title: 'Automatic prices are off', detail: 'Every request waits for a dealer, and nothing is priced at night. Switch them on in Rates.', href: '/rates' });
  }
  for (const d of ['SELL_USDT', 'BUY_USDT'] as const) {
    const wt = x.waiting[d];
    if (wt.requests === 0) continue;
    const l = x.liquidity[d];
    const side = d === 'SELL_USDT' ? 'buy' : 'sell';
    if (l.tradersWithSide === 0) {
      out.push({ key: `no_side_${d}`, severity: 'ACT', title: `${wt.requests} waiting to ${d === 'SELL_USDT' ? 'sell' : 'buy'} — no trader ${side}s USDT at all`, detail: `About ${wholeUsdt(wt.usdtMinor)} USDT waits and no approved trader offers that side. Recruit one, or ask a trader to open it.`, href: '/trader-desk' });
    } else if (l.sidesOnline === 0) {
      out.push({ key: `none_online_${d}`, severity: 'WATCH', title: `${wt.requests} waiting to ${d === 'SELL_USDT' ? 'sell' : 'buy'}; nobody with that side is online`, detail: `${l.tradersWithSide} trader${l.tradersWithSide === 1 ? ' has' : 's have'} the side and ${l.tradersWithSide === 1 ? 'was' : 'were'} told a client waits. Their market-rate offers come back the moment they go online.`, href: '/trader-desk' });
    }
  }
  if (!x.w.peer.enabled && x.waiting.SELL_USDT.requests > 0 && x.waiting.BUY_USDT.requests > 0) {
    out.push({ key: 'peer_off', severity: 'ACT', title: 'Clients on both sides are waiting', detail: 'Sellers and buyers wait at the same time with no trader between them. With "Clients meet clients" on, they could meet each other.', href: '/rates' });
  }
  if ((x.byReason.OUTSIDE_LIMIT ?? 0) + (x.byReason.NOT_COMPETITIVE ?? 0) >= 3) {
    out.push({ key: 'prices_off_market', severity: 'WATCH', title: 'Traders\' prices miss what clients accept', detail: `${(x.byReason.OUTSIDE_LIMIT ?? 0) + (x.byReason.NOT_COMPETITIVE ?? 0)} requests this week went unpriced because offers sat outside the market or the client's own bound.`, href: '/trader-desk' });
  }
  const flagged = step('TRADER_FLAGGED');
  if (flagged && flagged.people > 0) {
    out.push({ key: 'applications_waiting', severity: (flagged.oldestHours ?? 0) >= 24 ? 'ACT' : 'WATCH', title: `${flagged.people} trader application${flagged.people === 1 ? '' : 's'} need a person`, detail: `Rules could not settle ${flagged.people === 1 ? 'it' : 'them'}${flagged.oldestHours !== null ? `; the oldest has waited ${flagged.oldestHours} h` : ''}.${x.w.autoReview ? '' : ' Reviews by rule are off — every application waits for a person.'}`, href: '/trader-desk' });
  }
  const review = step('DESTINATION_IN_REVIEW');
  if (review && review.people > 0 && (review.oldestHours ?? 0) >= 2) {
    out.push({ key: 'destinations_waiting', severity: 'ACT', title: `${review.people} client${review.people === 1 ? '' : 's'} can't trade until payout details are verified`, detail: `The oldest has waited ${review.oldestHours} h.`, href: '/clients' });
  }
  if (x.openCases > 0) {
    out.push({ key: 'cases', severity: 'ACT', title: `${x.openCases} question${x.openCases === 1 ? '' : 's'} for a person`, detail: 'People asked the robot something it passed on. Answer below — it reaches them where they asked.', href: null });
  }
  if (x.policy.outreach !== 'ON') {
    const stuck = ['NEW_ACCOUNT', 'NEEDS_DESTINATION', 'READY', 'TRADER_RESERVE_DUE', 'TRADER_NO_PRICE'].reduce((n, k) => n + (step(k)?.people ?? 0), 0);
    if (stuck > 0) out.push({ key: 'outreach_off', severity: 'WATCH', title: `The robot is ${x.policy.outreach === 'OFF' ? 'off' : 'in a dry run'}: ${stuck} people stuck on their way in hear nothing`, detail: 'Read what it would send under Activity, then switch outreach on.', href: null });
  }
  if (x.policy.answers === 'AI' && !x.aiConfigured) {
    out.push({ key: 'ai_unconfigured', severity: 'WATCH', title: 'Model answers are on but no model is configured', detail: 'Questions no rule knows go to a person. Set ANTHROPIC_API_KEY on the web app, or switch answers to rules.', href: null });
  }
  return out;
}
