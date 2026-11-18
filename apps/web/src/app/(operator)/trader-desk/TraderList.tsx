'use client';

import { useRouter } from 'next/navigation';
import type { DeskTraderRow } from '@inrp2p/traders';
import { type Column, DataTable } from '../_desk/DataTable.tsx';
import { date, share, usdt } from '../_desk/format.ts';
import { Chip, Empty } from '../_desk/ui.tsx';
import { MiniMeter, Who, bookStyles as b } from '../_book/parts.tsx';
import { AUTO_FLAG, DESK_FLAGS, ISSUE, StatusChip, TIER_WORD, provides } from './words.tsx';
import d from '../_desk/desk.module.css';

/**
 * Traders for the desk: applications and settlement changes that need a decision first, then every trader with what
 * matters for routing — whether it is online, its reserve against what it must hold, how much of its limit open deals
 * use, its orders, and what keeps it from being offered work.
 */
export function TraderList({ traders }: { traders: readonly DeskTraderRow[] }) {
  const router = useRouter();
  const needs = traders.filter((t) => t.status === 'UNDER_REVIEW' || t.awaitingReview > 0);
  const rest = traders.filter((t) => !(t.status === 'UNDER_REVIEW' || t.awaitingReview > 0));
  const columns: Column<DeskTraderRow>[] = [
    {
      key: 'trader',
      header: 'Trader',
      width: '24%',
      render: (t) => (
        <Who
          name={t.clientName}
          href={`/trader-desk/${t.traderId}`}
          sub={`${t.ref} · ${t.status === 'UNDER_REVIEW' ? `applied ${date(t.appliedAt)}` : `provides ${provides(t.sides)}`}`}
          {...(t.status === 'PAUSED' || t.status === 'REJECTED' ? { tone: 'quiet' as const } : {})}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (t) => (
        <span className={d.row} style={{ flexWrap: 'nowrap' }}>
          <StatusChip t={t} />
          {t.status === 'APPROVED' && !t.assignmentsEnabled ? <Chip tone="warning">no new orders</Chip> : null}
        </span>
      ),
    },
    {
      key: 'reserve',
      header: 'Security Reserve',
      render: (t) => {
        if (t.status === 'UNDER_REVIEW') return <span className={d.muted}>set at approval</span>;
        const short = /[1-9]/.test(t.reserveShortfall);
        return (
          <span className={b.meterCell}>
            <span>
              {usdt(t.reserveBalance)}
              {t.reserveRequired ? <small> of {usdt(t.reserveRequired, { unit: false })}</small> : <small> · none required</small>}
            </span>
            {t.reserveRequired ? <MiniMeter value={share(t.reserveBalance, t.reserveRequired, 'USDT')} tone={short ? 'warning' : 'success'} label="Reserve against what it must hold" /> : null}
          </span>
        );
      },
    },
    {
      key: 'limit',
      header: 'Open of limit',
      render: (t) =>
        t.risk ? (
          <span className={b.meterCell}>
            <span>
              {usdt(t.risk.open, { unit: false })}
              <small> of {usdt(t.risk.maxOpen)}</small>
            </span>
            <MiniMeter value={share(t.risk.open, t.risk.maxOpen, 'USDT')} tone="brand" label="Open deals against the limit" />
            <small>
              {TIER_WORD[t.risk.level] ?? t.risk.level}
              {t.risk.heldBack ? ' · held back' : ''} · deal ≤ {usdt(t.risk.maxDeal, { unit: false })}
            </small>
          </span>
        ) : (
          <span className={d.muted} data-empty="">—</span>
        ),
    },
    {
      key: 'orders',
      header: 'Orders',
      render: (t) =>
        t.status === 'UNDER_REVIEW' ? (
          <span className={d.muted} data-empty="">—</span>
        ) : (
          <span className={d.row} style={{ flexWrap: 'nowrap', gap: 6 }} title={`${t.openOrders} open · ${t.unresolved} unresolved · ${t.completedOrders} completed`}>
            <span className={b.count} data-tone={t.openOrders > 0 ? 'brand' : 'zero'}>
              {t.openOrders}
            </span>
            <span className={d.muted}>open</span>
            {t.unresolved > 0 ? (
              <>
                <span className={b.count} data-tone="danger">
                  {t.unresolved}
                </span>
                <span className={d.muted}>owed</span>
              </>
            ) : null}
            {t.offers > 0 ? <span className={d.muted}>· {t.offers} offered</span> : null}
          </span>
        ),
    },
    {
      key: 'issues',
      header: 'Needs',
      wrap: true,
      render: (t) => (
        <span className={d.row} style={{ gap: 4 }}>
          {t.awaitingReview > 0 ? <Chip tone="brand" glyph="partial">{t.awaitingReview === 1 ? '1 detail' : `${t.awaitingReview} details`} to verify</Chip> : null}
          {t.autoReviewFlags.map((f) => (
            <Chip key={f} tone={DESK_FLAGS.has(f) ? 'warning' : 'muted'}>
              {AUTO_FLAG[f] ?? f}
            </Chip>
          ))}
          {t.issues
            .filter((i) => !(i === 'OFFLINE' && t.status === 'APPROVED') && !(i === 'PAUSED' && t.status === 'PAUSED'))
            .map((i) => (
              <Chip key={i} tone="muted">
                {ISSUE[i] ?? i}
              </Chip>
            ))}
          {t.awaitingReview === 0 && t.autoReviewFlags.length === 0 && t.issues.every((i) => (i === 'OFFLINE' && t.status === 'APPROVED') || (i === 'PAUSED' && t.status === 'PAUSED')) ? (
            <span className={d.muted} data-empty="">—</span>
          ) : null}
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
      dim={(t) => t.status === 'REJECTED'}
      empty={<Empty title="No trader has applied yet" body="Anyone can apply through “Become a trader”; nothing they submit is usable until it is verified here." />}
    />
  );
}
