import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db, Executor } from '@inrp2p/db';
import { appendAuditDirect } from '@inrp2p/audit';

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

/**
 * The restore fence (migration 0034; RUNBOOKS `restore-fence`): a restore must not cause a second payout.
 *
 * A database recovered to an earlier moment, failed over to a replica that was behind, or moved to another cluster has
 * forgotten what happened after that moment — a payout marked sent, a reserve application approved — and the desk would
 * show it as still to pay. The database names the cluster and timeline it is on; each worker heartbeat records it; and
 * when it changes, the two steps that authorise money to leave the exchange are refused until one person has recorded
 * the reconciliation with the bank and the chain and a second has approved it. Recording what already happened —
 * evidence of a payment, a confirmation, a statement, a scan — is never refused: it is what closes an obligation.
 */
export interface DatabaseIdentity {
  readonly cluster: string;
  readonly timeline: number;
}

export const databaseIdentityOf = (value: unknown): DatabaseIdentity | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return typeof v.cluster === 'string' && typeof v.timeline === 'number' ? { cluster: v.cluster, timeline: v.timeline } : null;
};
export const sameDatabase = (a: DatabaseIdentity, b: DatabaseIdentity): boolean => a.cluster === b.cluster && a.timeline === b.timeline;

export interface RestoreFence {
  readonly id: string;
  readonly ref: string;
  readonly reason: string;
  readonly raisedAt: string;
  readonly raisedBy: string;
  readonly knownUntil: string | null;
  readonly identityBefore: DatabaseIdentity | null;
  readonly identityAfter: DatabaseIdentity | null;
}

export interface RestoreFenceState {
  /** Outgoing payments are held now: by a raised fence, or because the database changed and no fence names it yet. */
  readonly held: boolean;
  /** The database is on another cluster or timeline than the last heartbeat, and no worker or person has fenced it yet. */
  readonly unacknowledgedChange: boolean;
  readonly fence: RestoreFence | null;
  /** The reconciliation waiting for a second person. */
  readonly lift: { readonly id: string; readonly reconciliation: string; readonly requestedById: string; readonly requestedBy: string; readonly requestedAt: string } | null;
  readonly lastLifted: { readonly ref: string; readonly liftedAt: string; readonly liftedBy: string } | null;
  /** What could have gone out unrecorded since the records were last known whole: each is checked against the bank and the chain. */
  readonly toReconcile: {
    readonly payoutLegsToSend: number;
    readonly payoutLegsInFlight: number;
    readonly reserveApplicationsApproved: number;
    readonly reserveWithdrawalsRequested: number;
    readonly routeObligationsOpen: number;
    /** The exchange's signer (ADR 0017): transfers planned or waiting, and transactions signed that the chain has not decided. */
    readonly signerSendsOpen: number;
    readonly signerTransactionsLive: number;
  };
}

