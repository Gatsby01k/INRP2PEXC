import { hostname } from 'node:os';
import { run } from 'graphile-worker';
import { createDb, createPool, databaseDeploymentProblems } from '@inrp2p/db';
import { isNotificationProviderConfigured, isProduction, notificationAdapterFromEnv, productionConfigReport, telegramFromEnv } from '@inrp2p/adapters';
import { acknowledgedSignalHandler, clientNotificationEmailHandler, clientNotificationHandler, teamInviteEmailHandler, telegramOrderHandler, traderNotificationHandler } from '@inrp2p/notifications';
import { traderRoutingHandler } from '@inrp2p/traders';
import { acceptanceCodeHandler } from '@inrp2p/quotes';
import { receiptHandler } from '@inrp2p/reporting';
import { destinationArchivedHandler } from '@inrp2p/settlement';
import { CRONTAB, buildTaskList, onchainWakeup, quoteExpiryScheduler, recordHeartbeat } from './tasks.ts';
import { TronSendNetwork } from '@inrp2p/adapters';
import { signerFromEnv } from '@inrp2p/adapters/signer';
import type { OnchainDeps } from '@inrp2p/onchain';
import { UNCONFIGURED_PROTECTOR, auditArchiveFromEnv, chainMonitoringFromEnv, chainMonitoringReady, describeChainMonitoring, fieldProtectorFromEnv, receiptStorageFromEnv } from './config.ts';

// E3: in production the worker starts only on a complete production configuration — names of what is missing are
// printed, never a value — and only against the database it was built for, through its own login.
const report = productionConfigReport('worker', process.env);
for (const w of report.warnings) console.warn(`warning: ${w}`);
if (report.problems.length > 0) {
  console.error(`refusing to start: the production configuration is incomplete:\n- ${report.problems.join('\n- ')}`);
  process.exit(1);
}

const url = process.env.WORKER_DATABASE_URL;
if (!url) {
  console.error('WORKER_DATABASE_URL is required');
  process.exit(1);
}

const pool = createPool({ connectionString: url, applicationName: 'inrp2p-worker', max: Number.parseInt(process.env.INRP2P_WORKER_POOL_SIZE ?? '10', 10) || 10 });
const db = createDb(pool);
if (isProduction(process.env)) {
  const problems = await databaseDeploymentProblems(db);
  if (problems.length > 0) {
    console.error(`refusing to start: ${problems.join('; ')}`);
    await pool.end();
    process.exit(1);
  }
}

// Keys and email come from the environment (TD-03, TD-04). Where either is missing, acceptance-code deliveries fail
// loudly and stay visible as failed outbox deliveries rather than silently disappearing.
const protector = fieldProtectorFromEnv() ?? UNCONFIGURED_PROTECTOR;
const notifications = notificationAdapterFromEnv(process.env);
console.log(`email: ${notifications.provider}`);

/**
 * The client's email channel is registered only when there is a provider to send with.
 *
 * An acceptance code that cannot be delivered must fail loudly — the person is waiting for it. A notification
 * email is different: the in-app inbox is the channel of record and it is already written, so a handler that
 * throws on every send would take a working channel down with an unconfigured one (TD-04).
 */
const emailChannel = isNotificationProviderConfigured(notifications)
  ? [clientNotificationEmailHandler(db, notifications, { linkBase: process.env.CLIENT_BASE_URL })]
  : [];
if (emailChannel.length === 0) console.warn('client notifications: in-app only — no email provider is configured (TD-04)');

// ADR 0020 §2.14: Telegram alerts for desks and traders, only with a bot configured (nobody can link a chat without one).
const telegram = telegramFromEnv(process.env);
const telegramChannel = telegram ? [telegramOrderHandler(db, telegram, { linkBase: process.env.CLIENT_BASE_URL })] : [];
console.log(`telegram: ${telegram ? `@${telegram.botUsername}` : 'not configured'}`);

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

// Receipts are written to the private bucket when one is configured (TD-12); production checks it is versioned.
const receipts = receiptStorageFromEnv(process.env);
if (receipts) {
  const bucket = await receipts.store.describeBucket();
  console.log(`receipts: stored in ${receipts.store.bucket} (versioning ${bucket.versioning}, object lock ${bucket.objectLock ? 'on' : 'off'}, retention ${receipts.retainDays ?? 'not set'} days, pdf ${receipts.pdf ? 'printed' : 'not printed'})`);
  if (bucket.versioning !== 'Enabled') {
    console.error('refusing to start: the receipts bucket must have versioning enabled');
    process.exit(1);
  }
} else {
  console.log('receipts: not stored — proved by hash and regenerated (TD-12)');
}

