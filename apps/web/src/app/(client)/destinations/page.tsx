import { clientDestinations, clientPeople, hasAuthenticator } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { DestinationsScreen } from './DestinationsScreen.tsx';
import { ManageDestinations } from './ManageDestinations.tsx';

export const dynamic = 'force-dynamic';

/**
 * Destinations — where this client's money is allowed to go: INR to their bank accounts, USDT to their wallets.
 *
 * Everyone may set up an authenticator here (TD-11). An administrator with one adds and archives destinations and
 * decides who may accept quotes — each a sensitive client-admin action with a fresh step-up (SECURITY §2.2, D-08);
 * the desk can still make the same changes through `client_bank:add` and `client_wallet:manage`.
 */
export default async function DestinationsPage() {
  const ctx = await clientPage();
  const destinations = await clientDestinations(ctx.db, ctx.access.clientId, { includeArchived: true });
  const isAdmin = ctx.access.role === 'CLIENT_ADMIN';
  const [people, authenticator] = await Promise.all([isAdmin ? clientPeople(ctx.db, ctx.access.clientId) : Promise.resolve([]), hasAuthenticator(ctx.db, ctx.actor.userId)]);

  return (
    <>
      <PageHead title="Destinations" lede="Where the desk may pay you: INR to your bank accounts, USDT to your wallets. Administrators change them here with an authenticator code, or the desk does it with you." />
      <DestinationsScreen destinations={destinations} clientName={ctx.access.clientName} role={ctx.access.role} canAccept={ctx.access.canAcceptQuotes} />
      <ManageDestinations destinations={destinations} people={people} isAdmin={isAdmin} hasAuthenticator={authenticator} />
    </>
  );
}
