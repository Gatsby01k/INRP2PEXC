import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Db, DirectionValue, RobotChannel } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type BookRequest, bestPeerFor, bookContext } from '@inrp2p/quotes';
import { type ContactRefusal, inQuietHours, mayContact } from './contact.ts';
import { type PersonFacts, personFacts } from './facts.ts';
import { type Journey, journeyOf } from './journey.ts';
import { DEMAND_MATCH, type Draft, PLAYBOOKS, type Playbook, attemptDue } from './playbooks.ts';
import { type RobotPolicy, currentRobotPolicy } from './policy.ts';
import { rateWords, usdtWords } from './format.ts';
import { type RobotWorld, loadWorld } from './world.ts';

/**
 * The robot's rounds (ADR 0034 §2.6), every ten minutes in the worker: who is stuck where, whether a message is worth
 * sending, sending at most one per person, and noticing who then did the thing. Deterministic end to end — no model is
 * asked anything here — and cheap: one statement finds the few people with something due, and only they are read whole.
 *
 * In a dry run every decision is made and recorded exactly as it would be, and nothing leaves: the desk reads what the
 * robot would have sent, to whom and why, before anyone switches it on.
 */
const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

export interface TouchInput {
  readonly userId: string;
  readonly clientId: string | null;
  readonly playbook: string;
  readonly subject: string;
  readonly attempt: number;
  readonly mode: 'LIVE' | 'DRY_RUN';
  readonly channel: RobotChannel | null;
  readonly draft: Draft;
}

/**
 * One touch, recorded once: the database refuses a second of the same person, playbook, subject, mode and attempt, so
 * two sweeps at once — or a sweep run again — never send the same message twice. A live touch enqueues its delivery in
 * the same transaction, and is audited as something INRP2P told a person.
 */
export async function recordTouch(db: Db, t: TouchInput): Promise<{ readonly id: string } | null> {
  const out = await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      const row = await ctx.tx.insertInto('robot_touch')
        .values({
          user_id: t.userId, client_id: t.clientId, playbook: t.playbook, subject: t.subject.slice(0, 80), attempt: t.attempt, mode: t.mode,
          channel: t.channel, title: t.draft.title.slice(0, 120), body: t.draft.body.slice(0, 400), href: t.draft.href.slice(0, 280),
          delivery: t.mode === 'LIVE' && t.channel !== null ? 'PENDING' : 'NONE',
        })
        .onConflict((oc) => oc.columns(['user_id', 'playbook', 'subject', 'mode', 'attempt']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) return null;
      if (t.mode === 'LIVE') {
        await appendAudit(ctx, { action: 'robot.touch', entityType: 'robot_touch', entityId: row.id, after: { user_id: t.userId, playbook: t.playbook, subject: t.subject, attempt: t.attempt, channel: t.channel } });
        await enqueueOutbox(ctx, { type: 'robot.note', aggregateType: 'robot_touch', aggregateId: row.id, payload: { touchId: row.id } });
      }
      return { id: row.id };
    },
  }, { name: 'robot.touch', actor: SYSTEM, payload: { userId: t.userId, playbook: t.playbook, subject: t.subject, attempt: t.attempt, mode: t.mode }, idempotencyKey: null, financial: false });
  return out.result;
}

export type Decision =
  | { readonly kind: 'TOUCH'; readonly playbook: Playbook; readonly attempt: number; readonly draft: Draft; readonly channel: RobotChannel | null; readonly subject: string }
  | { readonly kind: 'REFUSED'; readonly playbook: string; readonly why: ContactRefusal }
  | { readonly kind: 'NOTHING' };

/**
 * What the robot does about one person now: the first playbook — in the catalogue's order, trader steps first — whose
 * stage the person is at, whose attempt is due, that has something true to say, and that the contact rules allow.
 */
export function decide(f: PersonFacts, j: Journey, w: RobotWorld, policy: RobotPolicy): Decision {
  const mode = policy.outreach === 'ON' ? 'LIVE' : 'DRY_RUN';
  let refused: Decision | null = null;
  for (const p of PLAYBOOKS) {
    const s = p.track === 'TRADER' ? j.trader : j.exchange;
    if (!s || s.stage !== p.stage || !p.audience(f)) continue;
    const attempt = attemptDue(p, s, f.touches, mode, w.now);
    if (attempt === null) continue;
    const draft = p.compose(f, s, w, attempt);
    if (!draft) continue;
    const gate = mayContact(f, p, policy, w.now);
    if (!gate.ok) {
      refused ??= { kind: 'REFUSED', playbook: p.key, why: gate.why };
      continue;
    }
    return { kind: 'TOUCH', playbook: p, attempt, draft, channel: gate.channel, subject: s.subject };
  }
  return refused ?? { kind: 'NOTHING' };
}

