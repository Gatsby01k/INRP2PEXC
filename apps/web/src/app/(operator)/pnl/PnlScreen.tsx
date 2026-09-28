'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { PnlPage, PnlRow } from '@inrp2p/desk';
import { Button, averageMarginPerUsdt } from '@inrp2p/ui';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { TextField } from '../_desk/fields.tsx';
import { dateTime, inr, isNegative, rate, usdt } from '../_desk/format.ts';
import { Empty, KpiBand, Notice, Side } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import p from './pnl.module.css';

/**
 * Realized and expected, side by side and never added (FI-43, brief "P&L").
 *
 * The headline is the ledger's realized margin for the period; open trades' expected margin sits apart, labelled
 * as a forecast. The reconciliation line is the part worth keeping: the ledger's realized total beside the same
 * total summed from the completed trades, so a page that has drifted from the books says so on its own face.
 */
export function PnlScreen({ view, canExport }: { view: PnlPage; canExport: boolean }) {
  const router = useRouter();
  const [from, setFrom] = useState(view.period.from);
  const [to, setTo] = useState(view.period.to);
  const realized = view.rows.filter((r) => r.kind === 'realized');
  const expected = view.rows.filter((r) => r.kind === 'expected');
  const s = view.summary;

  const columns: Column<PnlRow>[] = [
    {
      key: 'ref',
      header: 'Trade',
      render: (r) => (
        <Cell
          main={
            <Link href={`/orders/${encodeURIComponent(r.tradeRef)}`} className={d.link}>
              {r.tradeRef}
            </Link>
          }
          sub={r.clientName}
        />
      ),
    },
    { key: 'side', header: 'Side', render: (r) => <Side direction={r.direction} /> },
    { key: 'at', header: 'When', render: (r) => <span className={d.num}>{dateTime(r.at)}</span> },
    { key: 'base', header: 'USDT', align: 'right', render: (r) => usdt(r.base, { unit: false }) },
    { key: 'inr', header: 'INR', align: 'right', render: (r) => inr(r.inr) },
    { key: 'client', header: 'Client rate', align: 'right', render: (r) => rate(r.clientRate) },
    { key: 'route', header: 'Route rate', align: 'right', render: (r) => <span className={d.muted}>{rate(r.routeRate)}</span> },
    {
      key: 'margin',
      header: 'Gross margin',
      align: 'right',
      render: (r) => (
        <span className={isNegative(r.margin, 'INR') ? d.negative : r.kind === 'realized' ? d.positive : d.secondary}>
          {inr(r.margin, { sign: true })}
          {r.kind === 'expected' ? <span className={p.kind}> expected</span> : null}
        </span>
      ),
    },
  ];

  return (
    <div className={d.stack}>
      <div className={p.controls}>
        <form
          className={p.range}
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/pnl?from=${from}&to=${to}`);
          }}
        >
          <TextField label="From" type="date" value={from} onChange={setFrom} />
          <TextField label="To" type="date" value={to} onChange={setTo} />
          <Button type="submit" intent="secondary" size="sm">
            Show
          </Button>
        </form>
        {canExport ? (
          <div className={p.exports}>
            <span className={d.meta}>Export this period</span>
            {(['trades', 'ledger', 'receipts'] as const).map((kind) => (
              <a key={kind} className={p.exportLink} href={`/api/exports/${kind}?from=${view.period.from}&to=${view.period.to}`} download>
                {kind} CSV
              </a>
            ))}
          </div>
        ) : null}
      </div>

      <div className={p.summary}>
        <KpiBand
          label="Realized in the period"
          items={[
            { key: 'r', label: 'Realized gross margin', value: inr(s.realizedGrossMargin, { sign: true }), sub: 'from the ledger', size: 'lg', ...(isNegative(s.realizedGrossMargin, 'INR') ? { tone: 'danger' as const } : { tone: 'success' as const }) },
            { key: 'v', label: 'Completed volume', value: usdt(s.completedVolume), sub: `${s.completedTrades} trade${s.completedTrades === 1 ? '' : 's'}` },
            { key: 'a', label: 'Average margin / USDT', value: averageMarginPerUsdt(Money.parse(s.realizedGrossMargin, 'INR'), Money.parse(s.completedVolume, 'USDT')), sub: 'realized over completed volume' },
            { key: 'c', label: 'Completed trades', value: String(s.completedTrades) },
          ]}
        />
        <dl className={p.expected} aria-label="Open trades, expected">
          <dt>Open trades · expected, not realized</dt>
          <dd className={p.expectedValue}>{inr(s.openExpectedMargin, { sign: true })}</dd>
          <dd className={p.expectedSub}>
            across {s.openTrades} open trade{s.openTrades === 1 ? '' : 's'} — a forecast, never added to the figure beside it
          </dd>
        </dl>
      </div>

      <div data-testid="ledger-check" role="status">
        {view.ledgerCheck.agrees ? (
          <Notice tone="success" icon="check">
            Ledger and trades agree on realized margin: {inr(view.ledgerCheck.ledger, { sign: true })}.
          </Notice>
        ) : (
          <Notice tone="danger" icon="exceptions">
            <strong>Realized margin does not reconcile:</strong> the ledger has {inr(view.ledgerCheck.ledger, { sign: true })}, the completed trades sum to {inr(view.ledgerCheck.trades, { sign: true })}. Treat
            this page as unreliable until it is explained.
          </Notice>
        )}
      </div>

      <section className={p.table} aria-label="Trades">
        {view.rows.length === 0 ? (
          <Empty title="Nothing in this period" body="No trade completed and none is open. Widen the dates to see more." />
        ) : (
          <DataTable<PnlRow>
            caption="Trades"
            label="Trades"
            columns={columns}
            groups={[
              { key: 'realized', title: 'Realized · completed in the period', rows: realized },
              { key: 'expected', title: 'Expected · still open', rows: expected },
            ]}
            rowKey={(r) => r.tradeRef}
            onOpen={(r) => router.push(`/orders/${encodeURIComponent(r.tradeRef)}`)}
            dim={(r) => r.kind === 'expected'}
          />
        )}
      </section>
    </div>
  );
}
