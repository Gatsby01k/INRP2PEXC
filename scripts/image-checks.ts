/**
 * The release images, started the way production starts them (production tasks E3, E4) — on the reference layout,
 * with Docker, on a Linux runner in CI.
 *
 * What it proves about `inrp2p-{web,worker,migrate}:<tag>`:
 *   - `migrate` applies every migration as the non-superuser migrator, and a second run changes nothing;
 *   - with `INRP2P_ENV=production` and only a database URL, web and worker refuse to start and name what is missing —
 *     names only, never a value;
 *   - with a complete configuration — random placeholder secrets generated here, provider hosts on `.invalid`
 *     (nothing at start-up contacts a provider), and an S3 store over TLS with an Object Lock bucket — the worker
 *     starts, checks the bucket and records its heartbeat with the release and the database's identity; the web app
 *     answers live and ready on all three hosts, refuses the status without the monitoring token, on the wrong host
 *     or with a wrong token, and serves status and metrics with it;
 *   - on SIGTERM the worker drains and exits 0.
 *
 * Nothing it generates is a real credential. `--env-out` writes the web app's complete configuration for the
 * recovery drill (`scripts/pitr-drill.ts --web-env`), which then starts the same image against a recovered database.
 *
 * Usage: node scripts/image-checks.ts --tag <tag> [--env-out <file>] [--keep]
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { amzDateOf, signSigV4 } from '@inrp2p/adapters';
import { MINIO_IMAGE } from '../test/minio.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const tag = arg('--tag');
if (!tag) {
  console.error('usage: node scripts/image-checks.ts --tag <tag> [--env-out <file>] [--keep]');
  process.exit(2);
}
const envOut = arg('--env-out');
const keep = process.argv.includes('--keep');
const run = `imgchk-${Date.now().toString(36)}`;
const NET = run;
const PG = `${run}-pg`;
const MINIO = `${run}-minio`;
const secret = () => randomBytes(24).toString('base64url');
const pw = { postgres: secret(), migrator: secret(), app: secret(), worker: secret(), readonly: secret(), minio: secret() };
const MINIO_USER = `imgchk${randomBytes(4).toString('hex')}`;
const ROLES = fileURLToPath(new URL('../deploy/reference/postgres/01-roles.sh', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'inrp2p-image-checks-'));

const results: { check: string; ok: boolean; detail?: string }[] = [];
const expectThat = (check: string, ok: boolean, detail?: string) => {
  results.push({ check, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? ` — ${detail}` : ''}`);
};

function docker(args: string[], opts: { allowFail?: boolean } = {}): { status: number; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${out.trim().slice(0, 600)}`);
  return { status: r.status ?? -1, out };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hostPort = (container: string, port: number) => docker(['port', container, `${port}/tcp`]).out.split('\n')[0]!.trim().split(':').pop()!;
const psql = (sqlText: string) => docker(['exec', PG, 'psql', '-U', 'postgres', '-d', 'inrp2p', '-tAc', sqlText]).out.trim();

async function until(what: string, ok: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await ok()) return true;
    await sleep(1000);
  }
  console.log(`(timed out waiting for ${what})`);
  return false;
}

/** A signed S3 request over TLS to the local store, trusting only its own certificate. */
function s3(method: string, port: string, pathName: string, headers: Record<string, string>, ca: string): Promise<number> {
  const url = new URL(`https://127.0.0.1:${port}${pathName}`);
  const body = new Uint8Array(0);
  const signed = signSigV4({
    method, url, body, region: 'us-east-1', service: 's3', credentials: { accessKeyId: MINIO_USER, secretAccessKey: pw.minio }, amzDate: amzDateOf(new Date()),
    headers: { ...headers, 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') },
  });
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: signed, ca }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const status = async (port: string, p: string, headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-forwarded-proto': 'https', ...headers }, redirect: 'manual' }).then(async (r) => ({ code: r.status, body: await r.text() }), () => ({ code: 0, body: '' }));

try {
  docker(['network', 'create', NET]);
  docker(['run', '-d', '--name', PG, '--network', NET,
    '-e', `POSTGRES_PASSWORD=${pw.postgres}`, '-e', `INRP2P_MIGRATOR_PASSWORD=${pw.migrator}`, '-e', `INRP2P_APP_PASSWORD=${pw.app}`,
    '-e', `INRP2P_WORKER_PASSWORD=${pw.worker}`, '-e', `INRP2P_READONLY_PASSWORD=${pw.readonly}`,
    '-v', `${ROLES}:/docker-entrypoint-initdb.d/01-roles.sh:ro`, 'postgres:18.6']);
  await until('postgres', () => docker(['exec', PG, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { allowFail: true }).status === 0, 120_000);
  const db = (user: string, password: string) => `postgres://${user}:${encodeURIComponent(password)}@${PG}:5432/inrp2p`;

  // migrate, as the reference migrator — twice.
  const m1 = docker(['run', '--rm', '--network', NET, '-e', `DATABASE_MIGRATOR_URL=${db('inrp2p_migrator', pw.migrator)}`, `inrp2p-migrate:${tag}`], { allowFail: true });
  expectThat('migrate applies every migration as the non-superuser migrator', m1.status === 0 && /applied \d+ migration\(s\)/.test(m1.out) && /queue schema and privileges installed/.test(m1.out), m1.out.match(/applied \d+ migration\(s\)|schema up to date/)?.[0]);
  const m2 = docker(['run', '--rm', '--network', NET, '-e', `DATABASE_MIGRATOR_URL=${db('inrp2p_migrator', pw.migrator)}`, `inrp2p-migrate:${tag}`], { allowFail: true });
  expectThat('migrate run again changes nothing', m2.status === 0 && /schema up to date/.test(m2.out));
  expectThat('the schema is the release\'s', psql('select inrp2p_schema_version()') !== '', `version ${psql('select inrp2p_schema_version()')}`);

  // An S3 store over TLS (a certificate made here) and the audit-seal bucket under Object Lock.
  const certs = path.join(dir, 'certs');
  spawnSync('mkdir', ['-p', certs]);
  const ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${MINIO}`,
    '-addext', `subjectAltName=DNS:${MINIO},DNS:localhost,IP:127.0.0.1`, '-keyout', path.join(certs, 'private.key'), '-out', path.join(certs, 'public.crt')], { encoding: 'utf8' });
  if (ssl.status !== 0) throw new Error(`openssl failed: ${ssl.stderr}`);
  spawnSync('chmod', ['644', path.join(certs, 'private.key'), path.join(certs, 'public.crt')]);
  const ca = readFileSync(path.join(certs, 'public.crt'), 'utf8');
  docker(['run', '-d', '--name', MINIO, '--network', NET, '-p', '127.0.0.1::9000', '-e', `MINIO_ROOT_USER=${MINIO_USER}`, '-e', `MINIO_ROOT_PASSWORD=${pw.minio}`,
    '-v', `${certs}:/certs:ro`, MINIO_IMAGE, 'server', '--certs-dir', '/certs', '/data']);
  const minioPort = hostPort(MINIO, 9000);
  await until('the object store', async () => (await s3('GET', minioPort, '/minio/health/live', {}, ca).catch(() => 0)) === 200, 60_000);
  expectThat('the audit-seal bucket is created with Object Lock', (await s3('PUT', minioPort, '/inrp2p-audit-seals', { 'x-amz-bucket-object-lock-enabled': 'true' }, ca)) === 200);

  // Complete configurations, every secret random and generated here.
  const hmac = randomBytes(32).toString('base64');
  const common = [
    'INRP2P_ENV=production', 'INRP2P_KEK_PROVIDER=aws-kms', 'INRP2P_KEK_ID=kek-image-checks',
    'INRP2P_KMS_KEY_ARN=arn:aws:kms:ap-south-1:000000000000:key/00000000-0000-4000-8000-000000000000', `INRP2P_FIELD_HMAC_BASE64=${hmac}`,
    `RESEND_API_KEY=re_placeholder_${secret()}`, 'RESEND_FROM=INRP2P <desk@inrp2p.example>',
    'INRP2P_TRON_PRIMARY_URL=https://tron-primary.invalid', 'INRP2P_TRON_PRIMARY_GROUP=primary',
    'INRP2P_TRON_SECONDARY_URL=https://tron-secondary.invalid', 'INRP2P_TRON_SECONDARY_GROUP=secondary',
    'INRP2P_USDT_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  ];
  const token = secret();
  const webEnv = [...common, 'DESK_HOST=desk.inrp2p.example', 'APP_HOST=app.inrp2p.example', 'PUBLIC_HOST=inrp2p.example',
    `OPERATOR_AUTH_SECRET=${secret()}`, `CLIENT_AUTH_SECRET=${secret()}`, `INRP2P_HEALTH_TOKEN=${token}`, 'INRP2P_CUSTODY_PROVIDER=reference-placeholder'];
  const webEnvFile = path.join(dir, 'web.env');
  writeFileSync(webEnvFile, `${webEnv.join('\n')}\n`);
  if (envOut) writeFileSync(envOut, `${webEnv.join('\n')}\n`);
  const workerEnvFile = path.join(dir, 'worker.env');
  writeFileSync(workerEnvFile, `${[...common, 'CLIENT_BASE_URL=https://app.inrp2p.example', 'INRP2P_AUDIT_SEAL_BUCKET=inrp2p-audit-seals', 'INRP2P_AUDIT_SEAL_RETENTION_DAYS=3650',
    `INRP2P_OBJECT_STORE_ENDPOINT=https://${MINIO}:9000`, 'INRP2P_OBJECT_STORE_REGION=us-east-1', `AWS_ACCESS_KEY_ID=${MINIO_USER}`, `AWS_SECRET_ACCESS_KEY=${pw.minio}`,
    'NODE_EXTRA_CA_CERTS=/certs/public.crt', 'INRP2P_WORKER_ID=image-checks-worker'].join('\n')}\n`);

  // Production with only a database URL: both refuse, naming settings, never values.
  for (const [role, image, urlVar, user, password, mustName] of [
    ['web', `inrp2p-web:${tag}`, 'DATABASE_URL', 'inrp2p_app_login', pw.app, ['RESEND_API_KEY', 'DESK_HOST', 'OPERATOR_AUTH_SECRET', 'INRP2P_HEALTH_TOKEN']],
    ['worker', `inrp2p-worker:${tag}`, 'WORKER_DATABASE_URL', 'inrp2p_worker_login', pw.worker, ['RESEND_API_KEY', 'CLIENT_BASE_URL', 'INRP2P_AUDIT_SEAL_BUCKET']],
  ] as const) {
    const name = `${run}-${role}-incomplete`;
    docker(['run', '-d', '--name', name, '--network', NET, '-e', 'INRP2P_ENV=production', '-e', `${urlVar}=${db(user, password)}`, image]);
    await until(`${role} to exit`, () => docker(['inspect', '-f', '{{.State.Running}}', name]).out.trim() === 'false', 90_000);
    const exit = docker(['inspect', '-f', '{{.State.ExitCode}}', name]).out.trim();
    const logs = docker(['logs', name], { allowFail: true }).out;
    const names = mustName.filter((n) => logs.includes(n));
    expectThat(`${role} refuses to start in production with only a database URL`, exit !== '0' && logs.includes('refusing to start') && names.length === mustName.length && !logs.includes(password),
      `exit ${exit}; named ${names.join(', ')}`);
    docker(['rm', '-f', name], { allowFail: true });
  }

  // The worker, complete: starts, checks the bucket, records its heartbeat with the release and the database identity.
  const WORKER = `${run}-worker`;
  docker(['run', '-d', '--name', WORKER, '--network', NET, '--env-file', workerEnvFile, '-v', `${certs}:/certs:ro`,
    '-e', `WORKER_DATABASE_URL=${db('inrp2p_worker_login', pw.worker)}`, `inrp2p-worker:${tag}`]);
  const beat = await until('the worker heartbeat', () => psql("select count(*) from worker_heartbeat where worker_id = 'image-checks-worker'") === '1', 90_000);
  const heartbeat = beat ? psql("select release || ' ' || (config->>'auditSeals') || ' ' || (db_identity is not null) from worker_heartbeat where worker_id = 'image-checks-worker'") : '';
  const workerLogs = docker(['logs', WORKER], { allowFail: true }).out;
  expectThat('the worker starts on a complete production configuration and records its heartbeat',
    beat && heartbeat === `${tag} exported true` && workerLogs.includes('object lock on') && docker(['inspect', '-f', '{{.State.Running}}', WORKER]).out.trim() === 'true', heartbeat);

  // The web app, complete: live and ready on every host; status and metrics only with the token, on the desk host.
  const WEB = `${run}-web`;
  docker(['run', '-d', '--name', WEB, '--network', NET, '-p', '127.0.0.1::3000', '--env-file', webEnvFile, '-e', `DATABASE_URL=${db('inrp2p_app_login', pw.app)}`, `inrp2p-web:${tag}`]);
  const webPort = hostPort(WEB, 3000);
  await until('the web app', async () => (await status(webPort, '/api/health/live', { host: 'desk.inrp2p.example' })).code === 200, 120_000);
  const hosts = ['desk.inrp2p.example', 'app.inrp2p.example', 'inrp2p.example'];
  for (const probe of ['/api/health/live', '/api/health/ready']) {
    const codes = await Promise.all(hosts.map(async (h) => (await status(webPort, probe, { host: h })).code));
    expectThat(`${probe} answers 200 on all three hosts`, codes.every((c) => c === 200), codes.join(' '));
  }
  const noToken = await status(webPort, '/api/health/status', { host: 'desk.inrp2p.example' });
  const wrongToken = await status(webPort, '/api/health/status', { host: 'desk.inrp2p.example', 'x-inrp2p-health-token': `${token}x` });
  const otherHost = await status(webPort, '/api/health/status', { host: 'app.inrp2p.example', 'x-inrp2p-health-token': token });
  expectThat('status is refused without the token, with a wrong one, and on another host', [noToken.code, wrongToken.code, otherHost.code].every((c) => c === 401), `${noToken.code} ${wrongToken.code} ${otherHost.code}`);
  const withToken = await status(webPort, '/api/health/status', { host: 'desk.inrp2p.example', 'x-inrp2p-health-token': token });
  // 503 while any money or infrastructure signal is in alarm — on a new database, no restore drill has been recorded.
  expectThat('status is served with the token on the desk host', (withToken.code === 200 || withToken.code === 503) && withToken.body.includes('"checks"'), `HTTP ${withToken.code}`);
  const metrics = await status(webPort, '/api/health/metrics', { host: 'desk.inrp2p.example', 'x-inrp2p-health-token': token });
  expectThat('metrics are served with the token', metrics.code === 200 && /^inrp2p_ready \d$/m.test(metrics.body) && /^inrp2p_payouts_held 0$/m.test(metrics.body), `HTTP ${metrics.code}`);
  const webLogs = docker(['logs', WEB], { allowFail: true }).out;
  expectThat('no secret value appears in the logs', ![pw.app, pw.worker, pw.minio, token, hmac].some((v) => webLogs.includes(v) || workerLogs.includes(v)));

  // SIGTERM: the worker takes no new job, lets running ones finish, closes its pool and exits 0.
  docker(['stop', '-t', '60', WORKER]);
  const exit = docker(['inspect', '-f', '{{.State.ExitCode}}', WORKER]).out.trim();
  const stopped = docker(['logs', WORKER], { allowFail: true }).out;
  expectThat('the worker drains on SIGTERM and exits 0', exit === '0' && stopped.includes('graceful shutdown'), `exit ${exit}`);
} catch (e) {
  expectThat('the checks completed', false, (e as Error).message);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ tag, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  if (failed.length > 0 || results.length === 0) process.exitCode = 1;
  if (!keep) {
    for (const c of ['web', 'worker'].map((r) => `${run}-${r}`).concat([MINIO, PG])) docker(['rm', '-f', c], { allowFail: true });
    docker(['network', 'rm', NET], { allowFail: true });
  }
}
