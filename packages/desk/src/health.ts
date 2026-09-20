import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';

/**
 * What to watch, what is wrong when it moves, and where to look it up (launch checklist: monitoring + alerts).
 *
 * The list is the alert definitions. Each check names the one number a monitoring system should graph, the two
 * thresholds that separate "fine" from "look at this" from "wake someone", and the runbook that says what to do
 * — because an alert that fires at 3am without a runbook is an alert that gets silenced at 3.05.
 *
 * Every `runbook` id here must exist as a heading anchor in `docs/RUNBOOKS.md`; a unit test holds the two
 * together, so an alert cannot be added without somewhere to send the person it wakes.
 *
 * The thresholds are deliberately conservative and deliberately in code. A threshold in a dashboard is a
 * threshold nobody reviews in a pull request.
 */
export type HealthState = 'ok' | 'warn' | 'alarm';

export interface HealthCheckDefinition {
  readonly id: string;
  /** What the number means, in the words an operator would use. */
  readonly title: string;
  /** Above `warn` is worth looking at; above `alarm` is worth waking someone. */
  readonly warn: number;
  readonly alarm: number;
  readonly unit: 'count' | 'seconds' | 'inr';
  /** Heading anchor in `docs/RUNBOOKS.md`. */
  readonly runbook: string;
  readonly why: string;
}

export const HEALTH_CHECKS: readonly HealthCheckDefinition[] = Object.freeze([
  {
    id: 'ledger_imbalance',
    title: 'Ledger rows that do not net to zero',
    warn: 0,
    alarm: 0,
    unit: 'count',
    runbook: 'ledger-imbalance',
    why: 'The ledger nets to zero by construction (FI-40, FI-44). Anything above zero means a write got through that should have been impossible, and every figure derived from the ledger is suspect until it is explained.',
  },
  {
    id: 'scanner_lag_seconds',
    title: 'Seconds since the TRON scanner last ran',
    warn: 300,
    alarm: 900,
    unit: 'seconds',
    runbook: 'stuck-usdt-confirmation',
    why: 'A scanner that has stopped does not fail loudly — it simply stops finding deposits, and every SELL trade waits. This is the difference between quiet and broken.',
  },
  {
    id: 'outbox_failed',
    title: 'Outbox events that have exhausted their retries',
    warn: 1,
    alarm: 10,
    unit: 'count',
    runbook: 'outbox-backlog',
    why: 'Every notification, receipt and acceptance code is delivered through the outbox. A permanently failed event is something a client was promised and did not get.',
  },
  {
    id: 'outbox_oldest_pending_seconds',
    title: 'Age of the oldest undelivered outbox event',
    warn: 300,
    alarm: 1800,
    unit: 'seconds',
    runbook: 'outbox-backlog',
    why: 'Depth alone says little; age says the worker has stopped or is losing ground.',
  },
  {
    id: 'audit_seal_age_seconds',
    title: 'Seconds since the audit trail was last sealed',
    warn: 5400,
    alarm: 10800,
    unit: 'seconds',
    runbook: 'audit-seal-stale',
    why: 'The hourly seal is what makes the audit trail evidence rather than a log (SECURITY §8). Unsealed hours are hours nobody can prove were not edited.',
  },
  {
    id: 'blocking_exceptions',
    title: 'Open blocking exception cases',
    warn: 3,
    alarm: 10,
    unit: 'count',
    runbook: 'blocking-exceptions',
    why: 'Each one is a trade on hold, which means a client waiting for money with the desk unable to move it.',
  },
  {
    id: 'overdue_route_obligations',
    title: 'Route obligations past their settlement window',
    warn: 1,
    alarm: 5,
    unit: 'count',
    runbook: 'route-settlement-overdue',
    why: 'The client was paid; the route has not settled with us. This is the desk’s own money sitting with a counterparty.',
  },
  {
    id: 'inr_capacity_available',
    title: 'INR capacity left across active settlement accounts today',
    warn: 2_000_000,
    alarm: 500_000,
    unit: 'inr',
    runbook: 'capacity-emergency',
    why: 'Capacity is the desk’s promise about what it can pay today. This is the one check where a **low** number is the problem.',
  },
  {
    id: 'deposit_pool_free',
    title: 'Deposit addresses available to assign',
    warn: 10,
    alarm: 3,
    unit: 'count',
    runbook: 'deposit-pool-low',
    why: 'A SELL trade cannot be accepted without an address of its own (D-02). An empty pool stops the desk taking work.',
  },
]);

export interface HealthCheck extends HealthCheckDefinition {
  readonly value: number;
  readonly state: HealthState;
}