export async function restoreFenceState(ex: Executor): Promise<RestoreFenceState> {
  const r = await sql<{
    held: boolean; fence_id: string | null; ref: string | null; reason: string | null; raised_at: Date | null; raised_by: string | null; known_until: Date | null;
    identity_before: unknown; identity_after: unknown; lift_id: string | null; reconciliation: string | null; requested_by: string | null; requested_by_label: string | null; requested_at: Date | null;
    last_ref: string | null; last_lifted_at: Date | null; last_lifted_by: string | null;
    legs_to_send: string; legs_in_flight: string; applications: string; withdrawals: string; obligations: string; sends: string; live_attempts: string;
  }>`
    with fence as (select * from restore_fence where status = 'RAISED' limit 1),
         lift as (select l.* from restore_fence_lift l join fence f on f.id = l.fence_id where l.status = 'REQUESTED'),
         lifted as (select f.ref, f.lifted_at, f.lifted_by from restore_fence f where f.status = 'LIFTED' order by f.lifted_at desc limit 1)
    select inrp2p_payouts_held() as held,
           f.id as fence_id, f.ref, f.reason, f.raised_at, coalesce(ru.name, ru.email, case when f.raised_by like 'SYSTEM:%' then 'the system' end) as raised_by,
           f.known_until, f.identity_before, f.identity_after,
           l.id as lift_id, l.reconciliation, l.requested_by::text as requested_by, coalesce(lu.name, lu.email) as requested_by_label, l.requested_at,
           x.ref as last_ref, x.lifted_at as last_lifted_at, coalesce(xu.name, xu.email) as last_lifted_by,
           (select count(*) from settlement_leg where payer = 'EXCHANGE_ACCOUNT' and status = 'PENDING')::text as legs_to_send,
           (select count(*) from settlement_leg where payer = 'EXCHANGE_ACCOUNT' and status = 'PROCESSING')::text as legs_in_flight,
           (select count(*) from trader_reserve_application where kind = 'APPLY' and status = 'APPROVED')::text as applications,
           (select count(*) from trader_reserve_withdrawal where status = 'REQUESTED')::text as withdrawals,
           (select count(*) from route_obligation where status in ('OPEN', 'PARTIALLY_SETTLED'))::text as obligations,
           (select count(*) from chain_send where status not in ('CONFIRMED', 'CANCELLED'))::text as sends,
           (select count(*) from chain_send_attempt where status in ('SIGNED', 'BROADCAST'))::text as live_attempts
      from (select 1) one
      left join fence f on true
      left join auth_user ru on ru.id::text = f.raised_by
      left join lift l on true
      left join auth_user lu on lu.id = l.requested_by
      left join lifted x on true
      left join auth_user xu on xu.id = x.lifted_by`.execute(ex);
  const row = r.rows[0]!;
  const fence: RestoreFence | null = row.fence_id
    ? {
        id: row.fence_id, ref: row.ref!, reason: row.reason!, raisedAt: row.raised_at!.toISOString(), raisedBy: row.raised_by ?? 'an operator',
        knownUntil: row.known_until?.toISOString() ?? null, identityBefore: databaseIdentityOf(row.identity_before), identityAfter: databaseIdentityOf(row.identity_after),
      }
    : null;
  const count = (v: string) => Number.parseInt(v, 10);
  return {
    held: row.held,
    unacknowledgedChange: row.held && !fence,
    fence,
    lift: row.lift_id
      ? { id: row.lift_id, reconciliation: row.reconciliation!, requestedById: row.requested_by!, requestedBy: row.requested_by_label ?? 'an operator', requestedAt: row.requested_at!.toISOString() }
      : null,
    lastLifted: row.last_ref ? { ref: row.last_ref, liftedAt: row.last_lifted_at!.toISOString(), liftedBy: row.last_lifted_by ?? 'an operator' } : null,
    toReconcile: {
      payoutLegsToSend: count(row.legs_to_send), payoutLegsInFlight: count(row.legs_in_flight), reserveApplicationsApproved: count(row.applications),
      reserveWithdrawalsRequested: count(row.withdrawals), routeObligationsOpen: count(row.obligations),
      signerSendsOpen: count(row.sends), signerTransactionsLive: count(row.live_attempts),
    },
  };
}

/** Whether outgoing payments are held now, and under which fence (none yet when no worker has noticed the change). */
export async function payoutsHeld(ex: Executor): Promise<{ held: boolean; ref: string | null }> {
  const r = await sql<{ held: boolean; ref: string | null }>`
    select inrp2p_payouts_held() as held, (select ref from restore_fence where status = 'RAISED' limit 1) as ref`.execute(ex);
  return r.rows[0]!;
}

/** Refuses a step that authorises money to leave the exchange while payments are held, saying why and what is still allowed. */
export async function assertPayoutsOpen(ex: Executor): Promise<void> {
  const row = await payoutsHeld(ex);
  if (row.held) {
    throw new DomainError(
      'PAYOUTS_HELD',
      `Outgoing payments are held${row.ref ? ` (${row.ref})` : ''}: the database changed underneath — recovered, failed over or moved — and every payment out since the records were last known whole must be checked against the bank and the chain first. Recording a payment that was already made is still allowed.`,
    );
  }
}

/**
 * Raises the fence and pauses new business with it — the worker when it sees the database change, a person by hand
 * (the restore procedure's first step where the platform hides the database's identity). Returns null when a fence is
 * already raised: one fence covers every change until it is lifted. The caller records the audit event.
 */
