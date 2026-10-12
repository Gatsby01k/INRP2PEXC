import { clientPeople, hasAuthenticator, workspaceAccess } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { AccountScreen } from './AccountScreen.tsx';

export const dynamic = 'force-dynamic';

/**
 * Account & security: who is signed in and for which client, their authenticator, and — for an administrator — who
 * on the account may accept quotes (TD-11). Each change of authority is a sensitive client-admin action confirmed
 * with the authenticator (SECURITY §2.2).
 */
export default async function AccountPage() {
  const ctx = await clientPage();
  const isAdmin = ctx.access.role === 'CLIENT_ADMIN';
  const [who, authenticator, people] = await Promise.all([
    workspaceAccess(ctx.db, ctx.actor.userId),
    hasAuthenticator(ctx.db, ctx.actor.userId),
    isAdmin ? clientPeople(ctx.db, ctx.access.clientId) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHead title="Account & security" lede="Who you are signed in as, how your sign-in is protected, and who on your account may accept quotes." />
      <AccountScreen
        clientName={ctx.access.clientName}
        email={who.email}
        role={ctx.access.role}
        canAccept={ctx.access.canAcceptQuotes}
        hasAuthenticator={authenticator}
        people={people}
        isAdmin={isAdmin}
      />
    </>
  );
}
