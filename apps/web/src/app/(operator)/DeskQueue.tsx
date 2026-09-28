'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { QueueAction, QueueGroup, QueueGroupKey, QueueRow } from '@inrp2p/desk';
import { Age, Countdown } from './_desk/clock.tsx';
import { Cell, type Column, DataTable } from './_desk/DataTable.tsx';
import { inr, inrCompact, isNegative, rate, share, usdt, usdtCompact } from './_desk/format.ts';
import { Empty, Meter, Side } from './_desk/ui.tsx';
import { GROUP_TITLE } from './_desk/queue-labels.ts';
import q from './queue.module.css';
import d from './_desk/desk.module.css';

/** The desk's action hotkeys (UX_FLOWS §6). Each opens the row's panel on the section it names. */
const HOTKEYS: Record<string, string> = { q: 'quote', p: 'payout', u: 'utr', e: 'exception' };

const NEXT: Record<QueueAction, { label: string; key?: string; section: string } | null> = {
  QUOTE: { label: 'Quote', key: 'Q', section: 'quote' },
  CREATE_PAYOUT: { label: 'Create payout', key: 'P', section: 'payout' },
  CONFIRM_INCOMING: { label: 'Confirm INR', key: 'P', section: 'payout' },
  RECORD_EVIDENCE: { label: 'Add UTR', key: 'U', section: 'utr' },
  CONFIRM_PAYOUT: { label: 'Confirm payout', key: 'U', section: 'utr' },
  RESOLVE_EXCEPTION: { label: 'Resolve', key: 'E', section: 'exception' },
  COPY_LINK: { label: 'Open quote', section: 'quote' },
  NONE: null,
};


const KIND_WORD: Record<QueueRow['subject']['kind'], string> = { REQUEST: 'request', QUOTE: 'quote', TRADE: 'trade' };

/**
 * The live work queue (UX_FLOWS W5): what needs the desk right now, grouped in a fixed priority order so critical
 * work is never buried, oldest first within each group. Rows are keyboard-driven — ↑/↓ or j/k to move, Enter to
 * open, and the row's own letter (Q, P, U, E) to open it on the step that letter names.
 */