export interface RobotSweepReport {
  readonly mode: RobotPolicy['outreach'];
  readonly looked: number;
  readonly touched: number;
  readonly refused: Readonly<Partial<Record<ContactRefusal, number>>>;
  readonly demand: number;
  readonly acted: number;
  readonly purged: number;
  readonly failures: readonly { readonly userId: string; readonly message: string }[];
}

/** How many people one sweep reads whole, at most. */
const SWEEP_LIMIT = 200;

/**
 * The people who may have something due, in one statement: a stage a playbook serves, recent enough, not written to by
 * the robot in the last day, not opted out. Everything finer is the playbooks' to judge on the person's whole facts.
 */
async function candidates(db: Db, limit: number, mode: 'LIVE' | 'DRY_RUN'): Promise<string[]> {
  const r = await sql<{ id: string }>`
    with people as (
      select u.id, u.created_at, cu.client_id
        from auth_user u
        left join client_user cu on cu.user_id = u.id and cu.status = 'ACTIVE'
       where u.kind = 'CLIENT' and u.status = 'ACTIVE'
         and not exists (select 1 from robot_preference p where p.user_id = u.id and p.outreach = 'NONE')
         and not exists (select 1 from robot_touch t where t.user_id = u.id and t.mode = ${mode} and t.created_at > inrp2p_now() - interval '20 hours')
    )
    select p.id from people p
     where (p.client_id is null and p.created_at > inrp2p_now() - interval '30 days' and p.created_at < inrp2p_now() - interval '30 minutes')
        or (p.client_id is not null and exists (
              select 1 from client c where c.id = p.client_id and c.status = 'ACTIVE' and c.exchange_access
                 and (c.created_at > inrp2p_now() - interval '30 days'
                      or exists (select 1 from trade_request r where r.client_id = c.id and r.desk_id is null
                                  and r.status in ('DECLINED', 'EXPIRED') and r.no_price_reason is not null
                                  and r.closed_at > inrp2p_now() - interval '7 days')
                      or exists (select 1 from trade t where t.client_id = c.id and t.lifecycle_state = 'COMPLETED'
                                  and t.completed_at > inrp2p_now() - interval '120 days'
                                  and t.completed_at < inrp2p_now() - interval '14 days'))))
        or (p.client_id is not null and exists (
              select 1 from trader_profile tp where tp.client_id = p.client_id
                 and ((tp.status = 'UNDER_REVIEW' and tp.applied_at > inrp2p_now() - interval '30 days')
                      or (tp.status = 'APPROVED' and coalesce(tp.approved_at, tp.applied_at) > inrp2p_now() - interval '30 days'))))
     order by p.created_at desc
     limit ${limit}`.execute(db);
  return r.rows.map((x) => x.id);
}

/** The person did what the touch was about: its playbook's stage (and subject) is behind them. */
function stillAt(touch: { playbook: string; subject: string }, j: Journey): boolean {
  if (touch.playbook === DEMAND_MATCH.key) return true;
  const p = PLAYBOOKS.find((x) => x.key === touch.playbook);
  if (!p) return false;
  const s = p.track === 'TRADER' ? j.trader : j.exchange;
  return s !== null && s.stage === p.stage && s.subject === touch.subject;
}

/**
 * Touches of the last fortnight whose person has since moved on are marked acted — what the desk reads as the robot's
 * effect. A demand match counts as acted when its person asked for a price after it, in the direction it suggested.
 */
async function markActed(db: Db, now: Date): Promise<number> {
  const open = await db.selectFrom('robot_touch').select(['id', 'user_id', 'client_id', 'playbook', 'subject', 'created_at'])
    .where('acted_at', 'is', null).where('created_at', '>', sql<Date>`inrp2p_now() - interval '14 days'`)
    .orderBy('created_at').limit(500).execute();
  let acted = 0;
  const facts = new Map<string, PersonFacts | null>();
  for (const t of open) {
    let done: boolean;
    if (t.playbook === DEMAND_MATCH.key) {
      done = t.client_id !== null && (await db.selectFrom('trade_request').select('id').where('client_id', '=', t.client_id).where('created_at', '>', t.created_at).executeTakeFirst()) !== undefined;
    } else {
      if (!facts.has(t.user_id)) facts.set(t.user_id, await personFacts(db, t.user_id));
      const f = facts.get(t.user_id);
      done = f ? !stillAt(t, journeyOf(f, now)) : false;
    }
    if (!done) continue;
    await db.updateTable('robot_touch').set({ acted_at: sql<Date>`inrp2p_now()` }).where('id', '=', t.id).where('acted_at', 'is', null).execute();
    acted += 1;
  }
  return acted;
}

