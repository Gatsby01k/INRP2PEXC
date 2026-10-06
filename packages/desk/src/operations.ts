import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';
import { type NewBusinessState, type RestoreFenceState, newBusinessState, restoreFenceState } from '@inrp2p/trades';
import { type SystemHealth, systemHealth } from './health.ts';

/** One worker, as its heartbeat says (migration 0033): names and states only. */
export interface WorkerReport {
  readonly workerId: string;
  readonly startedAt: string;
  readonly beatAt: string;
  readonly ageSeconds: number;
  readonly release: string | null;
  readonly config: Readonly<Record<string, string>>;
}

/**
 * The operator's picture (production tasks E3, E4): every signal, whether new business is open, whether outgoing payments
 * are held after a database change, and the workers.
 */
export interface OperationsStatus extends SystemHealth {
  readonly newBusiness: NewBusinessState;
  readonly restoreFence: RestoreFenceState;
  readonly workers: readonly WorkerReport[];
}

export async function operationsStatus(ex: Executor): Promise<OperationsStatus> {
  const health = await systemHealth(ex);
  const workers = await sql<{ worker_id: string; started_at: Date; beat_at: Date; age: string; release: string | null; config: Record<string, string> }>`
    select worker_id, started_at, beat_at, extract(epoch from (inrp2p_now() - beat_at))::bigint::text as age, release, config
      from worker_heartbeat order by beat_at desc limit 20`.execute(ex);
  return {
    ...health,
    newBusiness: await newBusinessState(ex),
    restoreFence: await restoreFenceState(ex),
    workers: workers.rows.map((w) => ({
      workerId: w.worker_id, startedAt: w.started_at.toISOString(), beatAt: w.beat_at.toISOString(), ageSeconds: Number.parseInt(w.age, 10), release: w.release, config: w.config,
    })),
  };
}

const PROM_STATE: Record<SystemHealth['state'], number> = { ok: 0, warn: 1, alarm: 2 };

/**
 * The same picture in the Prometheus text format, for a monitoring system to scrape and alert on (thresholds stay in
 * code; the scraper alerts on `inrp2p_health_state >= 2`). Signal ids, groups and numbers only.
 */
export function prometheusText(status: OperationsStatus): string {
  const lines: string[] = [
    '# HELP inrp2p_health_value The value of each health signal.',
    '# TYPE inrp2p_health_value gauge',
    ...status.checks.map((c) => `inrp2p_health_value{check="${c.id}",group="${c.group}",runbook="${c.runbook}"} ${c.value}`),
    '# HELP inrp2p_health_state Each signal against its thresholds: 0 ok, 1 warn, 2 alarm.',
    '# TYPE inrp2p_health_state gauge',
    ...status.checks.map((c) => `inrp2p_health_state{check="${c.id}",group="${c.group}",runbook="${c.runbook}"} ${PROM_STATE[c.state]}`),
    '# HELP inrp2p_ready Money and infrastructure together: 0 ok, 1 warn, 2 alarm. Liquidity is reported apart.',
    '# TYPE inrp2p_ready gauge',
    `inrp2p_ready ${PROM_STATE[status.state]}`,
    '# HELP inrp2p_liquidity Whether traders can take orders now: 0 ok, 1 none on a side.',
    '# TYPE inrp2p_liquidity gauge',
    `inrp2p_liquidity ${PROM_STATE[status.liquidity]}`,
    '# HELP inrp2p_new_business_paused 1 while new business is paused.',
    '# TYPE inrp2p_new_business_paused gauge',
    `inrp2p_new_business_paused ${status.newBusiness.paused ? 1 : 0}`,
    '# HELP inrp2p_payouts_held 1 while outgoing payments are held after a database change (RUNBOOKS restore-fence).',
    '# TYPE inrp2p_payouts_held gauge',
    `inrp2p_payouts_held ${status.restoreFence.held ? 1 : 0}`,
  ];
  return `${lines.join('\n')}\n`;
}
