import { sql } from 'kysely';
import { DomainError, type MarketReferences, Rate, requireText, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { type ReferenceRateSnapshot, currentReferenceRate, recordReferenceRate } from './rates.ts';

/**
 * The pricing policy of the INRP2P exchange (ADR 0025): whether its clients get a firm price at once, and the guard-rails
 * of the automatic choice. None of it is a mark-up — the price comes from the traders' rates, the deal's costs and what
 * clients accepted; the policy only says how fresh the market reference must be, how far past it a price may go, how
 * acceptance is counted, and how price requests run. Append-only: its latest row is the policy (migration 0045).
 */
export interface PricingPolicy {
  readonly id: string;
  readonly autoQuote: boolean;
  readonly rfq: boolean;
  readonly referenceMaxAgeSeconds: number;
  readonly maxPremiumBps: number;
  readonly binBps: number;
  readonly learningDays: number;
  readonly rfqWindowSeconds: number;
  readonly rfqMaxTraders: number;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: Date;
}

export async function currentPricingPolicy(ex: Executor): Promise<PricingPolicy> {
  const r = await ex.selectFrom('pricing_policy').selectAll().orderBy('set_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'no pricing policy is recorded');
  return {
    id: r.id, autoQuote: r.auto_quote, rfq: r.rfq, referenceMaxAgeSeconds: r.reference_max_age_seconds, maxPremiumBps: r.max_premium_bps, binBps: r.bin_bps,
    learningDays: r.learning_days, rfqWindowSeconds: r.rfq_window_seconds, rfqMaxTraders: r.rfq_max_traders, reason: r.reason, setBy: r.set_by, setAt: r.set_at,
  };
}

/**
 * The market reference of a direction when it is fresh enough for the policy to price on; null otherwise. Its age is
 * judged by the business clock (`inrp2p_now()`), the clock every quote's validity and every deadline is judged by.
 */
export async function freshReference(ex: Executor, direction: DirectionValue, policy: Pick<PricingPolicy, 'referenceMaxAgeSeconds'>): Promise<ReferenceRateSnapshot | null> {
  const ref = await currentReferenceRate(ex, direction);
  if (!ref) return null;
  const r = await sql<{ age: string }>`select floor(extract(epoch from (inrp2p_now() - ${ref.effectiveAt}::timestamptz)))::bigint::text as age`.execute(ex);
  const ageSeconds = Number.parseInt(r.rows[0]!.age, 10);
  return ageSeconds >= 0 && ageSeconds <= policy.referenceMaxAgeSeconds ? { ...ref, ageSeconds } : null;
}

/**
 * ADR 0028: the market references a trader's market rate may be derived from — each direction's while it is fresh enough
 * for the policy to price on, null otherwise. A side at a market rate has no rate without its own.
 */
export async function marketReferences(ex: Executor, policy?: Pick<PricingPolicy, 'referenceMaxAgeSeconds'>): Promise<MarketReferences> {
  const p = policy ?? (await currentPricingPolicy(ex));
  const [sell, buy] = await Promise.all([freshReference(ex, 'SELL_USDT', p), freshReference(ex, 'BUY_USDT', p)]);
  return {
    SELL_USDT: sell ? { snapshotId: sell.id, micro: sell.rate.micro } : null,
    BUY_USDT: buy ? { snapshotId: buy.id, micro: buy.rate.micro } : null,
  };
}

/**
 * The market reference as the public site may show it: the rate of each direction while it is fresh enough for the policy
 * to price on, and nothing else — no source, no time, no figure of INRP2P's own. It is the market's rate, not a price: the
 * page says so, and a client's firm price still comes from a quote.
 */
export interface PublicMarketRates {
  readonly SELL_USDT: string | null;
  readonly BUY_USDT: string | null;
}

export async function publicMarketRates(ex: Executor): Promise<PublicMarketRates> {
  const policy = await currentPricingPolicy(ex);
  const sell = await freshReference(ex, 'SELL_USDT', policy);
  const buy = await freshReference(ex, 'BUY_USDT', policy);
  return { SELL_USDT: sell?.rate.toDecimalString() ?? null, BUY_USDT: buy?.rate.toDecimalString() ?? null };
}

/**
 * The market's last day as a line for a glance (the workspace's ticker): the reference's mid — both directions averaged
 * — hour by hour, oldest first. It is the same append-only history the references are read from, nothing more; an hour
 * the feed did not report is simply missing. Empty when there is no history, and then no line is drawn.
 */
export async function marketTrail(ex: Executor, hours = 24): Promise<readonly string[]> {
  const span = Math.max(1, Math.min(168, Math.trunc(hours)));
  const rows = await sql<{ r: string }>`
    select (avg(rate_micro))::bigint::text as r
      from rate_snapshot
     where kind = 'REFERENCE'
       and effective_at > inrp2p_now() - make_interval(hours => ${span})
       and effective_at <= inrp2p_now()
     group by date_bin('1 hour', effective_at, timestamptz '2000-01-01')
     order by date_bin('1 hour', effective_at, timestamptz '2000-01-01')`.execute(ex);
  return rows.rows.map((x) => Rate.ofMicro(BigInt(x.r), 'REFERENCE').toDecimalString());
}

export interface SetPricingPolicyPayload {
  /** The policy the person was looking at: a change made meanwhile is not overwritten. */
  readonly expectedPolicyId: string;
  readonly autoQuote?: boolean;
  readonly rfq?: boolean;
  readonly referenceMaxAgeSeconds?: number;
  readonly maxPremiumBps?: number;
  readonly binBps?: number;
  readonly learningDays?: number;
  readonly rfqWindowSeconds?: number;
  readonly rfqMaxTraders?: number;
  readonly reason: string;
}

const whole = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a whole number from ${min} to ${max}`, { field });
  }
  return value;
};

/**
 * `pricing.set_policy` — `pricing:configure` (⧗). A new row of the policy; prices already given keep the decision they
 * were made with (`auto_quote.policy_id`). Switching automatic prices on is refused while the market reference of either
 * direction is missing or older than the policy allows — a policy that could not price anything is not switched on
 * blind. Switching off is never refused: from then on every request waits for a person, as before.
 */
export function setPricingPolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'pricing:configure', async (ctx, p: SetPricingPolicyPayload) => {
    const reason = requireText(p.reason, 'reason', 500);
    await sql`select pg_advisory_xact_lock(hashtext('inrp2p.pricing_policy'))`.execute(ctx.tx);
    const before = await currentPricingPolicy(ctx.tx);
    if (before.id !== requireUuid(p.expectedPolicyId, 'expectedPolicyId')) throw new DomainError('STALE_VERSION', 'the pricing policy changed since you opened it; reload and try again');
    const next = {
      autoQuote: p.autoQuote === undefined ? before.autoQuote : p.autoQuote === true,
      rfq: p.rfq === undefined ? before.rfq : p.rfq === true,
      referenceMaxAgeSeconds: p.referenceMaxAgeSeconds === undefined ? before.referenceMaxAgeSeconds : whole(p.referenceMaxAgeSeconds, 'referenceMaxAgeSeconds', 60, 3600),
      maxPremiumBps: p.maxPremiumBps === undefined ? before.maxPremiumBps : whole(p.maxPremiumBps, 'maxPremiumBps', 0, 500),
      binBps: p.binBps === undefined ? before.binBps : whole(p.binBps, 'binBps', 1, 100),
      learningDays: p.learningDays === undefined ? before.learningDays : whole(p.learningDays, 'learningDays', 1, 365),
      rfqWindowSeconds: p.rfqWindowSeconds === undefined ? before.rfqWindowSeconds : whole(p.rfqWindowSeconds, 'rfqWindowSeconds', 30, 900),
      rfqMaxTraders: p.rfqMaxTraders === undefined ? before.rfqMaxTraders : whole(p.rfqMaxTraders, 'rfqMaxTraders', 1, 20),
    };
    if (next.autoQuote && !before.autoQuote) {
      for (const direction of ['SELL_USDT', 'BUY_USDT'] as const) {
        if (!(await freshReference(ctx.tx, direction, next))) {
          throw new DomainError('MARKET_REFERENCE_STALE', `there is no market reference for ${direction === 'SELL_USDT' ? 'selling' : 'buying'} USDT within the last ${next.referenceMaxAgeSeconds} seconds: automatic prices would have nothing to be bounded by`);
        }
      }
    }
    const row = await ctx.tx
      .insertInto('pricing_policy')
      .values({
        auto_quote: next.autoQuote, rfq: next.rfq, reference_max_age_seconds: next.referenceMaxAgeSeconds, max_premium_bps: next.maxPremiumBps, bin_bps: next.binBps,
        learning_days: next.learningDays, rfq_window_seconds: next.rfqWindowSeconds, rfq_max_traders: next.rfqMaxTraders, reason, set_by: actorLabel(ctx),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'pricing.policy_set', entityType: 'pricing_policy', entityId: row.id,
      before: { policy_id: before.id, auto_quote: before.autoQuote, rfq: before.rfq, reference_max_age_seconds: before.referenceMaxAgeSeconds, max_premium_bps: before.maxPremiumBps, bin_bps: before.binBps, learning_days: before.learningDays, rfq_window_seconds: before.rfqWindowSeconds, rfq_max_traders: before.rfqMaxTraders },
      after: {
        auto_quote: next.autoQuote, rfq: next.rfq, reference_max_age_seconds: next.referenceMaxAgeSeconds, max_premium_bps: next.maxPremiumBps, bin_bps: next.binBps,
        learning_days: next.learningDays, rfq_window_seconds: next.rfqWindowSeconds, rfq_max_traders: next.rfqMaxTraders, reason,
      },
    });
    return { policyId: row.id };
  });
}

/** The feed's name in `rate_snapshot.source`; what each book said goes into the audit event. */
export const MARKET_FEED_SOURCE = 'FEED:indian_books';

/**
 * Publishes the market reference read from public order books (`reference_rate_refresh`), under the system actor: the
 * market's bid as the reference of a client selling USDT, its ask as that of a client buying. A direction whose price moved
 * more than `maxJumpBps` from its last reference is not published automatically — it may be a broken feed; it waits for
 * the next reading or for a person (`rates.record_reference_rate`). A reference only bounds prices (FI-01, FI-108): it is
 * never a client's or a trader's rate.
 */
export async function recordMarketReference(ctx: TxContext, reading: { bidMicro: bigint; askMicro: bigint; source: string }, maxJumpBps = 500n): Promise<{ recorded: DirectionValue[]; skipped: string[] }> {
  const recorded: DirectionValue[] = [];
  const skipped: string[] = [];
  const detail = requireText(reading.source, 'source', 200);
  for (const [direction, micro] of [['SELL_USDT', reading.bidMicro], ['BUY_USDT', reading.askMicro]] as const) {
    if (micro <= 0n || micro > 100_000_000_000n) throw new DomainError('INVALID_RATE', 'a USDT price in rupees is a positive number');
    const last = await currentReferenceRate(ctx.tx, direction);
    if (last) {
      const move = micro > last.rate.micro ? micro - last.rate.micro : last.rate.micro - micro;
      if (move * 10_000n > last.rate.micro * maxJumpBps) {
        skipped.push(`${direction}: ${Rate.ofMicro(micro, 'REFERENCE').toDecimalString()} moved more than ${maxJumpBps} bps from ${last.rate.toDecimalString()}`);
        continue;
      }
    }
    const { snapshotId } = await recordReferenceRate(ctx, { direction, rate: Rate.ofMicro(micro, 'REFERENCE'), source: MARKET_FEED_SOURCE });
    await appendAudit(ctx, { action: 'rate.market_reference_read', entityType: 'rate_snapshot', entityId: snapshotId, after: { direction, rate: Rate.ofMicro(micro, 'REFERENCE'), read_from: detail } });
    recorded.push(direction);
  }
  return { recorded, skipped };
}
