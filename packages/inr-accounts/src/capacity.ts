import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireUuid } from '@inrp2p/kernel';
import { type Executor, type ReservationReleaseReason, type Tx, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Business day = Asia/Kolkata calendar day, from the **business clock** (ARCHITECTURE §4 "Time").
 *
 * `inrp2p_now()` is exactly `statement_timestamp()` in a deployed database, so this is the same day production
 * has always booked capacity to. The difference is in a database whose clock is pinned: the day capacity is
 * booked to, the day the INR screen prints and the day every trade reference carries are now one day rather
 * than two, which is what a fixture is for. Reading the wall clock here while the rest of the system read the
 * business clock made the INR page's baseline valid only on the day it was recorded.
 */
export async function istToday(ex: Executor): Promise<string> {
  const r = await sql<{ day: string }>`select to_char((inrp2p_now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day`.execute(ex);
  return r.rows[0]!.day;
}

async function resolveDay(tx: Tx, day: string | undefined, opts: { allowPast: boolean }): Promise<string> {
  const today = await istToday(tx);
  if (day === undefined) return today;
  if (!DAY_RE.test(day)) throw new DomainError('INVALID_ARGUMENT', 'day must be YYYY-MM-DD');
  if (!opts.allowPast && day < today) throw new DomainError('INVALID_ARGUMENT', `day ${day} is before the current IST day ${today}`);
  return day;
}

export interface AccountDayRow {
  account_id: string;
  day: string;
  capacity_minor: bigint;
  used_minor: bigint;
  reserved_minor: bigint;
  pending_payout_minor: bigint;
}

/**
 * Creates the day row lazily from the account default and locks it `FOR UPDATE` — the FI-30 concurrency
 * anchor. Every reserve / consume / release / capacity change goes through this lock.
 */
export async function lockAccountDay(tx: Tx, accountId: string, day: string): Promise<AccountDayRow> {
  assertLockOrder(tx, 'inr_account_day');
  await sql`
    insert into inr_account_day (account_id, day, capacity_minor)
    select a.id, ${day}::date, a.default_daily_capacity_minor from inr_settlement_account a where a.id = ${accountId}
    on conflict (account_id, day) do nothing`.execute(tx);
  const row = await tx
    .selectFrom('inr_account_day')
    .select(['account_id', 'day', 'capacity_minor', 'used_minor', 'reserved_minor', 'pending_payout_minor'])
    .where('account_id', '=', accountId)
    .where('day', '=', day)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'INR account not found');
  return row;
}

export const remainingOf = (d: Pick<AccountDayRow, 'capacity_minor' | 'used_minor' | 'reserved_minor'>): bigint => d.capacity_minor - d.used_minor - d.reserved_minor;

export type ReservationSubject = { readonly purpose: 'CLIENT_PAYOUT'; readonly tradeId: string } | { readonly purpose: 'ROUTE_SETTLEMENT'; readonly routeSettlementId: string };

export interface ReserveInput {
  readonly accountId: string;
  readonly amount: Money<'INR'>;
  readonly subject: ReservationSubject;
  /** IST day; defaults to today. Past days are rejected. */
  readonly day?: string;
}

/**
 * Reserves outgoing INR capacity (FI-30, FI-32). Called inside settlement / route-settlement commands (Phases 4)
 * and by `capacity.reserve`. Everything is checked under the day-row lock; the database trigger re-checks.
 */
