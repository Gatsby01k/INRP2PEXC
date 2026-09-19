import path from 'node:path';
import { rm } from 'node:fs/promises';
import { deskBaseUrl, startDesk, surfacePorts } from '../harness/desk-server.ts';
import { signInAndSave, signInClientAndSave } from './auth.ts';
import { UPDATE_REQUESTED, guard } from './environment.ts';
import { CLIENT_AUTH_SECRET, OPERATOR_AUTH_SECRET, VISUAL_CUSTODY_PROVIDER, VISUAL_FIELD_KEYS, seedVisual } from './world.ts';

/** Where the built app writes client sign-in codes for this run (test-only; the runtime refuses it in production). */
const OTP_SINK_FILE = path.join(import.meta.dirname, '.client-otp.jsonl');

/**
 * Refuses to run outside the canonical environment, then builds the fixture world and starts the built product
 * against it — in that order, so the app never connects to a database that is about to be dropped.
 *
 * All three surfaces are started from Phase 7 on: the client pages live on the app host and the quote link on
 * the public one, and a baseline of a page served from the wrong surface would be a baseline of a bug.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const env = await guard();
  if (env && UPDATE_REQUESTED) process.env.VISUAL_ENV_JSON = JSON.stringify(env);

  const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const port = Number.parseInt(process.env.VISUAL_PORT ?? '3220', 10);
  const ports = surfacePorts(port);
  await rm(OTP_SINK_FILE, { force: true });
  const state = await seedVisual(adminUrl);
  console.log(`visual: seeded ${state.databaseUrl}`);
  const stop = await startDesk({
    port,
    databaseUrl: state.databaseUrl,
    operatorAuthSecret: OPERATOR_AUTH_SECRET,
    clientAuthSecret: CLIENT_AUTH_SECRET,
    surfaces: ['desk', 'app', 'public'],
    fieldKeys: VISUAL_FIELD_KEYS,
    custodyProvider: VISUAL_CUSTODY_PROVIDER,
    clientOtpSinkFile: OTP_SINK_FILE,
    label: 'visual',
  });
  console.log(`visual: desk ${deskBaseUrl(ports.desk)} · app ${deskBaseUrl(ports.app)} · link ${deskBaseUrl(ports.public)}`);
  await signInAndSave(deskBaseUrl(ports.desk), state);
  await signInClientAndSave(deskBaseUrl(ports.app), state.client.email, OTP_SINK_FILE);
  return stop;
}
