'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClientBookRow } from '@inrp2p/desk';
import { Coin } from '../../../components/Coin.tsx';
import { Ago } from '../_desk/clock.tsx';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { marginNegative, marginText, rate, titleCase, usdt, usdtCompact } from '../_desk/format.ts';
import { Icon } from '../_desk/icons.tsx';
import { Chip, Empty } from '../_desk/ui.tsx';
import { Who, bookStyles as b } from '../_book/parts.tsx';
import d from '../_desk/desk.module.css';

const hasMargin = (c: ClientBookRow) => /[1-9]/.test(`${c.marginGenerated ?? ''}${c.marginGeneratedUsdt ?? ''}`);

/**
 * The dealer's book (brief "Clients"): who the clients are, what they usually do, what is in flight, what they have
 * traded and what they have made the desk — economics only for the roles that see it. Not a CRM: one row per client,
 * one click to their page, one to open a request. A status is said only when it is not the ordinary one.
 */
export function ClientBook({ rows, economics, canRequest, filtered }: { rows: readonly ClientBookRow[]; economics: boolean; canRequest: boolean; filtered: boolean }) {
  const router = useRouter();
  const columns: Column<ClientBookRow>[] = [
    {
      key: 'client',
      header: 'Client',
      width: '30%',
      render: (c) => (
        <span className={d.row} style={{ flexWrap: 'nowrap', gap: 'var(--space-3)' }}>
          <Who name={c.name} href={`/clients/${c.clientId}`} sub={`${c.ref} · KYC ${titleCase(c.kycStatus).toLowerCase()}`} {...(c.status !== 'ACTIVE' ? { tone: 'quiet' as const } : {})} />
          {c.status !== 'ACTIVE' ? (
            <Chip tone="danger" glyph="closed">
              suspended
            </Chip>
          ) : null}
        </span>
      ),
    },
    {
      key: 'typical',
      header: 'Usually',
      render: (c) =>
        c.typicalDirection ? (
          <span className={b.usually}>
            <span className={b.coins} aria-hidden="true">
              <Coin currency={c.typicalDirection === 'SELL_USDT' ? 'USDT' : 'INR'} size={22} />
              <Coin currency={c.typicalDirection === 'SELL_USDT' ? 'INR' : 'USDT'} size={22} />
            </span>
            <Cell main={c.typicalDirection === 'SELL_USDT' ? 'Sells USDT' : 'Buys USDT'} sub={c.typicalSize ? `~${usdtCompact(c.typicalSize)}` : undefined} />
          </span>
        ) : (
          <span className={d.muted} data-empty="">—</span>
        ),
    },
    {
      key: 'open',
      header: 'Open',
      align: 'right',
      render: (c) => (
        <span className={b.count} data-tone={c.openTrades > 0 ? 'brand' : 'zero'}>
          {c.openTrades}
        </span>
      ),
    },
    {
      key: 'volume',
      header: 'Traded',
      align: 'right',
      render: (c) =>
        c.completedTrades > 0 ? (
          <Cell main={usdt(c.completedVolume)} sub={`${c.completedTrades} completed`} />
        ) : (
          <span className={d.muted} data-empty="">—</span>
        ),
    },
    ...(economics
      ? ([
          { key: 'rate', header: 'Last rate', align: 'right', render: (c: ClientBookRow) => (c.lastRate ? rate(c.lastRate) : <span className={d.muted} data-empty="">—</span>) },
          {
            key: 'margin',
            header: 'Margin made',
            align: 'right',
            render: (c: ClientBookRow) =>
              hasMargin(c) && c.marginGenerated !== undefined ? (
                <span className={marginNegative(c.marginGenerated, c.marginGeneratedUsdt) ? d.negative : d.positive}>
                  {marginText(c.marginGenerated, /[1-9]/.test(c.marginGeneratedUsdt ?? '') ? c.marginGeneratedUsdt : null)}
                </span>
              ) : (
                <span className={d.muted} data-empty="">—</span>
              ),
          },
        ] as Column<ClientBookRow>[])
      : []),
    { key: 'last', header: 'Last trade', align: 'right', render: (c) => (c.lastActivityAt ? <Ago at={c.lastActivityAt} /> : <span className={d.muted}>never</span>) },
    ...(canRequest
      ? ([
          {
            key: 'act',
            header: '',
            align: 'right',
            render: (c: ClientBookRow) =>
              c.status === 'ACTIVE' ? (
                <Link href={`/clients/${c.clientId}#new-request`} className={b.rowAction}>
                  <Icon name="plus" size={12} />
                  Request
                </Link>
              ) : null,
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
      empty={<Empty title={filtered ? 'Nobody here' : 'No clients yet'} body={filtered ? 'No client matches this view or search. Client names match from the start.' : 'Clients appear here when they sign up or the desk adds them.'} />}
    />
  );
}