export interface SystemHealth {
  readonly state: HealthState;
  readonly checkedAt: string;
  readonly checks: readonly HealthCheck[];
}

/** A low number is the problem for capacity and for the address pool; for everything else a high one is. */
const LOWER_IS_WORSE = new Set(['inr_capacity_available', 'deposit_pool_free']);

export function stateOf(definition: HealthCheckDefinition, value: number): HealthState {
  if (LOWER_IS_WORSE.has(definition.id)) {
    if (value <= definition.alarm) return 'alarm';
    return value <= definition.warn ? 'warn' : 'ok';
  }
  if (value > definition.alarm) return 'alarm';
  return value > definition.warn ? 'warn' : 'ok';
}

const worst = (states: readonly HealthState[]): HealthState =>
  states.includes('alarm') ? 'alarm' : states.includes('warn') ? 'warn' : 'ok';

/**
 * Reads every signal in one round trip.
 *
 * One query rather than nine because health is a snapshot: nine queries taken over a second describe a system
 * that never existed, and the first thing anyone does with a health page is refresh it.
 */
export async function systemHealth(ex: Executor): Promise<SystemHealth> {
  const r = await sql<{
    ledger_imbalance: string;
    scanner_lag_seconds: string;
    outbox_failed: string;
    outbox_oldest_pending_seconds: string;
    audit_seal_age_seconds: string;
    blocking_exceptions: string;
    overdue_route_obligations: string;
    inr_capacity_available: string;
    deposit_pool_free: string;
    checked_at: Date;
  }>`
    select
      (select count(*) from ledger_global_imbalance)::text as ledger_imbalance,
      coalesce((select extract(epoch from (statement_timestamp() - max(last_run_at)))::bigint
                from chain_cursor), 0)::text as scanner_lag_seconds,
      (select count(*) from outbox_event where failed_at is not null and dispatched_at is null)::text as outbox_failed,
      coalesce((select extract(epoch from (statement_timestamp() - min(created_at)))::bigint
                from outbox_event where dispatched_at is null and failed_at is null), 0)::text as outbox_oldest_pending_seconds,
      coalesce((select extract(epoch from (statement_timestamp() - max(sealed_at)))::bigint
                from audit_seal), 0)::text as audit_seal_age_seconds,
      (select count(*) from exception_case where status in ('OPEN', 'IN_PROGRESS') and severity = 'BLOCKING')::text as blocking_exceptions,
      (select count(*) from route_obligation o
        where o.status not in ('SETTLED', 'CANCELLED')
          and o.opened_at < statement_timestamp() - make_interval(hours => 24))::text as overdue_route_obligations,
      -- Whole rupees, divided in SQL on the bigint: no money is ever converted to a JavaScript number, and
      -- integer division rounds *down*, so this check understates what is available rather than overstating it.
      coalesce((select sum(greatest(coalesce(d.capacity_minor, a.default_daily_capacity_minor) - coalesce(d.used_minor, 0) - coalesce(d.reserved_minor, 0), 0)) / 100
                from inr_settlement_account a
                left join inr_account_day d on d.account_id = a.id
                     and d.day = (inrp2p_now() at time zone 'Asia/Kolkata')::date
                where a.status = 'ACTIVE'), 0)::text as inr_capacity_available,
      (select count(*) from deposit_address
        where status = 'AVAILABLE')::text as deposit_pool_free,
      statement_timestamp() as checked_at`.execute(ex);

  const row = r.rows[0]!;
  // Every figure arrives as an integer string and stays an integer: counts, seconds, and whole rupees that
  // PostgreSQL already divided. Nothing here is money in the arithmetic sense — these are signals to compare
  // against a threshold, and the one that started as money never passes through a float to get here.
  const int = (value: string): number => Number.parseInt(value, 10);
  const values: Record<string, number> = {
    ledger_imbalance: int(row.ledger_imbalance),
    scanner_lag_seconds: int(row.scanner_lag_seconds),
    outbox_failed: int(row.outbox_failed),
    outbox_oldest_pending_seconds: int(row.outbox_oldest_pending_seconds),
    audit_seal_age_seconds: int(row.audit_seal_age_seconds),
    blocking_exceptions: int(row.blocking_exceptions),
    overdue_route_obligations: int(row.overdue_route_obligations),
    inr_capacity_available: int(row.inr_capacity_available),
    deposit_pool_free: int(row.deposit_pool_free),
  };

  const checks = HEALTH_CHECKS.map((definition) => {
    const value = values[definition.id] ?? 0;
    return { ...definition, value, state: stateOf(definition, value) };
  });
  return { state: worst(checks.map((c) => c.state)), checkedAt: row.checked_at.toISOString(), checks };
}
