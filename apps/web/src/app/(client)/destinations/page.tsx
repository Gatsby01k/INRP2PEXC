import { clientDestinations } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { DestinationsScreen } from './DestinationsScreen.tsx';

export const dynamic = 'force-dynamic';

/**
 * Destinations — where this client's money is allowed to go: INR to their bank accounts, USDT to their wallets.
 *
 * Read-only in V1. Adding or archiving a destination is a sensitive client-admin action requiring an enrolled
 * authenticator and a fresh TOTP step-up (SECURITY §2.2, D-08); client TOTP enrolment is not built yet (TD-11),
 * so the desk makes these changes on the client's behalf through `client_bank:add` and `client_wallet:manage`,
 * which is what the screen says. There is deliberately no "add" control here: one that cannot work is worse than
 * none.
 */
export default async function DestinationsPage() {
  const ctx = await clientPage();
  const destinations = await clientDestinations(ctx.db, ctx.access.clientId, { includeArchived: true });

  return (
    <>
      <PageHead title="Destinations" lede="Where the desk may pay you: INR to your bank accounts, USDT to your wallets. The desk adds and archives them with you." />
      <DestinationsScreen destinations={destinations} clientName={ctx.access.clientName} role={ctx.access.role} canAccept={ctx.access.canAcceptQuotes} />
    </>
  );
}
