'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClientDetail } from '@inrp2p/desk';
import { Cell, type Column, DataTable } from '../../_desk/DataTable.tsx';
import { dateTime, inr, marginText, rate, usdt } from '../../_desk/format.ts';
import { Empty, LifecycleChip, Side } from '../../_desk/ui.tsx';
import { Coin } from '../../../../components/Coin.tsx';
import { bookStyles as b } from '../../_book/parts.tsx';
import d from '../../_desk/desk.module.css';

type Row = ClientDetail['recentTrades'][number];

export function RecentTrades({ trades, canRepeat }: { trades: readonly Row[]; canRepeat: boolean }) {
  const router = useRouter();
  const columns: Column<Row>[] = [
    {
      key: 'ref',
      header: 'Trade',
      render: (t) => (
        <span className={b.who}>
          <span className={b.coins} aria-hidden="true">
            <Coin currency={t.direction === 'SELL_USDT' ? 'USDT' : 'INR'} size={24} />
            <Coin currency={t.direction === 'SELL_USDT' ? 'INR' : 'USDT'} size={24} />
          </span>
          <span className={b.whoText}>
            <span className={d.row} style={{ flexWrap: 'nowrap' }}>
              <Link href={`/orders/${encodeURIComponent(t.ref)}`} className={d.link}>
                {t.ref}
              </Link>
              <Side direction={t.direction} />
            </span>
            <span className={b.whoSub}>{dateTime(t.openedAt)}</span>
          </span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (t) => <Cell main={usdt(t.base)} sub={inr(t.quoteInr)} /> },
    ...(trades.some((t) => t.clientRate)
      ? ([
          {
            key: 'rate',
            header: 'Rate · margin',
            align: 'right',
            render: (t: Row) => (
              <Cell
                main={t.clientRate ? rate(t.clientRate) : '—'}
                sub={t.margin || t.marginUsdt ? <span className={t.lifecycle === 'COMPLETED' ? d.positive : undefined}>{marginText(t.margin, t.marginUsdt)}</span> : undefined}
              />
            ),
          },
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
              <Link href={`?repeat=${t.tradeId}#new-request`} className={b.rowAction} scroll={false}>
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
      empty={<Empty title="No trades yet" body="Their first trade appears here as soon as a request is priced." />}
    />
  );
}
