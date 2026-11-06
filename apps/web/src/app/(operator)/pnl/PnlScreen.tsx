'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { PnlPage, PnlRow } from '@inrp2p/desk';
import { Button } from '@inrp2p/ui';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { TextField } from '../_desk/fields.tsx';
import { dateTime, inr, isNegative, marginNegative, marginText, rate, signedUsdt, usdt } from '../_desk/format.ts';
import { Empty, KpiBand, Notice, Side } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import p from './pnl.module.css';

/**
 * Realized and expected, side by side and never added (FI-43, brief "P&L").
 *
 * The headline is what the ledger says INRP2P earned in the period, in USDT (a P2P deal's rupees are one amount and earn
 * nothing, ADR 0019); open trades' expected margin sits apart, labelled
 * as a forecast. The reconciliation line is the part worth keeping: the ledger's realized total beside the same
 * total summed from the completed trades, so a page that has drifted from the books says so on its own face.
 */
/** Earned as a share of the volume, to the hundredth of a percent; exact integer arithmetic, never a float. */
const earnedShare = (earned: string, volume: string): string => {
  const v = Money.parse(volume, 'USDT').minor;
  if (v <= 0n) return '—';
  const bps = (Money.parse(earned, 'USDT').minor * 10_000n) / v;
  const abs = bps < 0n ? -bps : bps;
  return `${bps < 0n ? '−' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`;
};

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
    { key: 'route', header: 'Trader’s rate', align: 'right', render: (r) => <span className={d.muted}>{rate(r.routeRate)}</span> },
    {
      key: 'margin',
      header: 'Margin',
      align: 'right',
      render: (r) => (
        <span className={marginNegative(r.margin, r.marginUsdt) ? d.negative : r.kind === 'realized' ? d.positive : d.secondary}>
          {marginText(r.margin, r.marginUsdt)}
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
            { key: 'r', label: 'Earned', value: signedUsdt(s.realizedMarginUsdt), sub: 'margin and desks’ fees, from the ledger', size: 'lg', ...(isNegative(s.realizedMarginUsdt, 'USDT') ? { tone: 'danger' as const } : {}) },
            { key: 'v', label: 'Completed volume', value: usdt(s.completedVolume), sub: `${s.completedTrades} trade${s.completedTrades === 1 ? '' : 's'}` },
            { key: 'a', label: 'Earned on volume', value: earnedShare(s.realizedMarginUsdt, s.completedVolume), sub: 'realized ÷ completed volume' },
            { key: 'c', label: 'Completed trades', value: String(s.completedTrades) },
          ]}
        />
        <dl className={p.expected} aria-label="Open trades, expected">
          <dt>Open trades · expected, not realized</dt>
          <dd className={p.expectedValue}>{signedUsdt(s.openExpectedMarginUsdt)}</dd>
          <dd className={p.expectedSub}>
            across {s.openTrades} open trade{s.openTrades === 1 ? '' : 's'} — a forecast, never added to the figure beside it
          </dd>
        </dl>
      </div>
      <Notice>The network each deal carries is not counted as earned: it pays GasFree, at cost, out of the deal’s own USDT.</Notice>

      <div data-testid="ledger-check" role="status">
        {view.ledgerCheck.agrees ? (
          <Notice tone="success" icon="check">
            Ledger and trades agree on what was earned: {signedUsdt(view.ledgerCheck.ledgerUsdt)}.
          </Notice>
        ) : (
          <Notice tone="danger" icon="exceptions">
            <strong>What was earned does not reconcile:</strong> the ledger has {signedUsdt(view.ledgerCheck.ledgerUsdt)}, the completed trades sum to {signedUsdt(view.ledgerCheck.tradesUsdt)}. Treat
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
