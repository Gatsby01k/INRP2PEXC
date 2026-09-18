import { deskStrip, payoutAccounts, routePositions, treasuryWallets } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { RatesClient } from './RatesClient.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

export default async function RatesPage() {
  const ctx = await operatorPage();
  const showPositions = ctx.access.routePositions;
  const [strip, positions, accounts, wallets] = await Promise.all([
    deskStrip(ctx.db, ctx.access),
    showPositions ? routePositions(ctx.db, { status: 'OPEN' }) : Promise.resolve([]),
    payoutAccounts(ctx.db),
    treasuryWallets(ctx.db),
  ]);

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>Rates</h1>
      </header>
      <div className={styles.content}>
        <RatesClient
          routes={strip.routes ?? []}
          positions={positions}
          accounts={accounts.map((a) => ({ accountId: a.accountId, label: a.label, bankName: a.bankName }))}
          wallets={wallets.map((w) => ({ walletId: w.walletId, label: w.label, address: w.address }))}
          canPublish={can(ctx, 'rates:update_route')}
          canRecord={can(ctx, 'route_settlement:record')}
          canConfirm={can(ctx, 'route_settlement:confirm')}
          showPositions={showPositions}
        />
        {!ctx.access.economics ? <p className="ix-muted">Route rates are hidden for your role.</p> : null}
      </div>
    </>
  );
}
