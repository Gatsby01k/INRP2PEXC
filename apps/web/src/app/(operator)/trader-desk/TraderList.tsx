'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DeskTraderRow } from '@inrp2p/traders';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { dateTime, share, usdt } from '../_desk/format.ts';
import { Chip, Empty, Meter } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

const ISSUE: Record<string, string> = {
  NOT_APPROVED: 'not approved',
  PAUSED: 'paused',
  RESERVE_NOT_SET: 'reserve not set',
  RESERVE_SHORT: 'reserve short',
  DESTINATIONS_INACTIVE: 'settlement details inactive',
  ASSIGNMENTS_DISABLED: 'assignments off',
  OFFLINE: 'offline',
};

export function StatusChip({ t }: { t: Pick<DeskTraderRow, 'status' | 'available'> }) {
  if (t.status === 'APPROVED') return t.available ? <Chip tone="success" glyph="done">Online</Chip> : <Chip glyph="pending">Offline</Chip>;
  if (t.status === 'UNDER_REVIEW') return <Chip tone="brand" glyph="partial">Under review</Chip>;
  if (t.status === 'PAUSED') return <Chip tone="warning" icon="pause">Paused</Chip>;
  return <Chip tone="muted">{t.status.toLowerCase().replace('_', ' ')}</Chip>;
}

/**
 * Traders for the desk: applications and settlement changes that need a decision first, then every trader with what
 * matters for routing — status, reserve against its requirement, open and unresolved orders, and what keeps it from
 * being offered work.
 */
export function TraderList({ traders }: { traders: readonly DeskTraderRow[] }) {
  const router = useRouter();
  const needs = traders.filter((t) => t.status === 'UNDER_REVIEW' || t.awaitingReview > 0);
  const rest = traders.filter((t) => !(t.status === 'UNDER_REVIEW' || t.awaitingReview > 0));
  const columns: Column<DeskTraderRow>[] = [
    {
      key: 'trader',
      header: 'Trader',
      render: (t) => (
        <Cell
          main={
            <Link href={`/trader-desk/${t.traderId}`} className={d.link}>
              {t.ref} · {t.clientName}
            </Link>
          }
          sub={`applied ${dateTime(t.appliedAt)}${t.exchangeAccess ? '' : ' · trader only'}`}
        />
      ),
    },
    { key: 'status', header: 'Status', render: (t) => <StatusChip t={t} /> },
    { key: 'sides', header: 'Provides', render: (t) => t.sides.map((s) => (s === 'BUY_USDT' ? 'INR' : 'USDT')).join(' · ') || '—' },
    {
      key: 'reserve',
      header: 'Security Reserve',
      render: (t) => (
        <span className={d.stackTight} style={{ gap: 3, width: 150 }}>
          <span className={d.num}>
            {usdt(t.reserveBalance)}
            {t.reserveRequired ? <span className={d.muted}> of {usdt(t.reserveRequired, { unit: false })}</span> : null}
          </span>
          {t.reserveRequired ? <Meter size="sm" label="Reserve against requirement" parts={[{ value: share(t.reserveBalance, t.reserveRequired, 'USDT'), tone: /[1-9]/.test(t.reserveShortfall) ? 'warning' : 'success' }]} /> : null}
        </span>
      ),
    },
    { key: 'open', header: 'Open', align: 'right', render: (t) => <Cell main={t.openOrders} {...(t.offers > 0 ? { sub: `${t.offers} offered` } : {})} /> },
    { key: 'unresolved', header: 'Unresolved', align: 'right', render: (t) => (t.unresolved > 0 ? <strong className={d.negative}>{t.unresolved}</strong> : 0) },
    { key: 'completed', header: 'Completed', align: 'right', render: (t) => t.completedOrders },
    {
      key: 'issues',
      header: 'Needs',
      render: (t) => (
        <span className={d.row}>
          {t.awaitingReview > 0 ? <Chip tone="warning">{t.awaitingReview === 1 ? '1 detail' : `${t.awaitingReview} details`} to verify</Chip> : null}
          {t.issues.map((i) => (
            <Chip key={i} tone="muted">
              {ISSUE[i] ?? i}
            </Chip>
          ))}
          {t.awaitingReview === 0 && t.issues.length === 0 ? <span className={d.muted}>—</span> : null}
        </span>
      ),
    },
  ];
  return (
    <DataTable<DeskTraderRow>
      caption="Traders"
      label="Traders"
      columns={columns}
      groups={[
        { key: 'needs', title: 'Needs a decision', tone: 'brand', rows: needs },
        { key: 'all', title: 'Traders', rows: rest },
      ]}
      rowKey={(t) => t.traderId}
      onOpen={(t) => router.push(`/trader-desk/${t.traderId}`)}
      rail={(t) => (t.status === 'UNDER_REVIEW' || t.awaitingReview > 0 ? 'action' : t.unresolved > 0 ? 'danger' : null)}
      empty={<Empty title="No trader has applied yet" body="Anyone can apply through “Become a trader”; nothing they submit is usable until it is verified here." />}
    />
  );
}
