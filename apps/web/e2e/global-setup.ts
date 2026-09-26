import path from 'node:path';
import { rm } from 'node:fs/promises';
import { deskBaseUrl, startDesk, surfacePorts } from '../harness/desk-server.ts';
import { CLIENT_AUTH_SECRET, E2E_CUSTODY_PROVIDER, E2E_FIELD_KEYS, E2E_PUBLIC_CONTACTS, OPERATOR_AUTH_SECRET, seedE2E } from './world.ts';

/** Where the built app writes client sign-in codes for this run (test-only; the runtime refuses it in production). */
export const OTP_SINK_FILE = path.join(import.meta.dirname, '.client-otp.jsonl');

/**
 * Builds the world, then starts the product against it. The database is created from the migrations every time,
 * so an end-to-end run can never pass against a schema that drifted from `packages/db/migrations`.
 *
 * All three surfaces are started, because Phase 7 crosses all three: the desk sends the quote, the public host
 * serves the link, and the client app is where the trade is followed to completion.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const port = Number.parseInt(process.env.E2E_PORT ?? '3210', 10);
  const ports = surfacePorts(port);
  await rm(OTP_SINK_FILE, { force: true });
  const state = await seedE2E(adminUrl);
  console.log(`e2e: seeded ${state.databaseUrl} (client ${state.clientName}, operator ${state.owner.email})`);
  const stop = await startDesk({
    port,
    databaseUrl: state.databaseUrl,
    operatorAuthSecret: OPERATOR_AUTH_SECRET,
    clientAuthSecret: CLIENT_AUTH_SECRET,
    surfaces: ['desk', 'app', 'public'],
    fieldKeys: E2E_FIELD_KEYS,
    custodyProvider: E2E_CUSTODY_PROVIDER,
    clientOtpSinkFile: OTP_SINK_FILE,
    publicContacts: E2E_PUBLIC_CONTACTS,
    label: 'e2e',
  });
  console.log(`e2e: desk ${deskBaseUrl(ports.desk)} · app ${deskBaseUrl(ports.app)} · link ${deskBaseUrl(ports.public)}`);
  return stop;
}
