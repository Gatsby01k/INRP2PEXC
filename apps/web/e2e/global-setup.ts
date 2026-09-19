import { deskBaseUrl, startDesk } from '../harness/desk-server.ts';
import { CLIENT_AUTH_SECRET, OPERATOR_AUTH_SECRET, seedE2E } from './world.ts';

/**
 * Builds the world, then starts the desk against it. The database is created from the migrations every time, so
 * an end-to-end run can never pass against a schema that drifted from `packages/db/migrations`.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const port = Number.parseInt(process.env.E2E_PORT ?? '3210', 10);
  const state = await seedE2E(adminUrl);
  console.log(`e2e: seeded ${state.databaseUrl} (client ${state.clientName}, operator ${state.owner.email})`);
  const stop = await startDesk({ port, databaseUrl: state.databaseUrl, operatorAuthSecret: OPERATOR_AUTH_SECRET, clientAuthSecret: CLIENT_AUTH_SECRET, label: 'desk' });
  console.log(`e2e: desk listening on ${deskBaseUrl(port)}`);
  return stop;
}