/** Questions and answers older than 90 days are deleted: the robot remembers a person's journey, not their every word. */
async function purgeOldExchanges(db: Db): Promise<number> {
  const r = await db.deleteFrom('robot_exchange').where('created_at', '<', sql<Date>`inrp2p_now() - interval '90 days'`).executeTakeFirst();
  return Number.parseInt(String(r.numDeletedRows), 10);
}

/**
 * `checkActed`: whether this round also looks at who acted on a recent message and deletes old questions — cheap, but
 * nothing about it is urgent, so the worker does it once an hour rather than every round.
 */
export async function runRobotSweep(db: Db, opts: { limit?: number; checkActed?: boolean } = {}): Promise<RobotSweepReport> {
  const policy = await currentRobotPolicy(db);
  const now = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(db)).rows[0]!.now;
  const housekeeping = opts.checkActed ?? true;
  const acted = housekeeping ? await markActed(db, now) : 0;
  const purged = housekeeping ? await purgeOldExchanges(db) : 0;
  const base = { mode: policy.outreach, acted, purged };
  // Off, or India's night: nothing would pass the rules, so nobody is read.
  if (policy.outreach === 'OFF' || inQuietHours(policy, now)) return { ...base, looked: 0, touched: 0, refused: {}, demand: 0, failures: [] };

  const world = await loadWorld(db);
  const mode = policy.outreach === 'ON' ? 'LIVE' : 'DRY_RUN';
  const refused: Partial<Record<ContactRefusal, number>> = {};
  const failures: { userId: string; message: string }[] = [];
  let touched = 0;
  const ids = await candidates(db, opts.limit ?? SWEEP_LIMIT, mode);
  for (const id of ids) {
    try {
      const f = await personFacts(db, id);
      if (!f) continue;
      const d = decide(f, journeyOf(f, world.now), world, policy);
      if (d.kind === 'REFUSED') refused[d.why] = (refused[d.why] ?? 0) + 1;
      if (d.kind !== 'TOUCH') continue;
      const out = await recordTouch(db, { userId: id, clientId: f.member?.clientId ?? null, playbook: d.playbook.key, subject: d.subject, attempt: d.attempt, mode, channel: d.channel, draft: d.draft });
      if (out) touched += 1;
    } catch (e) {
      failures.push({ userId: id, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  const demand = await runDemandMatch(db, world, policy, mode, refused, failures);
  return { ...base, looked: ids.length, touched: touched + demand, refused, demand, failures };
}

// ---- liquidity discovery ------------------------------------------------------------------------------------------------

/** A waiting request is worth finding the other side for once it has waited this long with nothing pricing it. */
const DEMAND_AFTER_MINUTES = 10;
/** People told about one waiting request, at most, per sweep. */
const DEMAND_FANOUT = 3;
/** Someone who traded the other way within this long is a likely counterparty. */
const DEMAND_HISTORY_DAYS = 90;

/**
 * Liquidity discovery (ADR 0034 §2.5): a client waits and no trader prices it; someone who traded the other way here
 * before — and asked to hear of such things — is told there is a counterparty, and at what price they would meet it
 * now. The price is the peer book's own (`bestPeerFor`), for a request they would make at the market with their usual
 * size; if they ask, the book meets them with exactly that. Nobody is told who waits, and nothing is said when the book
 * is off, the market is stale, or the two would not cross.
 */
async function runDemandMatch(db: Db, w: RobotWorld, policy: RobotPolicy, mode: 'LIVE' | 'DRY_RUN', refused: Partial<Record<ContactRefusal, number>>, failures: { userId: string; message: string }[]): Promise<number> {
  if (!w.peer.enabled || policy.playbooksOff.includes(DEMAND_MATCH.key)) return 0;
  const book = await bookContext(db);
  if (!book) return 0;
  const waiting = await db.selectFrom('trade_request').select(['direction']).distinct()
    .where('status', '=', 'OPEN').where('desk_id', 'is', null).where('waiting_until', 'is not', null).where('peer_paused_at', 'is', null)
    .where('waiting_since', '<', sql<Date>`inrp2p_now() - make_interval(mins => ${DEMAND_AFTER_MINUTES})`)
    .execute();
  let told = 0;
  for (const { direction: waitingDirection } of waiting) {
    // A buyer waits for a seller: the people to tell sold before, and are set up to sell now (and the other way round).
    const theirs: DirectionValue = waitingDirection === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT';
    const people = await sql<{ user_id: string; client_id: string; base_minor: string }>`
      select distinct on (c.id) cu.user_id, c.id as client_id, e.base_minor::text as base_minor
        from client c
        join client_user cu on cu.client_id = c.id and cu.status = 'ACTIVE' and (cu.role = 'CLIENT_ADMIN' or cu.can_accept_quotes)
        join auth_user u on u.id = cu.user_id and u.status = 'ACTIVE'
        join robot_preference p on p.user_id = cu.user_id and p.outreach = 'ALL'
        join trade t on t.client_id = c.id and t.direction = ${theirs} and t.lifecycle_state = 'COMPLETED'
                    and t.completed_at > inrp2p_now() - make_interval(days => ${DEMAND_HISTORY_DAYS})
        join trade_economics e on e.trade_id = t.id
       where c.status = 'ACTIVE' and c.exchange_access
         and not exists (select 1 from trader_profile tp where tp.client_id = c.id and tp.status <> 'PERSONAL')
         and not exists (select 1 from trade_request r where r.client_id = c.id and r.status in ('OPEN', 'QUOTED'))
         and not exists (select 1 from trade x where x.client_id = c.id and x.lifecycle_state not in ('COMPLETED', 'CANCELLED'))
         and not exists (select 1 from robot_touch rt where rt.user_id = cu.user_id and rt.mode = ${mode} and rt.created_at > inrp2p_now() - interval '20 hours')
         and (case when ${theirs} = 'SELL_USDT'
                   then exists (select 1 from bank_account b where b.client_id = c.id and b.status = 'ACTIVE')
                   else exists (select 1 from crypto_wallet cw where cw.client_id = c.id and cw.status = 'ACTIVE' and cw.purpose <> 'SOURCE') end)
       order by c.id, t.completed_at desc
       limit 50`.execute(db);
    let fanout = 0;
    for (const person of people.rows) {
      if (fanout >= DEMAND_FANOUT) break;
      try {
        const f = await personFacts(db, person.user_id);
        if (!f?.member) continue;
        const gate = mayContact(f, DEMAND_MATCH, policy, w.now);
        if (!gate.ok) {
          refused[gate.why] = (refused[gate.why] ?? 0) + 1;
          continue;
        }
        // The request they would make now: their direction, their usual size, at the market.
        const taker: BookRequest = {
          id: randomUUID(), ref: 'PROBE', client_id: person.client_id, direction: theirs, fixed_side: 'BASE', requested_base_minor: BigInt(person.base_minor), requested_quote_minor: null,
          target_rate_micro: null, bank_account_id: null, crypto_wallet_id: null, source_wallet_id: null, status: 'OPEN', desk_id: null, waiting_since: null, waiting_until: null,
          wait_hours: null, peer_paused_at: null, peer_told_at: null, peer_told_rate_micro: null, created_by: person.user_id, version: 1,
        };
        const offer = await bestPeerFor(db, taker, book);
        if (!offer || offer.meeting.kind !== 'CROSS' || !offer.economics) continue;
        const subject = offer.maker.ref;
        if (f.touches.some((t) => t.mine && t.playbook === DEMAND_MATCH.key && t.subject === subject && t.mode === mode)) continue;
        const size = usdtWords(Money.ofMinor(offer.economics.base.minor, 'USDT').toDecimalString());
        const amount = Money.ofMinor(offer.economics.base.minor, 'USDT').toDecimalString().replace(/\.?0+$/, '');
        const sell = theirs === 'SELL_USDT';
        const draft: Draft = {
          title: sell ? `A buyer is waiting for ${size}` : `A seller is waiting with ${size}`,
          body: `Someone wants to ${sell ? 'buy' : 'sell'} ${size} right now. You ${sell ? 'sold' : 'bought'} here before — ${sell ? 'sell' : 'buy'} now and you meet them at ${rateWords(offer.meeting.takerRateMicro)} per USDT. You see the price again before you say yes.`,
          href: `/exchange?direction=${sell ? 'sell' : 'buy'}&amount=${encodeURIComponent(amount)}`,
        };
        const out = await recordTouch(db, { userId: person.user_id, clientId: person.client_id, playbook: DEMAND_MATCH.key, subject, attempt: 1, mode, channel: gate.channel, draft });
        if (out) {
          told += 1;
          fanout += 1;
        }
      } catch (e) {
        failures.push({ userId: person.user_id, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
      }
    }
  }
  return told;
}
