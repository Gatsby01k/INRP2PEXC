import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { requireClientSession } from '@inrp2p/identity';
import { recordTraderEntry } from '../../server/acquisition-app.ts';
import { getRuntime } from '../../server/runtime.ts';
import { publicOrigin } from '../../server/site.ts';
import { TRADERS_PATH, surfaceForHost } from '../../server/surface.ts';
import { WorkspaceGateway } from '../sign-in/WorkspaceGateway.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Open your exchange — INRP2P Exchange' };

/**
 * "Open your exchange" — the public way in for a trader or broker: their own exchange on INRP2P, which starts as a trader
 * application (docs/TRADERS.md §3).
 *
 * It is the workspace gateway in another state: the same room, the same robot, the same email code. What differs is
 * what the code opens: the trader application, for an address that has no workspace yet, or Traders for one that
 * has. Nobody is provisioned by hand and nobody is allow-listed: anyone may apply, and nothing they submit is usable
 * until the desk has verified it and approved them. The Exchange stays closed to them all the while.
 */
export default async function BecomeATraderPage() {
  const rt = getRuntime();
  const h = await headers();
  if (surfaceForHost(h.get('host'), rt.hosts) !== 'CLIENT') notFound();
  // From `inrp2p.com/traders`: the visitor reached the app (migration 0053). Nothing is recorded for anyone else.
  await recordTraderEntry();
  // Someone already signed in goes straight to where their application, or their trader screen, is.
  const signedIn = await requireClientSession(rt.clientAuth, rt.appDb, h).then(
    () => true,
    () => false,
  );
  if (signedIn) redirect('/traders');
  // The way back is the trader page the visitor came from, not the client site's home.
  return <WorkspaceGateway home={`${await publicOrigin()}${TRADERS_PATH}`} mode="TRADER" />;
}
