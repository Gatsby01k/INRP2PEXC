import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import { collectionAccounts, deskTraders } from '@inrp2p/traders';
import { formatIstDateTime, formatUsdt } from '@inrp2p/ui/format';
import { can, operatorPage } from '../../../server/operator.ts';
import { ProgramForm } from './ProgramForm.tsx';
import shell from '../shell.module.css';
import styles from './traders.module.css';

export const dynamic = 'force-dynamic';

const ISSUE: Record<string, string> = {
  NOT_APPROVED: 'not approved',
  PAUSED: 'paused',
  RESERVE_NOT_SET: 'reserve not set',
  RESERVE_SHORT: 'reserve short',
  DESTINATIONS_INACTIVE: 'settlement details inactive',
  ASSIGNMENTS_DISABLED: 'assignments off',
  OFFLINE: 'offline',
};

/**
 * Traders, for the desk (`traders:view`): applications waiting first, then every trader with what matters for
 * routing — status, online, reserve against requirement, open and unresolved orders — and the programme settings.
 */
export default async function TradersDeskPage() {
  const ctx = await operatorPage();
  if (!can(ctx, 'traders:view')) notFound();
  const [{ program, traders }, accounts] = await Promise.all([deskTraders(ctx.db), collectionAccounts(ctx.db)]);
  const usdt = (a: string) => formatUsdt(Money.parse(a, 'USDT'), { unit: true });

  return (
    <>
      <header className={shell.header}>
        <h1 className={shell.title}>Traders</h1>
        <span className="ix-muted">{traders.filter((t) => t.status === 'UNDER_REVIEW').length} waiting for review</span>
      </header>
      <div className={shell.content}>
        <div className={styles.grid}>
          <section className="ix-card">
            <h2 className="ix-sectionTitle">Traders</h2>
            {traders.length === 0 ? (
              <p className="ix-muted">No trader has applied yet.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Trader</th>
                    <th>Status</th>
                    <th>Sides</th>
                    <th className={styles.num}>Reserve</th>
                    <th className={styles.num}>Open</th>
                    <th className={styles.num}>Unresolved</th>
                    <th className={styles.num}>Completed</th>
                    <th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {traders.map((t) => (
                    <tr key={t.traderId}>
                      <td>
                        <Link href={`/trader-desk/${t.traderId}`} className="ix-linkish">
                          {t.ref}
                        </Link>{' '}
                        {t.clientName}
                        <div className="ix-muted">applied {formatIstDateTime(new Date(t.appliedAt))}</div>
                      </td>
                      <td>
                        <span className={styles.tag} data-tone={t.status === 'APPROVED' ? (t.available ? 'good' : undefined) : t.status === 'UNDER_REVIEW' ? 'brand' : 'warn'}>
                          {t.status === 'APPROVED' ? (t.available ? 'online' : 'offline') : t.status.toLowerCase().replace('_', ' ')}
                        </span>
                      </td>
                      <td>{t.sides.map((s) => (s === 'BUY_USDT' ? 'Buy' : 'Sell')).join(' · ')}</td>
                      <td className={styles.num}>
                        {usdt(t.reserveBalance)}
                        {t.reserveRequired ? <div className="ix-muted">of {usdt(t.reserveRequired)}</div> : null}
                      </td>
                      <td className={styles.num}>
                        {t.openOrders}
                        {t.offers > 0 ? <div className="ix-muted">{t.offers} offered</div> : null}
                      </td>
                      <td className={styles.num}>{t.unresolved}</td>
                      <td className={styles.num}>{t.completedOrders}</td>
                      <td className="ix-muted">{t.issues.map((i) => ISSUE[i] ?? i).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <ProgramForm program={program} accounts={accounts} canConfigure={can(ctx, 'traders:configure')} />
        </div>
      </div>
    </>
  );
}
