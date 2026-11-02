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

/** ADR 0024: why the programme's rules left an application or a change for a person, in the desk's words. */
export const AUTO_FLAG: Record<string, string> = {
  BANK_NAME_MISMATCH: 'bank holder is not the applicant',
  BANK_ON_FILE_ELSEWHERE: 'bank account on another client’s file',
  BANK_REJECTED_BEFORE: 'bank account rejected before',
  WALLET_NOT_PROVEN: 'no USDT from the wallet yet',
  WALLET_ON_FILE_ELSEWHERE: 'wallet on another client’s file',
  WALLET_REJECTED_BEFORE: 'wallet rejected before',
  RESERVE_SHORT: 'reserve not funded yet',
  NO_DEFAULT_RESERVE: 'programme reserve not set',
  REJECTED_BEFORE: 'rejected before: a person decides',
  ORDERS_OPEN: 'waits for open orders',
};

/** Flags a person must act on; the rest are the trader's own move. */
const DESK_FLAGS = new Set(['BANK_NAME_MISMATCH', 'BANK_ON_FILE_ELSEWHERE', 'BANK_REJECTED_BEFORE', 'WALLET_ON_FILE_ELSEWHERE', 'WALLET_REJECTED_BEFORE', 'REJECTED_BEFORE', 'NO_DEFAULT_RESERVE']);

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
    {
      key: 'limit',
      header: 'Open of limit',
      render: (t) =>
        t.risk ? (
          <span className={d.stackTight} style={{ gap: 3, width: 150 }}>
            <span className={d.num}>
              {usdt(t.risk.open, { unit: false })}
              <span className={d.muted}> of {usdt(t.risk.maxOpen)}</span>
            </span>
            <span className={d.muted}>
              {t.risk.level.toLowerCase()}
              {t.risk.heldBack ? ' · held back' : ''} · deal ≤ {usdt(t.risk.maxDeal, { unit: false })}
            </span>
          </span>
        ) : (
          <span className={d.muted}>—</span>
        ),
    },
    { key: 'unresolved', header: 'Unresolved', align: 'right', render: (t) => (t.unresolved > 0 ? <strong className={d.negative}>{t.unresolved}</strong> : 0) },
    { key: 'completed', header: 'Completed', align: 'right', render: (t) => t.completedOrders },
    {
      key: 'issues',
      header: 'Needs',
      render: (t) => (
        <span className={d.row}>
          {t.awaitingReview > 0 ? <Chip tone="warning">{t.awaitingReview === 1 ? '1 detail' : `${t.awaitingReview} details`} to verify</Chip> : null}
          {t.autoReviewFlags.map((f) => (
            <Chip key={f} tone={DESK_FLAGS.has(f) ? 'warning' : 'muted'}>
              {AUTO_FLAG[f] ?? f}
            </Chip>
          ))}
          {t.issues.map((i) => (
            <Chip key={i} tone="muted">
              {ISSUE[i] ?? i}
            </Chip>
          ))}
          {t.awaitingReview === 0 && t.issues.length === 0 && t.autoReviewFlags.length === 0 ? <span className={d.muted}>—</span> : null}
        </span>
      ),
    },
  ];
  return (
    <DataTable<DeskTraderRow>
      caption="Traders"
      label="Traders"
      columns={columns}
      // A group heading only earns its place when there is something to tell apart: decisions first, then the rest.
      {...(needs.length > 0
        ? {
            groups: [
              { key: 'needs', title: 'Needs a decision', tone: 'brand' as const, rows: needs },
              { key: 'all', title: 'Everyone else', rows: rest },
            ],
          }
        : { rows: rest })}
      rowKey={(t) => t.traderId}
      onOpen={(t) => router.push(`/trader-desk/${t.traderId}`)}
      rail={(t) => (t.status === 'UNDER_REVIEW' || t.awaitingReview > 0 ? 'action' : t.unresolved > 0 ? 'danger' : null)}
      empty={<Empty title="No trader has applied yet" body="Anyone can apply through “Become a trader”; nothing they submit is usable until it is verified here." />}
    />
  );
}
