import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { payoutAccounts, treasuryWallets } from '@inrp2p/desk';
import { type DeskTraderDetail, deskTrader } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { can, operatorPage } from '../../../../server/operator.ts';
import { TraderControls } from './TraderControls.tsx';
import { TraderMoney } from './TraderMoney.tsx';
import { TraderOrders } from './TraderOrders.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

export const dynamic = 'force-dynamic';

/** One trader: the decision controls, its registered details, its reserve and rewards, its orders — and the record. */
export default async function TraderDeskPage({ params }: { params: Promise<{ traderId: string }> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'traders:view')) notFound();
  const { traderId } = await params;
  let detail: DeskTraderDetail;
  try {
    detail = await deskTrader(ctx.db, traderId);
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const [accounts, wallets] = await Promise.all([payoutAccounts(ctx.db), treasuryWallets(ctx.db)]);
  const t = detail.trader;
  const perms = {
    configure: can(ctx, 'traders:configure'),
    pause: can(ctx, 'traders:pause'),
    assign: can(ctx, 'traders:assign'),
    record: can(ctx, 'trader_payout:record'),
    confirm: can(ctx, 'trader_payout:confirm'),
    routeRecord: can(ctx, 'route_settlement:record'),
    routeConfirm: can(ctx, 'route_settlement:confirm'),
    reveal: can(ctx, 'bank_account:reveal'),
  };

  return (
    <>
      <header className={shell.header}>
        <h1 className={shell.title}>
          {t.ref} · {t.clientName}
        </h1>
        <span className="ix-muted">
          {t.status.toLowerCase().replace('_', ' ')}
          {t.status === 'APPROVED' ? ` · ${t.available ? 'online' : 'offline'}` : ''}
          {t.assignmentsEnabled ? '' : ' · assignments off'}
        </span>
      </header>
      <div className={shell.content}>
        <div className={styles.grid}>
          <div className="ix-stack">
            <TraderOrders detail={detail} accounts={accounts} wallets={wallets} perms={perms} />
            <TraderMoney detail={detail} accounts={accounts} perms={perms} />
            <section className="ix-card">
              <h2 className="ix-sectionTitle">Decisions</h2>
              {detail.decisions.length === 0 ? (
                <p className="ix-muted">Nothing recorded yet.</p>
              ) : (
                <table className={styles.table}>
                  <tbody>
                    {detail.decisions.map((d, i) => (
                      <tr key={`${d.at}:${i}`}>
                        <td className="ix-muted">{formatIstDateTime(new Date(d.at))}</td>
                        <td>{d.action}</td>
                        <td className="ix-muted">{d.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
          <TraderControls detail={detail} perms={perms} />
        </div>
      </div>
    </>
  );
}
