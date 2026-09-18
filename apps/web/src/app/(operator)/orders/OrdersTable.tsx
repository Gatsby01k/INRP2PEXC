'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import type { OrderRow } from '@inrp2p/desk';
import { EmptyState, NumericCell, OperationalStatus, type TradeLifecycleState, TradeTable } from '@inrp2p/ui';
import { formatInr, formatIstDateTime, formatUsdt } from '@inrp2p/ui/format';

const FILTERS = [
  { value: 'OPEN', label: 'Open' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All' },
] as const;

/** Orders (UX_FLOWS §2): every trade, filtered, with the row opening the same panel the desk uses. */
export function OrdersTable({ rows, state, economics }: { rows: readonly OrderRow[]; state: string; economics: boolean }) {
  const router = useRouter();
  const params = useSearchParams();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    if (key === 'state') next.delete('trade');
    router.push(`?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="ix-stack">
      <div className="ix-row" role="group" aria-label="Filter by state">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className="ix-linkish"
            aria-pressed={state === f.value}
            style={state === f.value ? { color: 'var(--text-primary)', fontWeight: 600 } : undefined}
            onClick={() => setParam('state', f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No trades here" body="Nothing matches this filter yet." />
      ) : (
        <TradeTable
          caption="Trades"
          rows={rows}
          rowKey={(r) => r.tradeId}
          onRowOpen={(r) => setParam('trade', r.tradeId)}
          columns={[
            { key: 'ref', header: 'Ref', render: (r) => r.ref },
            { key: 'client', header: 'Client', render: (r) => r.clientName },
            { key: 'direction', header: 'Direction', render: (r) => (r.direction === 'SELL_USDT' ? 'SELL' : 'BUY') },
            {
              key: 'base',
              header: 'USDT',
              numeric: true,
              render: (r) => <NumericCell as="span">{formatUsdt(Money.parse(r.base, 'USDT'))}</NumericCell>,
            },
            {
              key: 'inr',
              header: 'INR',
              numeric: true,
              render: (r) => <NumericCell as="span">{formatInr(Money.parse(r.quoteInr, 'INR'))}</NumericCell>,
            },
            ...(economics
              ? [
                  {
                    key: 'margin',
                    header: 'Margin',
                    numeric: true,
                    render: (r: OrderRow) => <NumericCell as="span">{r.margin ? formatInr(Money.parse(r.margin, 'INR'), { sign: 'always' }) : '—'}</NumericCell>,
                  },
                ]
              : []),
            {
              key: 'status',
              header: 'Status',
              render: (r) => <OperationalStatus state={r.lifecycle as TradeLifecycleState} hold={r.hold} />,
            },
            { key: 'opened', header: 'Opened', render: (r) => formatIstDateTime(new Date(r.openedAt)) },
          ]}
        />
      )}
    </div>
  );
}
