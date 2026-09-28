'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DeskExceptionRow } from '@inrp2p/desk';
import { Age } from '../_desk/clock.tsx';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { Chip, Empty, Side } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

type Row = DeskExceptionRow & { readonly title: string; readonly subject: string | null };

/** Open cases, blocking first, oldest first within each: the order someone should work them in. */
export function CasesTable({ cases, selected, meId }: { cases: readonly Row[]; selected: string | null; meId: string }) {
  const router = useRouter();
  const columns: Column<Row>[] = [
    { key: 'case', header: 'Case', width: '30%', render: (c) => <Cell main={c.title} sub={`${c.ref} · ${c.detectedBy === 'SYSTEM' ? 'detected by the system' : `opened by ${c.openedByLabel}`}`} /> },
    {
      key: 'trade',
      header: 'Concerns',
      render: (c) =>
        c.trade ? (
          <span className={d.row}>
            <Side direction={c.trade.direction} />
            <Cell
              main={
                <Link href={`/orders/${encodeURIComponent(c.trade.ref)}`} className={d.link}>
                  {c.trade.ref}
                </Link>
              }
              sub={c.trade.clientName}
            />
          </span>
        ) : (
          <Cell main={<span className={d.secondary}>No trade</span>} sub={c.subject ?? ''} />
        ),
    },
    { key: 'severity', header: 'Severity', render: (c) => <Chip tone={c.severity === 'BLOCKING' ? 'danger' : 'warning'} icon={c.severity === 'BLOCKING' ? 'lock' : 'flag'}>{c.severity === 'BLOCKING' ? 'Blocking' : 'Warning'}</Chip> },
    { key: 'owner', header: 'Owner', render: (c) => (c.takenBy ? (c.takenBy === meId ? <strong>You</strong> : c.takenByLabel) : <span className={d.muted}>Unassigned</span>) },
    { key: 'age', header: 'Open for', align: 'right', render: (c) => <Age at={c.openedAt} /> },
  ];
  return (
    <DataTable<Row>
      caption="Open exception cases"
      label="Open exception cases"
      testId="cases"
      columns={columns}
      groups={[
        { key: 'blocking', title: 'Blocking', tone: 'danger', rows: cases.filter((c) => c.severity === 'BLOCKING') },
        { key: 'warning', title: 'Warnings', rows: cases.filter((c) => c.severity === 'WARNING') },
      ]}
      rowKey={(c) => c.id}
      onOpen={(c) => router.push(`/exceptions?case=${c.id}`, { scroll: false })}
      selectedKey={selected}
      rail={(c) => (c.severity === 'BLOCKING' ? 'danger' : null)}
      empty={<Empty title="No open cases" body="Every exception the system or the desk has raised is resolved or voided." />}
    />
  );
}