// TD-17: the audit seals go to a bucket that must be versioned and under Object Lock.
const auditArchive = auditArchiveFromEnv(process.env);
if (auditArchive) {
  const bucket = await auditArchive.archive.describeBucket();
  console.log(`audit seals: exported daily to ${auditArchive.archive.bucket} (object lock ${bucket.objectLock ? 'on' : 'off'}, retention ${auditArchive.retainDays} days)`);
  if (bucket.versioning !== 'Enabled' || !bucket.objectLock) {
    console.error('refusing to start: the audit seal bucket must have versioning and Object Lock enabled');
    process.exit(1);
  }
} else {
  console.warn('audit seals: not exported — every copy of the seal chain is in this database (TD-17)');
}

// ADR 0017: the exchange's own signer. Its seed is opened from the sealed value with the custody key; it must be the
// seed of the HD account the database recorded — a worker with another seed would sign for addresses nobody issued,
// so it refuses to start. Without a seed nothing is signed and every send waits, visibly.
const signer = await signerFromEnv(process.env);
let rails: OnchainDeps | undefined;
{
  const account = await db.selectFrom('custody_hd_account').selectAll().executeTakeFirst();
  if (signer && account && (signer.accountXpub !== account.account_xpub || signer.feeWalletAddress !== account.fee_wallet_address)) {
    console.error('refusing to start: the custody seed is not the seed of the HD account the database recorded (custody_hd_account)');
    signer.close();
    await pool.end();
    process.exit(1);
  }
  if (account && !signer) console.warn('custody signer: not configured — deposit addresses are issued, but nothing is signed: USDT payouts wait (INRP2P_CUSTODY_SEED_SEALED)');
  if (signer && !account) console.warn('custody signer: a seed is configured but no HD account is recorded yet (custody.record_hd_account); it signs nothing until then');
  if (monitoring.config) {
    rails = { network: new TronSendNetwork(monitoring.config.gateways), signer: signer && account ? signer : null, chain: monitoring.config.chain };
    console.log(`custody signer: ${signer && account ? `signing for ${account.provider} (budget wallet ${account.fee_wallet_address})` : 'not signing'}`);
  }
}

// The heartbeat names this worker and what it runs (states and provider names only), so readiness can tell a stopped
// worker from a quiet one.
const identity = {
  workerId: (process.env.INRP2P_WORKER_ID ?? `${hostname()}:${process.pid}`).slice(0, 100),
  startedAt: new Date(),
  release: (process.env.INRP2P_RELEASE ?? '').slice(0, 100) || null,
  config: {
    chain: monitoring.state,
    email: notifications.provider,
    fieldProtection: protector === UNCONFIGURED_PROTECTOR ? 'unconfigured' : 'configured',
    receipts: receipts ? `stored${receipts.pdf ? ' with pdf' : ''}` : 'regenerated',
    auditSeals: auditArchive ? 'exported' : 'not exported',
    custodySigner: rails?.signer ? 'signing' : 'not signing',
  },
};
// The first beat also checks that the database is the one the workers last wrote to: if it was recovered, failed over
// or moved, outgoing payments are held until two people have reconciled them (RUNBOOKS `restore-fence`).
const first = await recordHeartbeat(db, identity);
if (first.raised) console.error(`the database changed underneath: outgoing payments are held (${first.raised}); follow RUNBOOKS restore-fence`);

const runner = await run({
  // Graphile owns its pool and keeps int8 job IDs as strings. The domain pool above
  // deliberately parses financial BIGINT columns as bigint, which is not JSON-serializable.
  connectionString: url,
  concurrency: 5,
  noHandleSignals: false,
  pollInterval: 2000,
  taskList: buildTaskList(db, [quoteExpiryScheduler(db), acceptanceCodeHandler(db, { protector }, notifications), teamInviteEmailHandler(db, notifications, { linkBase: process.env.CLIENT_BASE_URL }), clientNotificationHandler(db), traderNotificationHandler(db), traderRoutingHandler(db), receiptHandler(db, receipts), destinationArchivedHandler(db), acknowledgedSignalHandler(), onchainWakeup(db), ...emailChannel, ...telegramChannel], {
    monitoring,
    ...(monitoring.config ? { scanner: monitoring.config } : {}),
    ...(receipts ? { receipts } : {}),
    heartbeat: identity,
    ...(auditArchive ? { auditArchive } : {}),
    ...(rails ? { rails } : {}),
    ...(telegram ? { telegram: { adapter: telegram, linkBase: process.env.CLIENT_BASE_URL } } : {}),
  }),
  crontab: CRONTAB,
});
// SIGTERM/SIGINT: graphile-worker stops taking jobs and lets the running ones finish; then the pool is closed, so a
// deploy never cuts a job in half and never leaves connections behind.
try {
  await runner.promise;
} finally {
  await pool.end();
}
