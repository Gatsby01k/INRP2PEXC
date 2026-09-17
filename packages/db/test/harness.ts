import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createPool, type Int8Mode } from '../src/pool.ts';
import { createDb, type Db } from '../src/kysely.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
    pgServerVersion: string;
  }
}

export interface TestDatabase {
  readonly name: string;
  /** Owner/migrator connection (bypasses grants, not triggers). */
  readonly ownerPool: pg.Pool;
  readonly owner: Db;
  /** Connection as a login member of inrp2p_app — what the application uses. */
  readonly appPool: pg.Pool;
  readonly app: Db;
  /** Worker role connection. */
  readonly workerPool: pg.Pool;
  readonly worker: Db;
  /** App role connection with int8 parsed as number, for Better Auth. */
  readonly authPool: pg.Pool;
  readonly auth: Db;
  close(): Promise<void>;
}

function url(base: string, db: string, user?: { name: string; password: string }): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/** Creates an isolated database cloned from the migrated template. */
export async function createTestDatabase(label = 'test'): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const template = inject('pgTemplate');
  const name = `t_${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name} template ${template}`);
  await admin.end();

  const password = 'inrp2p-test-only';
  const mk = (applicationName: string, user?: string, int8: Int8Mode = 'bigint') =>
    createPool({ connectionString: url(adminUrl, name, user ? { name: user, password } : undefined), applicationName, int8, max: 5 });

  const ownerPool = mk('owner');
  const appPool = mk('app', 'inrp2p_app_login');
  const workerPool = mk('worker', 'inrp2p_worker_login');
  const authPool = mk('auth', 'inrp2p_app_login', 'number');
  const owner = createDb(ownerPool);
  const app = createDb(appPool);
  const worker = createDb(workerPool);
  const auth = createDb(authPool);

  return {
    name, ownerPool, owner, appPool, app, workerPool, worker, authPool, auth,
    async close() {
      await Promise.allSettled([owner.destroy(), app.destroy(), worker.destroy(), auth.destroy()]);
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}
