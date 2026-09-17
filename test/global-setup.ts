import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createPool } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { installQueue } from '@inrp2p/outbox';

/** PostgreSQL version required by D-06. CI runs this exact image via Testcontainers. */
export const REQUIRED_PG_IMAGE = 'postgres:18.6';
export const TEMPLATE_DB = 'inrp2p_template';
export const LOGIN_PASSWORD = 'inrp2p-test-only';

import type {} from '@inrp2p/db/testing';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<void>) | undefined;

  if (!adminUrl) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer(REQUIRED_PG_IMAGE).withDatabase('postgres').withUsername('postgres').withPassword('postgres').start();
    adminUrl = container.getConnectionUri();
    stop = async () => {
      await container.stop();
    };
  }

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const version = (await admin.query<{ server_version: string }>('show server_version')).rows[0]!.server_version;
  await admin.query(`drop database if exists ${TEMPLATE_DB} with (force)`);
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();

  const templateUrl = withDatabase(adminUrl, TEMPLATE_DB);
  const pool = createPool({ connectionString: templateUrl, applicationName: 'inrp2p-test-template' });
  try {
    await migrate(pool);
    await installQueue(pool);
    // Enables the inrp2p.clock_override session setting for integration tests only (migration 0012).
    await pool.query('create table inrp2p_test_clock_permit (enabled boolean primary key default true)');
    // Login users for role-based tests (cluster-level objects).
    await pool.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'inrp2p_app_login') then
          create role inrp2p_app_login login password '${LOGIN_PASSWORD}' in role inrp2p_app;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'inrp2p_worker_login') then
          create role inrp2p_worker_login login password '${LOGIN_PASSWORD}' in role inrp2p_worker;
        end if;
      end $$;`);
  } finally {
    await pool.end();
  }

  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgTemplate', TEMPLATE_DB);
  project.provide('pgServerVersion', version);

  return async () => {
    await stop?.();
  };
}
