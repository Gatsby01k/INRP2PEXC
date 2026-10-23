'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OpsDeskRow, OpsDispute } from '@inrp2p/traders';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { dateTime, inr, usdt } from '../_desk/format.ts';
import { Chip, Empty } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

/** A desk's state in INRP2P's words: what it is doing, and what INRP2P decided about it. */
export function DeskStateChips({ desk }: { desk: Pick<OpsDeskRow, 'status' | 'pageHidden' | 'editedSinceHidden'> }) {
  return (
    <span className={d.row} style={{ gap: 4, flexWrap: 'wrap' }}>
      {desk.status === 'LIVE' ? <Chip tone="success" glyph="done">Live</Chip>
        : desk.status === 'SUSPENDED' ? <Chip tone="danger" icon="pause">Suspended</Chip>
          : desk.status === 'PAUSED' ? <Chip tone="warning" icon="pause">Paused</Chip>
            : <Chip tone="muted">Draft</Chip>}
      {desk.pageHidden ? <Chip tone={desk.editedSinceHidden ? 'brand' : 'warning'} icon="flag">{desk.editedSinceHidden ? 'Page changed — review' : 'Page hidden'}</Chip> : null}
    </span>
  );
}

const REASON: Record<string, string> = { NO_CREDIT: 'nothing arrived', WRONG_AMOUNT: 'a different amount', OTHER: 'something else' };

/** Every desk: who runs it, how it stands, its last thirty days, its open disputes. Opens the desk. */
export function DeskOpsList({ desks }: { desks: readonly OpsDeskRow[] }) {
  const router = useRouter();
  const columns: Column<OpsDeskRow>[] = [
    {
      key: 'desk', header: 'Desk', render: (x) => (
        <Cell main={<Link href={`/desk-ops/${x.deskId}`} className={d.link}>{x.name}</Link>} sub={`/${x.handle} · since ${dateTime(x.createdAt)}`} />
      ),
    },
    { key: 'state', header: 'State', render: (x) => <DeskStateChips desk={x} /> },
    { key: 'trader', header: 'Trader', render: (x) => <Cell main={x.trader.name} sub={x.trader.status.toLowerCase().replace('_', ' ')} /> },
    { key: 'clients', header: 'Clients', align: 'right', render: (x) => <span className={d.num}>{x.clients}</span> },
    { key: 'open', header: 'Open deals', align: 'right', render: (x) => <span className={d.num}>{x.openDeals}</span> },
    { key: 'done', header: '30 days', align: 'right', render: (x) => <Cell main={<span className={d.num}>{usdt(x.volume30d)}</span>} sub={`${x.completed30d} deal${x.completed30d === 1 ? '' : 's'}`} /> },
    { key: 'fees', header: 'Fees · 30 days', align: 'right', render: (x) => <span className={d.num}>{usdt(x.fees30d)}</span> },
    { key: 'disputes', header: 'Disputes', align: 'right', render: (x) => (x.openDisputes > 0 ? <Chip tone="danger">{x.openDisputes} open</Chip> : <span className={d.muted}>—</span>) },
  ];
  if (desks.length === 0) return <Empty title="No desk yet" body="An approved trader opens one under Desk in its workspace." />;
  return (
    <DataTable
      caption="Desks"
      columns={columns}
      rows={desks}
      rowKey={(x) => x.deskId}
      onOpen={(x) => router.push(`/desk-ops/${x.deskId}`)}
      rail={(x) => (x.status === 'SUSPENDED' ? 'danger' : x.editedSinceHidden || x.openDisputes > 0 ? 'action' : null)}
    />
  );
}

/** Open P2P disputes, oldest first: each opens its trade, where INRP2P decides it. */
export function DeskDisputes({ disputes }: { disputes: readonly OpsDispute[] }) {
  const router = useRouter();
  const columns: Column<OpsDispute>[] = [
    { key: 'ref', header: 'Dispute', render: (x) => <Cell main={<Link href={`/orders/${encodeURIComponent(x.tradeRef)}`} className={d.link}>{x.ref}</Link>} sub={x.tradeRef} mono /> },
    { key: 'desk', header: 'Desk', render: (x) => (x.desk ? <Cell main={x.desk.name} sub={`/${x.desk.handle}`} /> : <span className={d.muted}>INRP2P</span>) },
    { key: 'client', header: 'Client', render: (x) => x.clientName },
    { key: 'who', header: 'Says', render: (x) => <Cell main={`${x.payee === 'CLIENT' ? 'The client' : 'The trader'}: ${REASON[x.reason] ?? x.reason}`} sub={x.buyerAnswered ? 'the payer answered' : 'no answer from the payer yet'} /> },
    { key: 'amount', header: 'Amount', align: 'right', render: (x) => <span className={d.num}>{inr(x.amount)}</span> },
    { key: 'at', header: 'Opened', render: (x) => <span className={d.num}>{dateTime(x.openedAt)}</span> },
  ];
  if (disputes.length === 0) return <Empty title="No open dispute" body="Every P2P payment someone said did not arrive has been decided." />;
  return <DataTable caption="Open disputes" columns={columns} rows={disputes} rowKey={(x) => x.ref} onOpen={(x) => router.push(`/orders/${encodeURIComponent(x.tradeRef)}`)} rail={() => 'danger'} />;
}
