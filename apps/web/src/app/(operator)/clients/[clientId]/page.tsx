import Link from 'next/link';
import { Money } from '@inrp2p/kernel';
import { clientDetail } from '@inrp2p/desk';
import { BankAccountRow, WalletRow } from '@inrp2p/ui';
import { formatInr, formatIstDateTime, formatUsdt } from '@inrp2p/ui/format';
import { can, operatorPage } from '../../../../server/operator.ts';
import { NewRequest } from './NewRequest.tsx';
import styles from '../../shell.module.css';
import book from '../clients.module.css';

export const dynamic = 'force-dynamic';

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await operatorPage();
  const { clientId } = await params;
  const query = await searchParams;
  const client = await clientDetail(ctx.db, clientId, ctx.access);

  // "Repeat trade" prefills the builder from a previous trade of this client — nothing is created until the
  // dealer presses the button, so a repeat is still a fresh request with its own terms.
  const repeatOf = typeof query.repeat === 'string' ? client.recentTrades.find((t) => t.tradeId === query.repeat) : undefined;

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>{client.name}</h1>
        <span className="ix-muted">
          {client.status.toLowerCase()} · KYC {client.kycStatus.toLowerCase().replace(/_/g, ' ')}
        </span>
      </header>
      <div className={styles.content}>
        <div className={book.detail}>
          <div className="ix-stack">
            {can(ctx, 'request:create') ? (
              <NewRequest client={client} {...(repeatOf ? { prefill: { direction: repeatOf.direction, amount: repeatOf.base } } : {})} />
            ) : null}

            <section className="ix-card">
              <h2 className="ix-sectionTitle">Recent trades</h2>
              {client.recentTrades.length === 0 ? (
                <p className="ix-muted">No trades yet.</p>
              ) : (
                <ul className={book.list}>
                  {client.recentTrades.map((t) => (
                    <li key={t.tradeId} className={book.row}>
                      <Link href={`/orders?state=ALL&trade=${t.tradeId}`} className={book.name}>
                        {t.ref}
                      </Link>
                      <span>{t.direction === 'SELL_USDT' ? 'SELL' : 'BUY'}</span>
                      <span className="ix-num">{formatUsdt(Money.parse(t.base, 'USDT'), { unit: true })}</span>
                      <span className="ix-num">{formatInr(Money.parse(t.quoteInr, 'INR'))}</span>
                      {t.clientRate ? <span className="ix-num">₹{t.clientRate}</span> : null}
                      <span className="ix-muted">{t.lifecycle.toLowerCase().replace(/_/g, ' ')}</span>
                      <span className="ix-muted">{formatIstDateTime(new Date(t.openedAt))}</span>
                      {can(ctx, 'request:create') ? (
                        <Link href={`?repeat=${t.tradeId}`} className="ix-linkish">
                          Repeat
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <aside className="ix-stack">
            <section className="ix-card">
              <h2 className="ix-sectionTitle">Bank accounts</h2>
              {client.bankAccounts.map((b) => (
                <BankAccountRow
                  key={b.id}
                  bankName={b.detail.split(' ')[0] ?? b.label}
                  last4={b.detail.slice(-4)}
                  holderName={b.label}
                  status={b.status === 'ACTIVE' ? 'ACTIVE' : 'ARCHIVED'}
                />
              ))}
              {client.bankAccounts.length === 0 ? <p className="ix-muted">None on file.</p> : null}
            </section>

            <section className="ix-card">
              <h2 className="ix-sectionTitle">Wallets</h2>
              {client.wallets.map((w) => (
                <WalletRow key={w.id} address={w.detail.split(' · ')[1] ?? ''} network="TRC20" label={w.label} status={w.status === 'ACTIVE' ? 'ACTIVE' : 'ARCHIVED'} />
              ))}
              {client.wallets.length === 0 ? <p className="ix-muted">None on file.</p> : null}
            </section>

            <section className="ix-card">
              <h2 className="ix-sectionTitle">Who may accept a quote</h2>
              {client.acceptors.length === 0 ? (
                <p className="ix-muted">Nobody yet — a quote link cannot be accepted until someone is authorized.</p>
              ) : (
                <ul className={book.plain}>
                  {client.acceptors.map((a) => (
                    <li key={a.clientUserId}>{a.maskedEmail}</li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}
