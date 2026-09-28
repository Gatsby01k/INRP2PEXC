'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClientDetail } from '@inrp2p/desk';
import { Cell, type Column, DataTable } from '../../_desk/DataTable.tsx';
import { dateTime, inr, rate, usdt } from '../../_desk/format.ts';
import { Empty, LifecycleChip, Side } from '../../_desk/ui.tsx';
import d from '../../_desk/desk.module.css';

type Row = ClientDetail['recentTrades'][number];

export function RecentTrades({ trades, canRepeat }: { trades: readonly Row[]; canRepeat: boolean }) {
  const router = useRouter();
  const columns: Column<Row>[] = [
    { key: 'ref', header: 'Trade', render: (t) => <Cell main={<Link href={`/orders/${encodeURIComponent(t.ref)}`} className={d.link}>{t.ref}</Link>} sub={dateTime(t.openedAt)} /> },
    { key: 'side', header: 'Side', render: (t) => <Side direction={t.direction} /> },
    { key: 'amount', header: 'Amount', align: 'right', render: (t) => <Cell main={usdt(t.base)} sub={inr(t.quoteInr)} /> },
    ...(trades.some((t) => t.clientRate)
      ? ([
          { key: 'rate', header: 'Rate', align: 'right', render: (t: Row) => (t.clientRate ? rate(t.clientRate) : '—') },
          { key: 'margin', header: 'Margin', align: 'right', render: (t: Row) => (t.margin ? <span className={t.lifecycle === 'COMPLETED' ? d.positive : d.secondary}>{inr(t.margin, { sign: true })}</span> : '—') },
        ] as Column<Row>[])
      : []),
    { key: 'state', header: 'Status', render: (t) => <LifecycleChip state={t.lifecycle} hold={t.hold} /> },
    ...(canRepeat
      ? ([
          {
            key: 'repeat',
            header: '',
            align: 'right',
            render: (t: Row) => (
              <Link href={`?repeat=${t.tradeId}#new-request`} className={d.linkButton} scroll={false}>
                Repeat
              </Link>
            ),
          },
        ] as Column<Row>[])
      : []),
  ];
  return (
    <DataTable<Row>
      caption="Recent trades"
      columns={columns}
      rows={trades}
      rowKey={(t) => t.tradeId}
      onOpen={(t) => router.push(`/orders/${encodeURIComponent(t.ref)}`)}
      dim={(t) => t.lifecycle === 'CANCELLED'}
      empty={<Empty title="No trades yet" body="Open a request above to price their first one." />}
    />
  );
}
