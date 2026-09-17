import { run } from 'graphile-worker';
import { createDb, createPool } from '@inrp2p/db';
import { UnconfiguredNotificationAdapter } from '@inrp2p/adapters';
import { acceptanceCodeHandler } from '@inrp2p/quotes';
import { CRONTAB, buildTaskList, quoteExpiryScheduler } from './tasks.ts';
import { UNCONFIGURED_PROTECTOR, fieldProtectorFromEnv } from './config.ts';

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

const runner = await run({
  pgPool: pool,
  concurrency: 5,
  noHandleSignals: false,
  pollInterval: 2000,
  taskList: buildTaskList(db, [quoteExpiryScheduler(db), acceptanceCodeHandler(db, { protector }, notifications)]),
  crontab: CRONTAB,
});
await runner.promise;
