import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { requireClientSession } from '@inrp2p/identity';
import { ONBOARDING } from '../../content/site.ts';
import { getRuntime } from '../../server/runtime.ts';
import { onboardingHref, publicOrigin } from '../../server/site.ts';
import { surfaceForHost } from '../../server/surface.ts';
import { WorkspaceGateway } from '../sign-in/WorkspaceGateway.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Become a trader — INRP2P Exchange' };

/**
 * "Become a trader" — the public way in for someone who wants to provide INR or USDT capacity (docs/TRADERS.md §3).
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
  // Someone already signed in goes straight to where their application, or their trader screen, is.
  const signedIn = await requireClientSession(rt.clientAuth, rt.appDb, h).then(
    () => true,
    () => false,
  );
  if (signedIn) redirect('/traders');
  return <WorkspaceGateway home={await publicOrigin()} onboarding={onboardingHref()} unlinked={ONBOARDING.unlinked} mode="TRADER" />;
}
