import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { ChainVerifier, CustodyAdapter, FieldProtector } from '@inrp2p/adapters';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';

/**
 * What trader commands need from the outside world: the custody provider that issues a trader's reserve and
 * delivery addresses (D-02), the field protector that opens the exchange's own collection account number for
 * payment instructions, and the chain verifier that confirms USDT movements (FI-24).
 */
export interface TraderDeps {
  readonly custody: CustodyAdapter;
  readonly protector: FieldProtector;
  readonly chain: ChainVerifier;
}

/**
 * The trader programme's settings, as the operator last set them. Nothing here has a default that stands in for a
 * decision: the Security Reserve amount and the reward rate are absent until an operator sets them, and the
 * product says so rather than inventing a number.
 */
export interface TraderProgram {
  readonly defaultRequiredReserve: Money<'USDT'> | null;
  /** Basis points of an order's INR value, paid on completion. Null: INRP2P pays no reward. */
  readonly rewardBps: number | null;
  readonly offerTtlSeconds: number;
  readonly holdTtlSeconds: number;
  readonly autoAssign: boolean;
  readonly collectionAccountId: string | null;
  readonly version: number;
  readonly updatedAt: Date;
}

export async function traderProgram(ex: Executor): Promise<TraderProgram> {
  const r = await ex.selectFrom('trader_program').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
  return {
    defaultRequiredReserve: r.default_required_reserve_minor === null ? null : Money.ofMinor(r.default_required_reserve_minor, 'USDT'),
    rewardBps: r.reward_bps,
    offerTtlSeconds: r.offer_ttl_seconds,
    holdTtlSeconds: r.hold_ttl_seconds,
    autoAssign: r.auto_assign,
    collectionAccountId: r.collection_account_id,
    version: r.version,
    updatedAt: r.updated_at,
  };
}

export interface ConfigureProgramPayload {
  readonly expectedVersion: number;
  /** Decimal USDT, or null to leave the reserve unset. */
  readonly defaultRequiredReserve?: string | null;
  readonly rewardBps?: number | null;
  readonly offerTtlSeconds?: number;
  readonly holdTtlSeconds?: number;
  readonly autoAssign?: boolean;
  readonly collectionAccountId?: string | null;
  readonly reason: string;
}

const wholeInRange = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a whole number between ${min} and ${max}`, { field });
  }
  return value;
};

/** A reward rate in basis points (0–500), or null for none. */
export function parseRewardBps(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return wholeInRange(value, 'rewardBps', 0, 500);
}

/**
 * `trader_program.configure` — `traders:configure` (⧗). One audited change to the programme; orders already in
 * flight keep the terms they were given (their reward is frozen when they start).
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
    if (p.rewardBps !== undefined) changes.reward_bps = parseRewardBps(p.rewardBps);
    if (p.offerTtlSeconds !== undefined) changes.offer_ttl_seconds = wholeInRange(p.offerTtlSeconds, 'offerTtlSeconds', 30, 900);
    if (p.holdTtlSeconds !== undefined) changes.hold_ttl_seconds = wholeInRange(p.holdTtlSeconds, 'holdTtlSeconds', 60, 900);
    if (p.autoAssign !== undefined) changes.auto_assign = Boolean(p.autoAssign);
    if (p.collectionAccountId !== undefined) {
      if (p.collectionAccountId === null || p.collectionAccountId === '') changes.collection_account_id = null;
      else {
        const accountId = requireUuid(p.collectionAccountId, 'collectionAccountId');
        const account = await ctx.tx.selectFrom('inr_settlement_account').select(['status', 'direction']).where('id', '=', accountId).executeTakeFirst();
        if (!account) throw new DomainError('NOT_FOUND', 'INR account not found');
        if (account.status !== 'ACTIVE' || account.direction === 'PAYOUT') throw new DomainError('ACCOUNT_NOT_ACTIVE', 'traders pay into an ACTIVE account that accepts collections');
        changes.collection_account_id = accountId;
      }
    }
    const after = await ctx.tx
      .updateTable('trader_program')
      .set({ ...changes, updated_by: actorLabel(ctx), updated_at: sql<Date>`statement_timestamp()`, version: before.version + 1 })
      .where('id', '=', 1)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'trader_program.configured', entityType: 'trader_program', entityId: null,
      before: { default_required_reserve_minor: before.default_required_reserve_minor, reward_bps: before.reward_bps, offer_ttl_seconds: before.offer_ttl_seconds, hold_ttl_seconds: before.hold_ttl_seconds, auto_assign: before.auto_assign, collection_account_id: before.collection_account_id, version: before.version },
      after: { default_required_reserve_minor: after.default_required_reserve_minor, reward_bps: after.reward_bps, offer_ttl_seconds: after.offer_ttl_seconds, hold_ttl_seconds: after.hold_ttl_seconds, auto_assign: after.auto_assign, collection_account_id: after.collection_account_id, version: after.version, reason },
    });
    return { version: after.version };
  });
}