export function DeskQueue({ groups, economics, selected, view, compact = false }: { groups: readonly QueueGroup[]; economics: boolean; selected: string | null; view: QueueGroupKey | 'all'; compact?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();

  const open = useCallback(
    (rowId: string, section?: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('row', rowId);
      if (section) next.set('do', section);
      else next.delete('do');
      router.push(`/?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  const shown = view === 'all' ? groups : groups.filter((g) => g.key === view);
  const railOf = (key: QueueGroupKey): 'action' | 'danger' | null => (key === 'exception' ? 'danger' : key === 'needs_action' ? 'action' : null);
  const groupOf = new Map<string, QueueGroupKey>();
  for (const g of groups) for (const r of g.rows) groupOf.set(r.id, g.key);

  const amount = (r: QueueRow) => <Cell main={r.baseUsdt ? usdt(r.baseUsdt) : r.quoteInr ? inr(r.quoteInr) : '—'} {...(r.baseUsdt && r.quoteInr ? { sub: inr(r.quoteInr) } : {})} />;
  const margin = (r: QueueRow) =>
    r.margin ? (
      <span className={q.margin} {...(isNegative(r.margin, 'INR') ? { 'data-negative': '' } : {})}>
        {inr(r.margin, { sign: true })}
      </span>
    ) : (
      '—'
    );
  const next = (r: QueueRow) => {
    const n = NEXT[r.action];
    if (!n) return <span className={d.muted}>—</span>;
    const g = groupOf.get(r.id);
    return (
      <button type="button" className={q.next} data-tone={g === 'exception' ? 'danger' : g === 'needs_action' ? 'action' : 'plain'} onClick={() => open(r.id, n.section)}>
        {n.label}
        {n.key ? <kbd className={q.nextKey}>{n.key}</kbd> : null}
      </button>
    );
  };

  const columns: Column<QueueRow>[] = compact
    ? [
        {
          key: 'subject',
          header: 'Client',
          render: (r) => (
            <Cell
              main={
                <span className={d.row} style={{ flexWrap: 'nowrap' }}>
                  <Side direction={r.direction} />
                  {r.clientName}
                </span>
              }
              sub={`${r.subject.ref} · ${KIND_WORD[r.subject.kind]}`}
            />
          ),
        },
        { key: 'amount', header: 'Amount', align: 'right', render: amount },
        ...(economics ? ([{ key: 'margin', header: 'Margin', align: 'right', render: margin }] as Column<QueueRow>[]) : []),
        { key: 'status', header: 'Status', render: (r) => <Status row={r} group={groupOf.get(r.id)!} /> },
        { key: 'next', header: 'Next', align: 'right', render: next },
      ]
    : [
        { key: 'subject', header: 'Client', width: '20%', render: (r) => <Cell main={r.clientName} sub={`${r.subject.ref} · ${KIND_WORD[r.subject.kind]}`} /> },
        { key: 'side', header: 'Side', render: (r) => <Side direction={r.direction} /> },
        { key: 'usdt', header: 'USDT', align: 'right', render: (r) => (r.baseUsdt ? usdt(r.baseUsdt, { unit: false }) : '—') },
        { key: 'inr', header: 'INR', align: 'right', render: (r) => (r.quoteInr ? inr(r.quoteInr) : '—') },
        ...(economics
          ? ([
              {
                key: 'client',
                header: 'Client rate',
                align: 'right',
                render: (r: QueueRow) =>
                  r.clientRate ? (
                    <span title={r.subject.kind === 'REQUEST' ? 'What the client asked for' : 'Agreed client rate'}>
                      {r.subject.kind === 'REQUEST' ? <span className={d.muted}>asks </span> : null}
                      {rate(r.clientRate)}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              { key: 'route', header: 'Route', align: 'right', render: (r: QueueRow) => (r.routeRate ? <span className={q.route}>{rate(r.routeRate)}</span> : '—') },
              { key: 'margin', header: 'Margin', align: 'right', render: margin },
            ] as Column<QueueRow>[])
          : []),
        { key: 'status', header: 'Status', render: (r) => <Status row={r} group={groupOf.get(r.id)!} /> },
        { key: 'age', header: 'Age', align: 'right', render: (r) => <Age at={r.since} short /> },
        { key: 'next', header: 'Next', align: 'right', render: next },
      ];

  const empty = <Empty title="Nothing waiting" body="Every request is priced and every trade is where it should be. New work appears here as it arrives." />;

  return (
    <div data-testid="desk-queue">
      <div className={q.table}>
        <DataTable<QueueRow>
          caption="Desk queue"
          label="Desk queue"
          columns={columns}
          {...(view === 'all' ? { groups: shown.map((g) => ({ key: g.key, title: GROUP_TITLE[g.key], rows: g.rows, ...(g.key === 'exception' ? { tone: 'danger' as const } : g.key === 'needs_action' ? { tone: 'brand' as const } : {}) })) } : { rows: shown.flatMap((g) => g.rows) })}
          rowKey={(r) => r.id}
          onOpen={(r) => open(r.id)}
          selectedKey={selected}
          rail={(r) => railOf(groupOf.get(r.id)!)}
          onRowKey={(r, key) => {
            const section = HOTKEYS[key];
            if (!section) return false;
            open(r.id, section);
            return true;
          }}
          empty={empty}
        />
      </div>
    </div>
  );
}

/** The row's state in words, plus the one figure that says how far along it is. */
function Status({ row, group }: { row: QueueRow; group: QueueGroupKey }) {
  const tone = group === 'exception' ? 'danger' : group === 'needs_action' ? 'brand' : undefined;
  const p = row.payout;
  return (
    <span className={q.status}>
      <span className={q.statusText} {...(tone ? { 'data-tone': tone } : {})}>
        {row.status}
      </span>
      {row.subject.kind === 'QUOTE' && row.expiresAt ? (
        <span className={q.progressText}>
          expires in <Countdown to={row.expiresAt} />
          {row.hasLink ? ' · link sent' : ''}
        </span>
      ) : null}
      {p && (group === 'settlement' || row.status === 'Payout remaining') ? (
        <span className={q.progress}>
          <Meter
            size="sm"
            label={`${p.asset === 'INR' ? inr(p.paid) : usdt(p.paid)} of ${p.asset === 'INR' ? inr(p.obligation) : usdt(p.obligation)} paid`}
            parts={[
              { value: share(p.paid, p.obligation, p.asset), tone: 'success' },
              { value: Math.max(0, share(p.committed, p.obligation, p.asset) - share(p.paid, p.obligation, p.asset)), tone: 'flight' },
            ]}
          />
          <span className={q.progressText}>
            {p.asset === 'INR' ? `${inrCompact(p.paid)} of ${inrCompact(p.obligation)}` : `${usdtCompact(p.paid)} of ${usdtCompact(p.obligation)}`}
          </span>
        </span>
      ) : null}
    </span>
  );
}
