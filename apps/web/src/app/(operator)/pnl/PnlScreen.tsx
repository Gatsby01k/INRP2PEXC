'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Money, Rate } from '@inrp2p/kernel';
import type { PnlPage, PnlRow } from '@inrp2p/desk';
import { Button, EmptyState, MarginDisplay, PnlSummary, TradeTable, formatInr, formatIstDateTime, formatRate, formatUsdtHeadline } from '@inrp2p/ui';
import styles from './pnl.module.css';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
] as const;

const shift = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/**
 * Realized and expected, side by side and never added.
 *
 * The summary reports the ledger's own realized margin; the table below says, row by row, which kind each figure
 * is. The reconciliation line is the part worth keeping: it shows the ledger's realized total next to the same
 * total summed from the completed trades, so a page that has drifted from the books says so on its own face
 * instead of being quietly believed (FI-44).
 */
export function PnlScreen({ view, today, canExport }: { view: PnlPage; today: string; canExport: boolean }) {
  const router = useRouter();
  const [from, setFrom] = useState(view.period.from);
  const [to, setTo] = useState(view.period.to);

  const go = (nextFrom: string, nextTo: string) => router.push(`/pnl?from=${nextFrom}&to=${nextTo}`);
  const preset = (key: (typeof PRESETS)[number]['key']) => go(key === 'today' ? today : shift(today, key === 'week' ? 6 : 29), today);

  return (
    <div className="ix-stack">
      <div className="ix-row" role="group" aria-label="Period">
        {PRESETS.map((p) => (
          <Button key={p.key} intent="ghost" size="sm" onClick={() => preset(p.key)}>
            {p.label}
          </Button>
        ))}
        <span className={styles.range}>
          <label htmlFor="from">From</label>
          <input id="from" className="ix-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label htmlFor="to">To</label>
          <input id="to" className="ix-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button intent="secondary" size="sm" onClick={() => go(from, to)}>
            Show
          </Button>
        </span>
        {canExport ? (
          <span className={styles.exports}>
            {(['trades', 'ledger', 'receipts'] as const).map((kind) => (
              <a key={kind} className="ix-linkish" href={`/api/exports/${kind}?from=${view.period.from}&to=${view.period.to}`} download>
                Export {kind}
              </a>
            ))}
          </span>
        ) : null}
      </div>

      <PnlSummary
        periodLabel={view.period.from === view.period.to ? view.period.from : `${view.period.from} → ${view.period.to}`}
        realizedMargin={Money.parse(view.summary.realizedGrossMargin, 'INR')}
        completedVolume={Money.parse(view.summary.completedVolume, 'USDT')}
        completedTrades={view.summary.completedTrades}
        openExpectedMargin={Money.parse(view.summary.openExpectedMargin, 'INR')}
        openTrades={view.summary.openTrades}
      />

      <p className={view.ledgerCheck.agrees ? styles.agrees : styles.drifted} role="status" data-testid="ledger-check">
        {view.ledgerCheck.agrees
          ? `Ledger and trades agree on realized margin: ${formatInr(Money.parse(view.ledgerCheck.ledger, 'INR'), { sign: 'always' })}.`
          : `Realized margin does not reconcile: the ledger has ${formatInr(Money.parse(view.ledgerCheck.ledger, 'INR'), { sign: 'always' })}, the completed trades sum to ${formatInr(Money.parse(view.ledgerCheck.trades, 'INR'), { sign: 'always' })}. Treat this page as unreliable until it is explained.`}
      </p>

      {view.rows.length === 0 ? (
        <EmptyState title="Nothing in this period" body="No trade completed and none is open. Widen the dates to see more." />
      ) : (
        <TradeTable
          caption="Trades"
          rowKey={(r: PnlRow) => r.tradeRef}
          onRowOpen={(r: PnlRow) => router.push(`/orders?trade=${encodeURIComponent(r.tradeRef)}`)}
          columns={[
            { key: 'ref', header: 'Trade', render: (r: PnlRow) => r.tradeRef },
            { key: 'client', header: 'Client', render: (r: PnlRow) => r.clientName },
            { key: 'at', header: 'When', render: (r: PnlRow) => formatIstDateTime(new Date(r.at)) },
            { key: 'direction', header: 'Direction', render: (r: PnlRow) => (r.direction === 'SELL_USDT' ? 'SELL' : 'BUY') },
            { key: 'base', header: 'USDT', numeric: true, render: (r: PnlRow) => formatUsdtHeadline(Money.parse(r.base, 'USDT')) },
            { key: 'client_rate', header: 'Client', numeric: true, render: (r: PnlRow) => formatRate(Rate.parse(r.clientRate, 'CLIENT')) },
            { key: 'route_rate', header: 'Route', numeric: true, render: (r: PnlRow) => formatRate(Rate.parse(r.routeRate, 'ROUTE')) },
            {
              key: 'margin',
              header: 'Gross margin',
              numeric: true,
              render: (r: PnlRow) => <MarginDisplay amount={Money.parse(r.margin, 'INR')} kind={r.kind} size="sm" label="" />,
            },
          ]}
          rows={view.rows}
        />
      )}
    </div>
  );
}
