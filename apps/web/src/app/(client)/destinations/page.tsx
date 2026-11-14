import { clientDestinations } from '@inrp2p/portal';
import { clientPage, protectionOfRequest, workspaceContext } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { DestinationsScreen } from './DestinationsScreen.tsx';
import { BankIcon } from '../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * Bank & wallets — where this client's money is allowed to go: INR to their bank accounts, USDT to their wallets.
 *
 * An administrator adds and archives them here, each change a sensitive client-admin action confirmed by a factor other
 * than the one they signed in with (ADR 0026, D-08), and adds a second factor here if they have none yet; the desk can
 * still make the same changes through `client_bank:add` and `client_wallet:manage`. Who may accept quotes is on Account.
 */
export default async function DestinationsPage() {
  const ctx = await clientPage();
  const [destinations, protection, who] = await Promise.all([
    clientDestinations(ctx.db, ctx.access.clientId, { includeArchived: true }),
    protectionOfRequest(),
    workspaceContext().then((w) => w.access),
  ]);

  return (
    <>
      <PageHead icon={<BankIcon />} title="Bank & wallets" lede="Where your money lands. INR goes only to your own bank accounts and UPI IDs, USDT only to your own wallets." />
      <DestinationsScreen
        destinations={destinations}
        clientName={ctx.access.clientName}
        email={who.email}
        isAdmin={ctx.access.role === 'CLIENT_ADMIN'}
        protection={protection}
      />
    </>
  );
}
