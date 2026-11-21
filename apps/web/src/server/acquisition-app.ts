import { cookies, headers } from 'next/headers';
import { after } from 'next/server';
import { type Attribution, TOUCH_COOKIE, decodeAttribution } from './acquisition.ts';
import { linkAcquisition, recordAcquisitionEvent, visitContext } from './acquisition-record.ts';
import { getRuntime } from './runtime.ts';

/**
 * The trader path on the app's host, for migration 0053. The attribution arrived in the address of the acquisition page's
 * call to action and is in this host's own cookie (the proxy put it there); these read it and write after the response,
 * so no page waits on them, and a page reached without one records nothing.
 */

async function attribution(): Promise<Attribution | null> {
  return decodeAttribution((await cookies()).get(TOUCH_COOKIE)?.value);
}

/** The visitor reached the trader sign-in ("Open your exchange") from the acquisition page. */
export async function recordTraderEntry(): Promise<void> {
  const a = await attribution();
  if (!a) return;
  const ctx = visitContext(await headers());
  const db = getRuntime().appDb;
  after(() => recordAcquisitionEvent(db, a, { kind: 'ENTRY', page: 'BECOME_A_TRADER' }, ctx));
}

/**
 * The visitor is now signed in on the trader path and has not applied yet: tie their visitor id to who they are, once.
 * Returns the attribution, so the application can start on the side they came for.
 */
export async function rememberTraderAcquisition(userId: string): Promise<Attribution | null> {
  const a = await attribution();
  if (!a) return null;
  const ctx = visitContext(await headers());
  const db = getRuntime().appDb;
  after(() => linkAcquisition(db, a, userId, ctx));
  return a;
}
