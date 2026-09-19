import { deskBaseUrl, startDesk } from '../harness/desk-server.ts';
import { signInAndSave } from './auth.ts';
import { UPDATE_REQUESTED, guard } from './environment.ts';
import { CLIENT_AUTH_SECRET, OPERATOR_AUTH_SECRET, seedVisual } from './world.ts';

/**
 * Refuses to run outside the canonical environment, then builds the fixture world and starts the built desk
 * against it — in that order, so the app never connects to a database that is about to be dropped.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const env = await guard();
  if (env && UPDATE_REQUESTED) process.env.VISUAL_ENV_JSON = JSON.stringify(env);

  const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const port = Number.parseInt(process.env.VISUAL_PORT ?? '3220', 10);
  const state = await seedVisual(adminUrl);
  console.log(`visual: seeded ${state.databaseUrl}`);
  const stop = await startDesk({
    port,
    databaseUrl: state.databaseUrl,
    operatorAuthSecret: OPERATOR_AUTH_SECRET,
    clientAuthSecret: CLIENT_AUTH_SECRET,
    label: 'desk:visual',
  });
  console.log(`visual: desk listening on ${deskBaseUrl(port)}`);
  await signInAndSave(deskBaseUrl(port), state);
  return stop;
}
