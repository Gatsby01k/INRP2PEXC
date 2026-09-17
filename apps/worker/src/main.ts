import { run } from 'graphile-worker';
import { createDb, createPool } from '@inrp2p/db';
import { CRONTAB, buildTaskList } from './tasks.ts';

const url = process.env.WORKER_DATABASE_URL;
if (!url) {
  console.error('WORKER_DATABASE_URL is required');
  process.exit(1);
}

const pool = createPool({ connectionString: url, applicationName: 'inrp2p-worker', max: 10 });
const db = createDb(pool);

const runner = await run({
  pgPool: pool,
  concurrency: 5,
  noHandleSignals: false,
  pollInterval: 2000,
  taskList: buildTaskList(db, []),
  crontab: CRONTAB,
});
await runner.promise;
