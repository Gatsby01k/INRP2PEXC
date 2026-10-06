import { sql } from 'kysely';
import type { Executor } from './kysely.ts';

/**
 * The schema this code was built for: the number of the last migration file. A unit test keeps it equal to the
 * highest file in `migrations/`, so a release and its migrations cannot drift apart unnoticed.
 */
export const SCHEMA_VERSION = 33;

/**
 * What a production process checks about the database it was given before it serves or works (production task E3).
 * Names of facts only, never a connection string or a credential:
 *
 * - it is not a superuser, and not the schema owner (`inrp2p_is_application_session()`, migration 0027) — the
 *   application runs with its own grants, never with the migrator's;
 * - the schema is exactly the version this release was built for — older means migrations were not run, newer means an
 *   older release is pointed at a migrated database;
 * - the test clock permit table does not exist — it is what lets a test move the business clock (migration 0012).
 */
export async function databaseDeploymentProblems(ex: Executor): Promise<string[]> {
  const problems: string[] = [];
  const r = await sql<{ superuser: boolean; application: boolean; version: number | null; test_clock: boolean }>`
    select (select rolsuper from pg_roles where rolname = current_user) as superuser,
           inrp2p_is_application_session() as application,
           inrp2p_schema_version() as version,
           to_regclass('public.inrp2p_test_clock_permit') is not null as test_clock`.execute(ex);
  const row = r.rows[0]!;
  if (row.superuser) problems.push('the database login is a superuser; use the application login');
  if (!row.application) problems.push('the database login owns the schema (the migrator); use the application login');
  if (row.version !== SCHEMA_VERSION) {
    problems.push(row.version === null || row.version < SCHEMA_VERSION
      ? `the database is at migration ${row.version ?? 'none'}, this release needs ${SCHEMA_VERSION}: run the migrations first`
      : `the database is at migration ${row.version}, newer than this release (${SCHEMA_VERSION}): deploy the matching release`);
  }
  if (row.test_clock) problems.push('the test clock permit exists in this database; it must never exist outside tests');
  return problems;
}
