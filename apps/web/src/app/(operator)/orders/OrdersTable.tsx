'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { OrderRow } from '@inrp2p/desk';
import { Ago } from '../_desk/clock.tsx';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { dateTime, inr, isNegative, rate, usdt } from '../_desk/format.ts';
import { Empty, LifecycleChip, Side } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

/**
 * Every trade, newest first. A row opens the same trade workspace the desk uses, beside the list; the reference is
 * a link to the full record. Margin and client rate exist only for operators with `economics:view` — the read
 * model leaves them out otherwise, so there is nothing here to hide.
 */
export function OrdersTable({ rows, economics, selected }: { rows: readonly OrderRow[]; economics: boolean; selected: string | null }) {
  const router = useRouter();
  const params = useSearchParams();

  const open = (r: OrderRow) => {
    const next = new URLSearchParams(params.toString());
    next.set('trade', r.tradeId);
    router.push(`/orders?${next.toString()}`, { scroll: false });
  };

  const columns: Column<OrderRow>[] = [
    {
      key: 'ref',
      header: 'Trade',
      render: (r) => (
        <Cell
          main={
            <Link href={`/orders/${encodeURIComponent(r.ref)}`} className={d.link}>
              {r.ref}
            </Link>
          }
          sub={r.clientName}
        />
      ),
    },
    { key: 'side', header: 'Side', render: (r) => <Side direction={r.direction} /> },
    { key: 'usdt', header: 'USDT', align: 'right', render: (r) => usdt(r.base, { unit: false }) },
    { key: 'inr', header: 'INR', align: 'right', render: (r) => inr(r.quoteInr) },
    ...(economics
      ? ([
          { key: 'rate', header: 'Client rate', align: 'right', render: (r: OrderRow) => (r.clientRate ? rate(r.clientRate) : '—') },
          {
            key: 'margin',
            header: 'Margin',
            align: 'right',
            render: (r: OrderRow) =>
              r.margin ? (
                <span className={isNegative(r.margin, 'INR') ? d.negative : r.lifecycle === 'COMPLETED' ? d.positive : d.secondary} title={r.lifecycle === 'COMPLETED' ? 'Realized' : 'Expected'}>
                  {inr(r.margin, { sign: true })}
                </span>
              ) : (
                '—'
              ),
          },
        ] as Column<OrderRow>[])
      : []),
    { key: 'status', header: 'Status', render: (r) => <LifecycleChip state={r.lifecycle} hold={r.hold} /> },
    { key: 'opened', header: 'Opened', render: (r) => <Cell main={<span className={d.num}>{dateTime(r.openedAt)}</span>} sub={r.completedAt ? `completed ${dateTime(r.completedAt)}` : <Ago at={r.openedAt} />} /> },
  ];

  return (
    <DataTable<OrderRow>
      caption="Trades"
      label="Trades"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.tradeId}
      onOpen={open}
      selectedKey={selected}
      rail={(r) => (r.hold ? 'danger' : null)}
      dim={(r) => r.lifecycle === 'CANCELLED'}
      empty={<Empty title="No trades here" body="Nothing matches this view. Try another tab or clear the search." />}
    />
  );
}
