/** Deployment migration entry: explicit SQL migrations, then graphile-worker schema + queue privileges. */
import { createPool } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { installQueue } from '@inrp2p/outbox';

const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) {
  console.error('DATABASE_MIGRATOR_URL is required');
  process.exit(1);
}
const pool = createPool({ connectionString: url, applicationName: 'inrp2p-migrate' });
try {
  const applied = await migrate(pool, { log: console.log });
  console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema up to date');
  await installQueue(pool);
  console.log('queue schema and privileges installed');
} finally {
  await pool.end();
}