export async function holdOutgoingPayments(
  ex: Executor,
  input: { by: string; reason: string; identityBefore?: DatabaseIdentity | null; knownUntil?: Date | null },
): Promise<{ id: string; ref: string; pausedNewBusiness: boolean } | null> {
  const open = await ex.selectFrom('restore_fence').select('id').where('status', '=', 'RAISED').executeTakeFirst();
  if (open) return null;
  // The fence names the identity it was raised on, so once it is lifted the same change is not held again.
  const fence = await sql<{ id: string; ref: string }>`
    insert into restore_fence (reason, raised_by, identity_before, identity_after, known_until)
    values (${input.reason}, ${input.by}, ${input.identityBefore ? JSON.stringify(input.identityBefore) : null}::jsonb, inrp2p_database_identity(), ${input.knownUntil ?? null})
    returning id, ref`.execute(ex);
  const row = fence.rows[0]!;
  const business = await newBusinessState(ex);
  if (!business.paused) {
    await ex.insertInto('trading_control').values({ new_business: 'PAUSED', reason: `${row.ref}: ${input.reason}`.slice(0, 500), set_by: input.by }).execute();
  }
  return { id: row.id, ref: row.ref, pausedNewBusiness: !business.paused };
}

export interface WorkerBeat {
  readonly workerId: string;
  readonly startedAt: Date;
  readonly release: string | null;
  readonly config: Readonly<Record<string, string>>;
}

/**
 * One worker heartbeat (migration 0033), and the check that makes the restore fence automatic: the database's cluster and
 * timeline now, against the last ones a heartbeat recorded. A change nobody has fenced raises the fence — with the last
 * heartbeat before it as the moment the records are known whole — in the same transaction that records the new identity.
 * Serialised across workers, so two workers starting on a recovered database raise one fence.
 */
export async function recordWorkerBeat(db: Db, beat: WorkerBeat): Promise<{ raised: string | null }> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('inrp2p.restore_fence'))`.execute(tx);
    const r = await sql<{ current: unknown; recorded: unknown; recorded_at: Date | null; fenced: boolean }>`
      with latest as (select db_identity, beat_at from worker_heartbeat where db_identity is not null order by beat_at desc limit 1)
      select inrp2p_database_identity() as current, l.db_identity as recorded, l.beat_at as recorded_at,
             exists (select 1 from restore_fence f where f.identity_after = inrp2p_database_identity()) as fenced
        from (select 1) one left join latest l on true`.execute(tx);
    const row = r.rows[0]!;
    const current = databaseIdentityOf(row.current);
    const recorded = databaseIdentityOf(row.recorded);
    let raised: string | null = null;
    if (current && recorded && !sameDatabase(current, recorded) && !row.fenced) {
      const reason = current.cluster === recorded.cluster
        ? `The database moved from timeline ${recorded.timeline} to ${current.timeline}: it was recovered to an earlier moment or failed over.`
        : 'The database is another cluster than the one the workers last wrote to: it was restored, upgraded or moved.';
      const fence = await holdOutgoingPayments(tx, { by: 'SYSTEM:worker_heartbeat', reason, identityBefore: recorded, knownUntil: row.recorded_at });
      if (fence) {
        raised = fence.ref;
        await appendAuditDirect(tx, {
          actorType: 'SYSTEM', actorId: null, surface: 'SYSTEM', action: 'operations.restore_fence_raised', entityType: 'restore_fence', entityId: fence.id,
          after: { ref: fence.ref, reason, identity_before: recorded, identity_after: current, known_until: row.recorded_at?.toISOString() ?? null, paused_new_business: fence.pausedNewBusiness, worker: beat.workerId },
          correlationId: randomUUID(),
        });
      }
    }
    await sql`
      insert into worker_heartbeat (worker_id, started_at, beat_at, release, config, db_identity)
      values (${beat.workerId}, ${beat.startedAt}, inrp2p_now(), ${beat.release}, ${JSON.stringify(beat.config)}::jsonb, ${current ? JSON.stringify(current) : null}::jsonb)
      on conflict (worker_id) do update
        set started_at = excluded.started_at, beat_at = excluded.beat_at, release = excluded.release, config = excluded.config, db_identity = excluded.db_identity`.execute(tx);
    return { raised };
  });
}