export async function reserveCapacity(ctx: TxContext, input: ReserveInput): Promise<{ reservationId: string; day: string; remainingAfter: Money<'INR'> }> {
  const accountId = requireUuid(input.accountId, 'accountId');
  if (input.amount.currency !== 'INR' || !input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'reservation amount must be positive INR');
  const day = await resolveDay(ctx.tx, input.day, { allowPast: false });
  const d = await lockAccountDay(ctx.tx, accountId, day);
  const account = await ctx.tx.selectFrom('inr_settlement_account').select(['status', 'direction', 'label']).where('id', '=', accountId).forShare().executeTakeFirstOrThrow();
  if (account.status !== 'ACTIVE') throw new DomainError('ACCOUNT_NOT_ACTIVE', `INR account ${account.label} is ${account.status}`);
  if (account.direction === 'COLLECTION') throw new DomainError('INVALID_ARGUMENT', `INR account ${account.label} is collection-only`);
  const remaining = remainingOf(d);
  if (input.amount.minor > remaining) {
    throw new DomainError('CAPACITY_INSUFFICIENT', `remaining capacity ${Money.ofMinor(remaining < 0n ? 0n : remaining, 'INR').toDecimalString()} INR`, {
      remaining: remaining.toString(), requested: input.amount.minor.toString(),
    });
  }
  await ctx.tx
    .updateTable('inr_account_day')
    .set({ reserved_minor: d.reserved_minor + input.amount.minor, updated_at: sql<Date>`statement_timestamp()` })
    .where('account_id', '=', accountId)
    .where('day', '=', day)
    .execute();
  const res = await ctx.tx
    .insertInto('capacity_reservation')
    .values({
      purpose: input.subject.purpose,
      trade_id: input.subject.purpose === 'CLIENT_PAYOUT' ? requireUuid(input.subject.tradeId, 'tradeId') : null,
      route_settlement_id: input.subject.purpose === 'ROUTE_SETTLEMENT' ? requireUuid(input.subject.routeSettlementId, 'routeSettlementId') : null,
      account_id: accountId,
      day,
      amount_minor: input.amount.minor,
      created_by: actorLabel(ctx),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const remainingAfter = Money.ofMinor(remaining - input.amount.minor, 'INR');
  await appendAudit(ctx, { action: 'capacity.reserved', entityType: 'capacity_reservation', entityId: res.id, after: { account_id: accountId, day, amount: input.amount, subject: input.subject, remaining_after: remainingAfter } });
  return { reservationId: res.id, day, remainingAfter };
}

export interface ReserveCapacityPayload {
  readonly accountId: string;
  /** Decimal INR. */
  readonly amount: string;
  readonly subject: ReservationSubject;
  readonly day?: string;
}

/** `capacity.reserve` — `settlement:reserve_capacity`. Financial: requires an idempotency key (FI-50). */
export function reserveCapacityCommand(actor: OperatorActor) {
  return operatorCommand(actor, 'settlement:reserve_capacity', async (ctx, p: ReserveCapacityPayload) => {
    if (!ctx.idempotencyKey) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'capacity.reserve is a financial mutation');
    const r = await reserveCapacity(ctx, { accountId: p.accountId, amount: Money.parse(p.amount, 'INR'), subject: p.subject, ...(p.day !== undefined ? { day: p.day } : {}) });
    return { reservationId: r.reservationId, day: r.day, remainingAfter: r.remainingAfter.toDecimalString() };
  });
}

async function locateReservation(tx: Tx, reservationId: string) {
  const loc = await tx.selectFrom('capacity_reservation').select(['account_id', 'day']).where('id', '=', requireUuid(reservationId, 'reservationId')).executeTakeFirst();
  if (!loc) throw new DomainError('NOT_FOUND', 'capacity reservation not found');
  const day = await lockAccountDay(tx, loc.account_id, loc.day);
  const res = await tx.selectFrom('capacity_reservation').selectAll().where('id', '=', reservationId).forUpdate().executeTakeFirstOrThrow();
  return { day, res };
}

/**
 * Consumes part or all of a reservation when a payout is sent (STATE_MACHINES §4 PENDING → PROCESSING):
 * reserved −= amount, used += amount. The reservation becomes CONSUMED when fully used.
 */
export async function consumeReservation(ctx: TxContext, reservationId: string, amount: Money<'INR'>): Promise<{ status: 'ACTIVE' | 'CONSUMED' }> {
  if (amount.currency !== 'INR' || !amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'consumed amount must be positive INR');
  const { day, res } = await locateReservation(ctx.tx, reservationId);
  if (res.status !== 'ACTIVE') throw new DomainError('RESERVATION_NOT_ACTIVE', `reservation is ${res.status}`);
  const consumed = res.consumed_minor + amount.minor;
  if (consumed > res.amount_minor) throw new DomainError('CAPACITY_INSUFFICIENT', 'cannot consume more than reserved');
  const full = consumed === res.amount_minor;
  await ctx.tx
    .updateTable('inr_account_day')
    .set({ reserved_minor: day.reserved_minor - amount.minor, used_minor: day.used_minor + amount.minor, updated_at: sql<Date>`statement_timestamp()` })
    .where('account_id', '=', res.account_id)
    .where('day', '=', res.day)
    .execute();
  await ctx.tx
    .updateTable('capacity_reservation')
    .set({ consumed_minor: consumed, ...(full ? { status: 'CONSUMED' as const, closed_at: sql<Date>`statement_timestamp()` } : {}) })
    .where('id', '=', res.id)
    .execute();
  await appendAudit(ctx, { action: 'capacity.consumed', entityType: 'capacity_reservation', entityId: res.id, after: { amount, consumed_total: Money.ofMinor(consumed, 'INR'), status: full ? 'CONSUMED' : 'ACTIVE' } });
  return { status: full ? 'CONSUMED' : 'ACTIVE' };
}

/**
 * Releases the unconsumed remainder exactly once (FI-31). State-idempotent: releasing an already RELEASED
 * reservation is a no-op; a fully CONSUMED reservation cannot be released.
 */
export async function releaseReservation(ctx: TxContext, reservationId: string, reason: ReservationReleaseReason): Promise<{ released: boolean; releasedAmount: Money<'INR'> }> {
  requireOneOf(reason, 'reason', ['TRADE_CANCELLED', 'LEG_CANCELLED', 'LEG_FAILED', 'TRADE_COMPLETED', 'ROUTE_SETTLEMENT_FAILED', 'DAY_ROLLOVER', 'OPERATOR'] as const);
  const { day, res } = await locateReservation(ctx.tx, reservationId);
  if (res.status === 'RELEASED') return { released: false, releasedAmount: Money.zero('INR') };
  if (res.status !== 'ACTIVE') throw new DomainError('RESERVATION_NOT_ACTIVE', `reservation is ${res.status}`);
  const remainder = res.amount_minor - res.consumed_minor;
  await ctx.tx
    .updateTable('inr_account_day')
    .set({ reserved_minor: day.reserved_minor - remainder, updated_at: sql<Date>`statement_timestamp()` })
    .where('account_id', '=', res.account_id)
    .where('day', '=', res.day)
    .execute();
  await ctx.tx
    .updateTable('capacity_reservation')
    .set({ status: 'RELEASED', released_minor: remainder, released_reason: reason, closed_at: sql<Date>`statement_timestamp()` })
    .where('id', '=', res.id)
    .execute();
  const releasedAmount = Money.ofMinor(remainder, 'INR');
  await appendAudit(ctx, { action: 'capacity.released', entityType: 'capacity_reservation', entityId: res.id, after: { released: releasedAmount, reason } });
  return { released: true, releasedAmount };
}

/**
 * Returns capacity that was consumed for a payout that never left the bank (leg FAILED, STATE_MACHINES §4:
 * `used −= amount`). The reservation stays CONSUMED — it did its job — and the day regains the headroom.
 */
export async function refundConsumedCapacity(ctx: TxContext, input: { reservationId: string; amount: Money<'INR'>; reason: 'LEG_FAILED' | 'OPERATOR' }): Promise<{ refunded: Money<'INR'> }> {
  if (input.amount.currency !== 'INR' || !input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'refunded capacity must be positive INR');
  const reason = requireOneOf(input.reason, 'reason', ['LEG_FAILED', 'OPERATOR'] as const);
  const { day, res } = await locateReservation(ctx.tx, input.reservationId);
  if (res.consumed_minor < input.amount.minor) throw new DomainError('INVALID_AMOUNT', 'cannot refund more capacity than was consumed');
  if (day.used_minor < input.amount.minor) throw new DomainError('INVALID_AMOUNT', 'day usage is lower than the refund');
  await ctx.tx
    .updateTable('inr_account_day')
    .set({ used_minor: day.used_minor - input.amount.minor, updated_at: sql<Date>`statement_timestamp()` })
    .where('account_id', '=', res.account_id)
    .where('day', '=', res.day)
    .execute();
  await appendAudit(ctx, { action: 'capacity.released', entityType: 'capacity_reservation', entityId: res.id, after: { refunded: input.amount, reason, note: 'payout did not leave the account' } });
  return { refunded: input.amount };
}

/**
 * `capacity.set_day` / `capacity.set_default` — `capacity:change` (⧗). Lowering below current commitments is
 * allowed and never cancels anything: remaining becomes negative, new reservations are blocked, and an
 * outbox event lets the exception module open ROUTE_CAPACITY_CHANGED (FI-30).
 */
export function setDayCapacity(actor: OperatorActor) {
  return operatorCommand(actor, 'capacity:change', async (ctx, p: { accountId: string; capacity: string; day?: string; reason: string }) => {
    const capacity = Money.parse(p.capacity, 'INR');
    if (capacity.isNegative()) throw new DomainError('INVALID_AMOUNT', 'capacity must not be negative');
    const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim().slice(0, 500) : null;
    if (!reason) throw new DomainError('INVALID_ARGUMENT', 'reason is required');
    const accountId = requireUuid(p.accountId, 'accountId');
    const day = await resolveDay(ctx.tx, p.day, { allowPast: false });
    const d = await lockAccountDay(ctx.tx, accountId, day);
    await ctx.tx.updateTable('inr_account_day').set({ capacity_minor: capacity.minor, updated_at: sql<Date>`statement_timestamp()` }).where('account_id', '=', accountId).where('day', '=', day).execute();
    const remaining = remainingOf({ ...d, capacity_minor: capacity.minor });
    await appendAudit(ctx, { action: 'capacity.changed', entityType: 'inr_account_day', entityId: `${accountId}:${day}`, before: { capacity: Money.ofMinor(d.capacity_minor, 'INR') }, after: { capacity, remaining: Money.ofMinor(remaining, 'INR'), reason } });
    if (remaining < 0n) {
      await enqueueOutbox(ctx, { type: 'capacity.over_committed', aggregateType: 'inr_settlement_account', aggregateId: accountId, payload: { accountId, day, capacityMinor: capacity.minor.toString(), committedMinor: (d.used_minor + d.reserved_minor).toString() } });
    }
    return { day, remaining: Money.ofMinor(remaining, 'INR').toDecimalString(), overCommitted: remaining < 0n };
  });
}

export function setDefaultDailyCapacity(actor: OperatorActor) {
  return operatorCommand(actor, 'capacity:change', async (ctx, p: { accountId: string; capacity: string; reason: string }) => {
    const capacity = Money.parse(p.capacity, 'INR');
    if (capacity.isNegative()) throw new DomainError('INVALID_AMOUNT', 'capacity must not be negative');
    if (typeof p.reason !== 'string' || !p.reason.trim()) throw new DomainError('INVALID_ARGUMENT', 'reason is required');
    const before = await ctx.tx.selectFrom('inr_settlement_account').select(['id', 'default_daily_capacity_minor', 'version']).where('id', '=', requireUuid(p.accountId, 'accountId')).forUpdate().executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', 'INR account not found');
    await ctx.tx.updateTable('inr_settlement_account').set({ default_daily_capacity_minor: capacity.minor, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'capacity.default_changed', entityType: 'inr_settlement_account', entityId: before.id, before: { default_daily_capacity: Money.ofMinor(before.default_daily_capacity_minor, 'INR') }, after: { default_daily_capacity: capacity, reason: p.reason.trim().slice(0, 500), applies_to: 'days not yet opened' } });
    return { changed: true };
  });
}

/**
 * Day rollover (STATE_MACHINES §6): ACTIVE reservations of past IST days are released, so yesterday's capacity
 * never silently appears as today's. Re-reserving for today is an explicit operator action. Retry-safe.
 */
export async function releasePastDayReservations(ctx: TxContext, limit = 200): Promise<number> {
  const today = await istToday(ctx.tx);
  const stale = await ctx.tx
    .selectFrom('capacity_reservation')
    .select(['id', 'account_id', 'day'])
    .where('status', '=', 'ACTIVE')
    .where('day', '<', today)
    .orderBy('account_id')
    .orderBy('day')
    .orderBy('id')
    .limit(limit)
    .execute();
  let released = 0;
  // Group by day row so each row is locked once, in a deterministic order.
  const groups = new Map<string, string[]>();
  for (const r of stale) groups.set(`${r.account_id}|${r.day}`, [...(groups.get(`${r.account_id}|${r.day}`) ?? []), r.id]);
  for (const ids of groups.values()) {
    for (const id of ids) {
      const r = await releaseReservation(ctx, id, 'DAY_ROLLOVER');
      if (r.released) released++;
    }
  }
  return released;
}

export interface AccountDayView {
  readonly accountId: string;
  readonly day: string;
  readonly capacity: Money<'INR'>;
  readonly used: Money<'INR'>;
  readonly reserved: Money<'INR'>;
  readonly remaining: Money<'INR'>;
}

/** Read model: capacity for a day without creating the row (falls back to the account default). */
export async function getAccountDay(ex: Executor, accountId: string, day?: string): Promise<AccountDayView> {
  const d = day ?? (await istToday(ex));
  const account = await ex.selectFrom('inr_settlement_account').select(['id', 'default_daily_capacity_minor']).where('id', '=', requireUuid(accountId, 'accountId')).executeTakeFirst();
  if (!account) throw new DomainError('NOT_FOUND', 'INR account not found');
  const row = await ex.selectFrom('inr_account_day').select(['capacity_minor', 'used_minor', 'reserved_minor']).where('account_id', '=', accountId).where('day', '=', d).executeTakeFirst();
  const cap = row?.capacity_minor ?? account.default_daily_capacity_minor;
  const used = row?.used_minor ?? 0n;
  const reserved = row?.reserved_minor ?? 0n;
  return { accountId, day: d, capacity: Money.ofMinor(cap, 'INR'), used: Money.ofMinor(used, 'INR'), reserved: Money.ofMinor(reserved, 'INR'), remaining: Money.ofMinor(cap - used - reserved, 'INR') };
}
