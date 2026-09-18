import Link from 'next/link';
import { Money } from '@inrp2p/kernel';
import { clientBook } from '@inrp2p/desk';
import { EmptyState } from '@inrp2p/ui';
import { formatIstDateTime, formatUsdt } from '@inrp2p/ui/format';
import { operatorPage } from '../../../server/operator.ts';
import styles from '../shell.module.css';
import book from './clients.module.css';

export const dynamic = 'force-dynamic';

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q : '';
  const rows = await clientBook(ctx.db, search ? { search } : {});

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>Clients</h1>
      </header>
      <div className={styles.content}>
        {rows.length === 0 ? (
          <EmptyState title="No clients" body="Nobody matches that search." />
        ) : (
          <ul className={book.list}>
            {rows.map((c) => (
              <li key={c.clientId} className={book.row}>
                <Link href={`/clients/${c.clientId}`} className={book.name}>
                  {c.name}
                </Link>
                <span className="ix-muted">
                  {c.status.toLowerCase()} · KYC {c.kycStatus.toLowerCase().replace(/_/g, ' ')}
                </span>
                <span className="ix-num">{c.openTrades} open</span>
                <span className="ix-num">{c.completedTrades} completed</span>
                <span className="ix-num">{formatUsdt(Money.parse(c.completedVolume, 'USDT'), { unit: true })}</span>
                <span className="ix-muted">{c.lastActivityAt ? formatIstDateTime(new Date(c.lastActivityAt)) : 'no trades yet'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
