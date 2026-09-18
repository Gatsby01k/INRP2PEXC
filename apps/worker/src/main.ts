import { run } from 'graphile-worker';
import { createDb, createPool } from '@inrp2p/db';
import { UnconfiguredNotificationAdapter } from '@inrp2p/adapters';
import { acceptanceCodeHandler } from '@inrp2p/quotes';
import { CRONTAB, buildTaskList, quoteExpiryScheduler } from './tasks.ts';
import { UNCONFIGURED_PROTECTOR, chainMonitoringFromEnv, chainMonitoringReady, describeChainMonitoring, fieldProtectorFromEnv } from './config.ts';

const url = process.env.WORKER_DATABASE_URL;
if (!url) {
  console.error('WORKER_DATABASE_URL is required');
  process.exit(1);
}

const pool = createPool({ connectionString: url, applicationName: 'inrp2p-worker', max: 10 });
const db = createDb(pool);

// No email provider and no KMS-backed keys are configured in V1 (TD-03, launch checklist): acceptance-code
// deliveries fail loudly and stay visible as failed outbox deliveries rather than silently disappearing.
const protector = fieldProtectorFromEnv() ?? UNCONFIGURED_PROTECTOR;
const notifications = new UnconfiguredNotificationAdapter();

// Chain monitoring state is always stated (DISABLED / READY / DEGRADED / UNCONFIGURED). An enabled but
// unconfigured worker refuses to start rather than run with three jobs that would fail every minute while the
// rest of the worker looks healthy (D-05, TD-05).
const monitoring = chainMonitoringFromEnv();
console.log(describeChainMonitoring(monitoring));
if (!chainMonitoringReady(monitoring)) {
  console.error('refusing to start: chain monitoring is enabled but not configured. Set the TRON settings, or set INRP2P_TRON_MONITORING=disabled deliberately.');
  process.exit(1);
}
if (monitoring.state === 'DEGRADED') console.warn('chain monitoring is DEGRADED: large USDT transfers cannot be confirmed until a second independent provider is configured (D-05)');

const runner = await run({
  pgPool: pool,
  concurrency: 5,
  noHandleSignals: false,
  pollInterval: 2000,
  taskList: buildTaskList(db, [quoteExpiryScheduler(db), acceptanceCodeHandler(db, { protector }, notifications)], {
    monitoring,
    ...(monitoring.config ? { scanner: monitoring.config } : {}),
  }),
  crontab: CRONTAB,
});
await runner.promise;
