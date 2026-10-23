import { clientDestinations, hasAuthenticator, workspaceAccess } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { DestinationsScreen } from './DestinationsScreen.tsx';
import { BankIcon } from '../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * Bank & wallets — where this client's money is allowed to go: INR to their bank accounts, USDT to their wallets.
 *
 * An administrator adds and archives them here, each change a sensitive client-admin action confirmed with their
 * authenticator (SECURITY §2.2, D-08), and sets the authenticator up here if they have none yet; the desk can still
 * make the same changes through `client_bank:add` and `client_wallet:manage`. Who may accept quotes is on Account.
 */
export default async function DestinationsPage() {
  const ctx = await clientPage();
  const [destinations, authenticator, who] = await Promise.all([
    clientDestinations(ctx.db, ctx.access.clientId, { includeArchived: true }),
    hasAuthenticator(ctx.db, ctx.actor.userId),
    workspaceAccess(ctx.db, ctx.actor.userId),
  ]);

  return (
    <>
      <PageHead icon={<BankIcon />} title="Bank & wallets" lede="Where the desk pays you. INR goes only to these bank accounts, and USDT only to these wallets." />
      <DestinationsScreen
        destinations={destinations}
        clientName={ctx.access.clientName}
        email={who.email}
        isAdmin={ctx.access.role === 'CLIENT_ADMIN'}
        hasAuthenticator={authenticator}
      />
    </>
  );
}
