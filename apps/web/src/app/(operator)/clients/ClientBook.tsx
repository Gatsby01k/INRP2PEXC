'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClientBookRow } from '@inrp2p/desk';
import { Ago } from '../_desk/clock.tsx';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { inr, rate, titleCase, usdt, usdtCompact } from '../_desk/format.ts';
import { Chip, Empty } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

/**
 * The dealer's book (brief "Clients"): who the clients are, what they usually do, how much they have traded, what
 * they last dealt at and what they have made the desk — economics only for the roles that see it. Not a CRM: one
 * row per client, one click to their page, one to open a request.
 */
export function ClientBook({ rows, economics, canRequest }: { rows: readonly ClientBookRow[]; economics: boolean; canRequest: boolean }) {
  const router = useRouter();
  const columns: Column<ClientBookRow>[] = [
    {
      key: 'client',
      header: 'Client',
      width: '22%',
      render: (c) => (
        <Cell
          main={
            <Link href={`/clients/${c.clientId}`} className={d.link}>
              {c.name}
            </Link>
          }
          sub={c.ref}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <span className={d.row} style={{ flexWrap: 'nowrap' }}>
          <Chip tone={c.status === 'ACTIVE' ? 'success' : 'danger'}>{c.status.toLowerCase()}</Chip>
          <Chip tone={c.kycStatus === 'VERIFIED' ? 'success' : c.kycStatus === 'REJECTED' || c.kycStatus === 'EXPIRED' ? 'danger' : 'muted'}>KYC {titleCase(c.kycStatus).toLowerCase()}</Chip>
        </span>
      ),
    },
    {
      key: 'typical',
      header: 'Typical',
      render: (c) => (c.typicalDirection ? <Cell main={c.typicalDirection === 'SELL_USDT' ? 'Sells USDT' : 'Buys USDT'} sub={c.typicalSize ? `~${usdtCompact(c.typicalSize)}` : undefined} /> : <span className={d.muted}>—</span>),
    },
    { key: 'open', header: 'Open', align: 'right', render: (c) => (c.openTrades > 0 ? <strong>{c.openTrades}</strong> : <span className={d.muted}>0</span>) },
    { key: 'completed', header: 'Completed', align: 'right', render: (c) => c.completedTrades },
    { key: 'volume', header: 'Volume', align: 'right', render: (c) => usdt(c.completedVolume, { unit: false }) },
    ...(economics
      ? ([
          { key: 'rate', header: 'Last rate', align: 'right', render: (c: ClientBookRow) => (c.lastRate ? rate(c.lastRate) : '—') },
          { key: 'margin', header: 'Margin made', align: 'right', render: (c: ClientBookRow) => (c.marginGenerated ? <span className={d.positive}>{inr(c.marginGenerated, { sign: true })}</span> : '—') },
        ] as Column<ClientBookRow>[])
      : []),
    { key: 'last', header: 'Last trade', align: 'right', render: (c) => (c.lastActivityAt ? <Ago at={c.lastActivityAt} /> : <span className={d.muted}>never</span>) },
    ...(canRequest
      ? ([
          {
            key: 'act',
            header: '',
            align: 'right',
            render: (c: ClientBookRow) => (
              <Link href={`/clients/${c.clientId}#new-request`} className={d.linkButton}>
                New request
              </Link>
            ),
          },
        ] as Column<ClientBookRow>[])
      : []),
  ];
  return (
    <DataTable<ClientBookRow>
      caption="Clients"
      label="Clients"
      columns={columns}
      rows={rows}
      rowKey={(c) => c.clientId}
      onOpen={(c) => router.push(`/clients/${c.clientId}`)}
      dim={(c) => c.status === 'SUSPENDED'}
      empty={<Empty title="No clients" body="Nobody matches that search. Client names match from the start." />}
    />
  );
}
