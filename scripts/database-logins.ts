/**
 * The web app's and the worker's own database logins (DEPLOYMENT §5): `inrp2p_app_login`, a member of `inrp2p_app`
 * only, and `inrp2p_worker_login`, a member of `inrp2p_worker` only — never the schema owner, which a production
 * process refuses to run as (`databaseDeploymentProblems`).
 *
 *   DATABASE_MIGRATOR_URL=… node scripts/database-logins.ts plan
 *   DATABASE_MIGRATOR_URL=… node scripts/database-logins.ts prepare --env-file <file> [--prefix P_] [--web-host <pooled host>]
 *   DATABASE_MIGRATOR_URL=… node scripts/database-logins.ts apply   --env-file <file> [--prefix P_] [--web-host <pooled host>]
 *
 * - `plan` writes nothing: which logins exist, what they belong to, and what `apply` would change.
 * - `prepare` writes nothing to the database: it puts a fresh password for each login into the env file, as the
 *   connection strings the processes will use (`<P>DATABASE_URL` for the web app — through the pooled host when one is
 *   given or the database is Neon — and `<P>WORKER_DATABASE_URL` for the worker, direct: it listens for jobs). A
 *   string already in the file is kept.
 * - `apply` creates a missing login, makes each a member of its group, and sets the password the env file holds (it
 *   prepares first when the file has none), then connects as each and runs the release's own deployment check.
 *
 * On PostgreSQL the password reaches the database only as a SCRAM-SHA-256 verifier computed here, so it is never in a
 * statement the server could log. Neon refuses a verifier — its control plane takes role changes, wants the password
 * itself (over TLS) and stores it hashed — so on a Neon host the password is sent as is (found in the rehearsal on a
 * Neon copy, 2026-10-12). It is never printed. The env file is written with mode 0600.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createDb, createPool, databaseDeploymentProblems } from '@inrp2p/db';

export interface Login {
  readonly role: string;
  readonly group: 'inrp2p_app' | 'inrp2p_worker';
  /** The env file key for its connection string, before the prefix. */
  readonly key: 'DATABASE_URL' | 'WORKER_DATABASE_URL';
  /** Through the connection pooler (the web app's short transactions) or direct (the worker listens). */
  readonly pooled: boolean;
}

export const LOGINS: readonly Login[] = [
  { role: 'inrp2p_app_login', group: 'inrp2p_app', key: 'DATABASE_URL', pooled: true },
  { role: 'inrp2p_worker_login', group: 'inrp2p_worker', key: 'WORKER_DATABASE_URL', pooled: false },
];

/** A SCRAM-SHA-256 verifier (RFC 5802/7677, PostgreSQL's stored format) for `password`. */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The pooled host Neon gives an endpoint: `ep-x.region…` → `ep-x-pooler.region…`. */
export function neonPooledHost(host: string): string | null {
  const m = /^(ep-[a-z0-9-]+?)(-pooler)?(\.[^.].*\.neon\.tech)$/.exec(host);
  return m ? `${m[1]}-pooler${m[3]}` : null;
}

/** The connection string for `login` on the database `migratorUrl` points at, with `password`. */
export function loginUrl(migratorUrl: string, login: Login, password: string, webHost?: string): string {
  const u = new URL(migratorUrl);
  u.username = login.role;
  u.password = password;
  if (login.pooled) {
    const pooled = webHost ?? neonPooledHost(u.hostname);
    if (pooled) u.hostname = pooled;
  } else {
    u.hostname = u.hostname.replace(/^(ep-[a-z0-9-]+?)-pooler(\.)/, '$1$2');
  }
  return u.toString();
}

