import { clientDestinations } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { AccountsScreen } from './AccountsScreen.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

/**
 * Bank accounts and wallets — where this client's money is allowed to go.
 *
 * Read-only in V1. Adding or archiving a destination is a sensitive client-admin action requiring an enrolled
 * authenticator and a fresh TOTP step-up (SECURITY §2.2, D-08); client TOTP enrolment is not built yet (TD-11),
 * so the desk makes these changes on the client's behalf through `client_bank:add` and `client_wallet:manage`,
 * which is what the screen says.
 */
export default async function AccountsPage() {
  const ctx = await clientPage();
  const destinations = await clientDestinations(ctx.db, ctx.access.clientId, { includeArchived: true });

  return (
    <main className={styles.content}>
      <h1 className={styles.pageTitle}>Accounts</h1>
      <AccountsScreen destinations={destinations} clientName={ctx.access.clientName} role={ctx.access.role} />
    </main>
  );
}
