import { sql } from 'kysely';
import { DomainError, Money, type P2pTiming, requireP2pTiming, requireText } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ChainVerifier, CustodyAdapter, FieldProtector } from '@inrp2p/adapters';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { type RiskPolicy, requireRiskPolicy } from './risk.ts';

/**
 * What trader commands need from the outside world: the custody provider that issues a trader's reserve and
 * delivery addresses (D-02), the field protector that seals a trader's bank details, and the chain verifier that
 * confirms USDT movements (FI-24).
 */
export interface TraderDeps {
  readonly custody: CustodyAdapter;
  readonly protector: FieldProtector;
  readonly chain: ChainVerifier;
}

/**
 * The trader programme's settings, as the operator last set them. Nothing here has a default that stands in for a
 * decision: the Security Reserve amount is absent until an operator sets it, and the product says so rather than
 * inventing a number. Traders deal P2P (ADR 0019): a client's rupees go straight to and from its trader.
 */
export interface TraderProgram {
  readonly defaultRequiredReserve: Money<'USDT'> | null;
  readonly offerTtlSeconds: number;
  readonly holdTtlSeconds: number;
  readonly autoAssign: boolean;
  /** ADR 0023: how long each step of a P2P deal may take, by rail. A running deal keeps the timing it opened with. */
  readonly p2pTiming: P2pTiming;
  /** ADR 0024: applications and settled changes reviewed by the programme's rules; whatever they cannot settle waits for a person. */
  readonly autoReview: boolean;
  /** ADR 0024: how far a trader's reserve stretches at each level; null — only the requirement and the desk's ceilings. */
  readonly riskPolicy: RiskPolicy | null;
  /** ADR 0024: how long a change of an approved trader's bank account or wallet waits before it can take effect. */
  readonly settlementChangeHoldHours: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export async function traderProgram(ex: Executor): Promise<TraderProgram> {
  const r = await ex.selectFrom('trader_program').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
  return {
    defaultRequiredReserve: r.default_required_reserve_minor === null ? null : Money.ofMinor(r.default_required_reserve_minor, 'USDT'),
    offerTtlSeconds: r.offer_ttl_seconds,
    holdTtlSeconds: r.hold_ttl_seconds,
    autoAssign: r.auto_assign,
    p2pTiming: requireP2pTiming(r.p2p_timing),
    autoReview: r.auto_review,
    riskPolicy: r.risk_policy === null ? null : requireRiskPolicy(r.risk_policy),
    settlementChangeHoldHours: r.settlement_change_hold_hours,
    version: r.version,
    updatedAt: r.updated_at,
  };
}

export interface ConfigureProgramPayload {
  readonly expectedVersion: number;
  /** Decimal USDT, or null to leave the reserve unset. */
  readonly defaultRequiredReserve?: string | null;
  readonly offerTtlSeconds?: number;
  readonly holdTtlSeconds?: number;
  readonly autoAssign?: boolean;
  /** ADR 0023: the P2P deal timing — escrow, the time to pay and to confirm by rail, the final period. */
  readonly p2pTiming?: P2pTiming;
  /** ADR 0024: review applications by rule. Switching it on reviews every application already waiting. */
  readonly autoReview?: boolean;
  /** ADR 0024: the reserve-based limits, or null to switch them off. */
  readonly riskPolicy?: RiskPolicy | null;
  readonly settlementChangeHoldHours?: number;
  readonly reason: string;
}

const wholeInRange = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a whole number between ${min} and ${max}`, { field });
  }
  return value;
};

/**
 * `trader_program.configure` — `traders:configure` (⧗). One audited change to the programme; orders already in
 * flight keep the terms they were given.
 */
export function configureTraderProgram(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: ConfigureProgramPayload) => {
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('trader_program').selectAll().where('id', '=', 1).forUpdate().executeTakeFirstOrThrow();
    if (before.version !== p.expectedVersion) throw new DomainError('STALE_VERSION', `the programme is at version ${before.version}`);
    const changes: Record<string, unknown> = {};
    if (p.defaultRequiredReserve !== undefined) {
      if (p.defaultRequiredReserve === null || p.defaultRequiredReserve === '') changes.default_required_reserve_minor = null;
      else {
        const reserve = Money.parse(p.defaultRequiredReserve, 'USDT');
        if (!reserve.isPositive()) throw new DomainError('INVALID_AMOUNT', 'the Security Reserve must be positive');
        changes.default_required_reserve_minor = reserve.minor;
      }
    }
    if (p.offerTtlSeconds !== undefined) changes.offer_ttl_seconds = wholeInRange(p.offerTtlSeconds, 'offerTtlSeconds', 30, 900);
    if (p.holdTtlSeconds !== undefined) changes.hold_ttl_seconds = wholeInRange(p.holdTtlSeconds, 'holdTtlSeconds', 60, 900);
    if (p.autoAssign !== undefined) changes.auto_assign = Boolean(p.autoAssign);
    if (p.p2pTiming !== undefined) changes.p2p_timing = JSON.stringify(requireP2pTiming(p.p2pTiming));
    if (p.autoReview !== undefined) changes.auto_review = p.autoReview === true;
    if (p.riskPolicy !== undefined) changes.risk_policy = p.riskPolicy === null ? null : JSON.stringify(requireRiskPolicy(p.riskPolicy));
    if (p.settlementChangeHoldHours !== undefined) changes.settlement_change_hold_hours = wholeInRange(p.settlementChangeHoldHours, 'settlementChangeHoldHours', 1, 168);
    const after = await ctx.tx
      .updateTable('trader_program')
      .set({ ...changes, updated_by: actorLabel(ctx), updated_at: sql<Date>`statement_timestamp()`, version: before.version + 1 })
      .where('id', '=', 1)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'trader_program.configured', entityType: 'trader_program', entityId: null,
      before: { default_required_reserve_minor: before.default_required_reserve_minor, offer_ttl_seconds: before.offer_ttl_seconds, hold_ttl_seconds: before.hold_ttl_seconds, auto_assign: before.auto_assign, p2p_timing: before.p2p_timing, auto_review: before.auto_review, risk_policy: before.risk_policy, settlement_change_hold_hours: before.settlement_change_hold_hours, version: before.version },
      after: { default_required_reserve_minor: after.default_required_reserve_minor, offer_ttl_seconds: after.offer_ttl_seconds, hold_ttl_seconds: after.hold_ttl_seconds, auto_assign: after.auto_assign, p2p_timing: after.p2p_timing, auto_review: after.auto_review, risk_policy: after.risk_policy, settlement_change_hold_hours: after.settlement_change_hold_hours, version: after.version, reason },
    });
    // Switched on: the applications already waiting are reviewed by rule now, not when something next happens to them.
    if (!before.auto_review && after.auto_review) {
      await enqueueOutbox(ctx, { type: 'trader_program.auto_review_enabled', aggregateType: 'trader_program', payload: {} });
    }
    return { version: after.version };
  });
}