export function readEnvFile(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** Sets `values` in the env file, keeping every other line, and leaves it readable by its owner only. */
export function writeEnvFile(file: string, values: ReadonlyMap<string, string>): void {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const done = new Set<string>();
  const next = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && values.has(m[1]!)) {
      done.add(m[1]!);
      return `${m[1]}=${values.get(m[1]!)}`;
    }
    return line;
  });
  const missing = [...values].filter(([k]) => !done.has(k)).map(([k, v]) => `${k}=${v}`);
  if (missing.length && next.length && next.at(-1) === '') next.pop();
  writeFileSync(file, `${[...next, ...missing].join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export interface LoginState {
  readonly role: string;
  readonly exists: boolean;
  readonly canLogin: boolean;
  /** Attributes a process login must not have. */
  readonly privileged: string[];
  readonly memberOf: string[];
}

export async function loginStates(client: pg.Client, logins: readonly Login[] = LOGINS): Promise<LoginState[]> {
  const out: LoginState[] = [];
  for (const l of logins) {
    const r = (await client.query<{ rolcanlogin: boolean; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean }>(
      'select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname = $1', [l.role])).rows[0];
    const memberOf = (await client.query<{ rolname: string }>(
      'select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles r on r.oid = m.member where r.rolname = $1 order by 1', [l.role])).rows.map((x) => x.rolname);
    out.push({
      role: l.role, exists: Boolean(r), canLogin: r?.rolcanlogin ?? false, memberOf,
      privileged: r ? (['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'] as const).filter((k) => r[k]).map((k) => k.replace(/^rol/, '')) : [],
    });
  }
  return out;
}

/** What is wrong with a login as it stands — beyond what `apply` fixes (existence, membership, password). */
export function loginProblems(state: LoginState, login: Login): string[] {
  const problems: string[] = [];
  if (state.privileged.length) problems.push(`${login.role} has ${state.privileged.join(', ')}: a process login must have none`);
  const extra = state.memberOf.filter((g) => g !== login.group);
  if (extra.length) problems.push(`${login.role} is also a member of ${extra.join(', ')}: it must belong to ${login.group} only`);
  return problems;
}

/** How a password reaches the server: a SCRAM verifier, or — on Neon, which accepts nothing else — the password. */
export type PasswordForm = 'scram' | 'plaintext';
export const passwordFormFor = (url: string): PasswordForm => (/\.neon\.tech$/.test(new URL(url).hostname) ? 'plaintext' : 'scram');

export async function applyLogins(client: pg.Client, passwords: ReadonlyMap<string, string>, logins: readonly Login[] = LOGINS, form: PasswordForm = 'scram'): Promise<string[]> {
  const done: string[] = [];
  for (const l of logins) {
    const password = passwords.get(l.role);
    if (!password) throw new Error(`no password for ${l.role}`);
    const role = client.escapeIdentifier(l.role);
    const exists = (await client.query('select 1 from pg_roles where rolname = $1', [l.role])).rowCount === 1;
    if (!exists) {
      await client.query(`create role ${role} login`);
      done.push(`created ${l.role}`);
    }
    await client.query(`alter role ${role} login password ${client.escapeLiteral(form === 'scram' ? scramVerifier(password) : password)}`);
    done.push(`password set for ${l.role}`);
    const member = (await client.query('select pg_has_role($1, $2, \'MEMBER\') as m', [l.role, l.group])).rows[0]?.m === true;
    if (!member) {
      await client.query(`grant ${client.escapeIdentifier(l.group)} to ${role}`);
      done.push(`${l.role} joined ${l.group}`);
    }
  }
  return done;
}

const passwordIn = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
};

/** Puts a connection string for each login into the env values; one already there is kept. Returns the passwords. */
export function prepareStrings(env: Map<string, string>, migratorUrl: string, prefix: string, webHost?: string, logins: readonly Login[] = LOGINS): Map<string, string> {
  const passwords = new Map<string, string>();
  for (const l of logins) {
    const key = `${prefix}${l.key}`;
    const existing = env.get(key);
    const kept = existing && new URL(existing).username === l.role ? passwordIn(existing) : undefined;
    const password = kept ?? randomBytes(32).toString('base64url');
    passwords.set(l.role, password);
    env.set(key, loginUrl(migratorUrl, l, password, webHost));
  }
  return passwords;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== 'plan' && mode !== 'prepare' && mode !== 'apply') {
    console.error('usage: node scripts/database-logins.ts plan | prepare --env-file <file> [--prefix P_] [--web-host <host>] | apply --env-file <file> [...]');
    process.exit(2);
  }
  const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
  if (!migratorUrl) {
    console.error('DATABASE_MIGRATOR_URL is required (the schema owner)');
    process.exit(2);
  }
  const file = arg('--env-file');
  const prefix = arg('--prefix') ?? '';
  const webHost = arg('--web-host');
  if (mode !== 'plan' && !file) {
    console.error(`${mode} needs --env-file`);
    process.exit(2);
  }
  if (!/^[A-Z0-9_]*$/.test(prefix)) {
    console.error('--prefix takes capital letters, digits and _');
    process.exit(2);
  }

  if (mode === 'prepare') {
    const env = readEnvFile(file!);
    prepareStrings(env, migratorUrl, prefix, webHost);
    writeEnvFile(file!, new Map(LOGINS.map((l) => [`${prefix}${l.key}`, env.get(`${prefix}${l.key}`)!])));
    for (const l of LOGINS) console.log(`${prefix}${l.key}: ${l.role} @ ${new URL(env.get(`${prefix}${l.key}`)!).hostname} (written to the env file)`);
    process.exit(0);
  }

  const client = new pg.Client({ connectionString: migratorUrl, application_name: 'inrp2p-logins' });
  await client.connect();
  let failed = false;
  try {
    const states = await loginStates(client);
    for (const [i, s] of states.entries()) {
      const l = LOGINS[i]!;
      console.log(`${s.role}: ${s.exists ? `exists${s.canLogin ? '' : ' (cannot log in)'}, member of ${s.memberOf.join(', ') || 'nothing'}` : 'missing'}`);
      for (const p of loginProblems(s, l)) {
        console.log(`  !! ${p}`);
        failed = true;
      }
    }
    if (mode === 'plan' || failed) {
      if (failed) console.log('nothing changed: fix the problems above first');
      process.exitCode = failed ? 1 : 0;
    } else {
      const env = readEnvFile(file!);
      const passwords = prepareStrings(env, migratorUrl, prefix, webHost);
      writeEnvFile(file!, new Map(LOGINS.map((l) => [`${prefix}${l.key}`, env.get(`${prefix}${l.key}`)!])));
      await client.query('begin');
      try {
        const form = passwordFormFor(migratorUrl);
        console.log(form === 'scram' ? 'passwords sent as SCRAM verifiers' : 'passwords sent as is, over TLS: Neon accepts no verifier and stores them hashed');
        for (const line of await applyLogins(client, passwords, LOGINS, form)) console.log(line);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
      for (const l of LOGINS) {
        const pool = createPool({ connectionString: env.get(`${prefix}${l.key}`)!, applicationName: 'inrp2p-logins-check', max: 1 });
        try {
          const problems = await databaseDeploymentProblems(createDb(pool));
          console.log(`${prefix}${l.key} (${l.role} @ ${new URL(env.get(`${prefix}${l.key}`)!).hostname}): ${problems.length ? problems.join('; ') : 'connects; the deployment check passes'}`);
        } catch (e) {
          console.log(`${prefix}${l.key} (${l.role}): cannot connect: ${(e as { code?: string }).code ?? (e as Error).message}`);
          failed = true;
        } finally {
          await pool.end();
        }
      }
      process.exitCode = failed ? 1 : 0;
    }
  } finally {
    await client.end();
  }
}
