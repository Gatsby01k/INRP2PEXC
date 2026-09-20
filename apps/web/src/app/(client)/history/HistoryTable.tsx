'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Money, Rate } from '@inrp2p/kernel';
import type { HistoryRow } from '@inrp2p/portal';
import { EmptyState, TradeTable, formatInr, formatIstDateTime, formatRate, formatUsdtHeadline } from '@inrp2p/ui';
import styles from '../shell.module.css';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
] as const;

const STATUS_LABEL: Record<string, string> = {
  AWAITING_FIRST_LEG: 'Waiting',
  FIRST_LEG_DETECTED: 'Waiting',
  FIRST_LEG_CONFIRMED: 'In progress',
  SETTLING: 'In progress',
  PARTIALLY_SETTLED: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export function HistoryTable({ rows, filter }: { rows: readonly HistoryRow[]; filter: string }) {
  const router = useRouter();
  return (
    <>
      <div className="ix-row" role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key === 'all' ? '/history' : `/history?filter=${f.key}`} className="ix-linkish" {...(filter === f.key ? { 'aria-current': 'page' as const } : {})}>
            {f.label}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nothing here yet" body="Trades and their payments appear here as soon as you have one." />
      ) : (
        <TradeTable
          caption="History"
          rowKey={(r: HistoryRow) => r.ref}
          onRowOpen={(r: HistoryRow) => router.push(`/trades/${r.ref}`)}
          columns={[
            { key: 'ref', header: 'Trade', render: (r: HistoryRow) => r.ref },
            { key: 'opened', header: 'Started', render: (r: HistoryRow) => formatIstDateTime(new Date(r.openedAt)) },
            { key: 'status', header: 'Status', render: (r: HistoryRow) => <span className={r.onHold ? styles.muted : undefined}>{STATUS_LABEL[r.status] ?? r.status}</span> },
            { key: 'base', header: 'USDT', numeric: true, render: (r: HistoryRow) => formatUsdtHeadline(Money.parse(r.base, 'USDT')) },
            { key: 'inr', header: 'INR', numeric: true, render: (r: HistoryRow) => formatInr(Money.parse(r.inr, 'INR')) },
            { key: 'rate', header: 'Rate', numeric: true, render: (r: HistoryRow) => formatRate(Rate.parse(r.clientRate, 'CLIENT')) },
            {
              key: 'receipt',
              header: 'Receipt',
              render: (r: HistoryRow) =>
                r.receipt ? (
                  // Stops the row's own navigation: someone clicking "Receipt" wants the document, not the trade.
                  <a className="ix-linkish" href={`/api/receipts/${encodeURIComponent(r.ref)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    Receipt
                  </a>
                ) : (
                  <span className={styles.muted}>—</span>
                ),
            },
          ]}
          rows={rows}
        />
      )}
    </>
  );
}
