'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OrderSummary } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { AssistantPanel } from '../../_assistant/AssistantPanel.tsx';
import { traderOrdersAssistant } from '../../_assistant/traders.ts';
import { EmptyState } from '../../_workspace/EmptyState.tsx';
import { ChevronIcon, ClockIcon, ReceiptIcon } from '../../_workspace/icons.tsx';
import { nextStepText } from '../_ui/ActiveOrders.tsx';
import { OrderPill } from '../_ui/OrderPill.tsx';
import { inr, rate, usdt } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

const TABS = [
  { key: 'active', label: 'Active', href: '/traders/orders' },
  { key: 'completed', label: 'Completed', href: '/traders/orders?tab=completed' },
] as const;

/**
 * Orders as a list of what happened, not a database: each row says what the order was, at what rate, where it
 * stands, when it started and — only where INRP2P pays one — what it earned. A row opens the order.
 */
export function OrdersScreen({ rows, open, counts, tab }: { rows: readonly OrderSummary[]; open: readonly OrderSummary[]; counts: { active: number; completed: number }; tab: 'active' | 'completed' }) {
  const router = useRouter();
  useEffect(() => {
    if (tab !== 'active') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [tab, router]);

  return (
    <>
      <main className={shell.main}>
        <section className={`${shell.card} ${styles.listCard}`} aria-label="Orders" data-robot-target="panel">
          <div className={styles.listHead}>
            <nav className={styles.tabs} aria-label="Orders">
              {TABS.map((t) => (
                <Link key={t.key} href={t.href} className={styles.tab} {...(tab === t.key ? { 'aria-current': 'page' as const } : {})}>
                  {t.label}
                  <span className={styles.count}>{counts[t.key]}</span>
                </Link>
              ))}
            </nav>
          </div>
          {rows.length === 0 ? (
            <EmptyState
              icon={tab === 'active' ? <ClockIcon /> : <ReceiptIcon />}
              title={tab === 'active' ? 'No active orders' : 'Nothing finished yet'}
              body={tab === 'active' ? 'While you are online, orders that match your capacity and rate appear here and on your Traders screen.' : 'Completed and closed orders appear here.'}
              action={
                <Link className={shell.textAction} href="/traders">
                  Back to Traders
                </Link>
              }
            />
          ) : (
            <ul className={styles.rows}>
              {rows.map((o) => (
                <li key={o.ref}>
                  <Link className={styles.row} href={`/traders/orders/${o.ref}`}>
                    <span className={styles.cell}>
                      <span className={styles.cellMain}>{o.ref}</span>
                      <span className={styles.cellSub}>{o.side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT'}</span>
                    </span>
                    <span className={styles.cell}>
                      <span className={styles.cellMain}>{usdt(o.usdt)}</span>
                      <span className={styles.cellSub}>
                        {inr(o.inr)} at {rate(o.rate)}
                      </span>
                    </span>
                    <span className={styles.cell}>
                      <span className={styles.cellMain}>{formatIstDateTime(new Date(o.startedAt ?? o.offeredAt))}</span>
                      <span className={styles.cellSub}>{tab === 'active' ? nextStepText(o) : o.reward && o.status === 'COMPLETED' ? `Earned ${inr(o.reward)}` : o.status === 'COMPLETED' ? 'No reward' : (o.closeNote ?? '')}</span>
                    </span>
                    <span className={styles.cellEnd}>
                      <OrderPill stage={o.stage} status={o.status} />
                      <ChevronIcon className={styles.chevron} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <AssistantPanel state={traderOrdersAssistant(open, counts)} size="compact">
        <div className={styles.navRow}>
          <Link className={shell.textAction} href="/traders">
            Traders
          </Link>
        </div>
      </AssistantPanel>
    </>
  );
}
