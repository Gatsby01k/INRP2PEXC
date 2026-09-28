'use client';

import { type Column, DataTable } from '../_desk/DataTable.tsx';
import { Empty } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

interface Row {
  readonly id: string;
  readonly at: string;
  readonly route: string;
  readonly pair: string;
  readonly rate: string;
  readonly change: { readonly text: string; readonly sign: -1 | 0 | 1 } | null;
  readonly by: string;
}

/** Published route rates, newest first — a table, never a chart (brief: "Do not add candlestick charts"). */
export function HistoryTable({ rows }: { rows: readonly Row[] }) {
  const columns: Column<Row>[] = [
    { key: 'at', header: 'Published', render: (r) => <span className={d.num}>{r.at}</span> },
    { key: 'route', header: 'Route', render: (r) => r.route },
    { key: 'pair', header: 'Direction', render: (r) => <span className={d.secondary}>{r.pair}</span> },
    { key: 'rate', header: 'Rate', align: 'right', render: (r) => <strong>{r.rate}</strong> },
    {
      key: 'change',
      header: 'Change',
      align: 'right',
      render: (r) => (r.change ? <span className={r.change.sign > 0 ? d.positive : r.change.sign < 0 ? d.negative : d.muted}>{r.change.text}</span> : <span className={d.muted}>first</span>),
    },
    { key: 'by', header: 'By', render: (r) => <span className={d.secondary}>{r.by}</span> },
  ];
  return <DataTable<Row> caption="Recent rate changes" columns={columns} rows={rows} rowKey={(r) => r.id} empty={<Empty title="No rate published yet" />} />;
}
