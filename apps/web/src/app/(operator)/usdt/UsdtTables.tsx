'use client';

import Link from 'next/link';
import type { TransferView, TreasuryWalletView } from '@inrp2p/desk';
import { CopyButton } from '@inrp2p/ui';
import { shortenAddress, shortenHash } from '@inrp2p/ui/format';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { dateTime, usdt } from '../_desk/format.ts';
import { Chip, Empty } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

const ROLE: Record<TreasuryWalletView['role'], string> = { HOT: 'Hot', COLD: 'Cold', DEPOSIT_POOL: 'Deposit pool' };

export function WalletsTable({ wallets }: { wallets: readonly TreasuryWalletView[] }) {
  const columns: Column<TreasuryWalletView>[] = [
    { key: 'wallet', header: 'Wallet', render: (w) => <Cell main={w.label} sub={ROLE[w.role]} /> },
    {
      key: 'address',
      header: 'Address · TRC20',
      render: (w) => (
        <span className={d.row} style={{ flexWrap: 'nowrap' }}>
          <span className={d.mono} title={w.address}>
            {shortenAddress(w.address, 6, 6)}
          </span>
          <CopyButton value={w.address} label="wallet address" />
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (w) => <Chip tone={w.status === 'ACTIVE' ? 'success' : 'warning'}>{w.status.toLowerCase()}</Chip> },
    { key: 'observed', header: 'Observed', align: 'right', render: (w) => usdt(w.observed, { unit: false }) },
    { key: 'reserved', header: 'Reserved', align: 'right', render: (w) => usdt(w.reserved, { unit: false }) },
    { key: 'available', header: 'Available', align: 'right', render: (w) => <strong>{usdt(w.available, { unit: false })}</strong> },
    { key: 'seen', header: 'Observed at', render: (w) => <span className={d.secondary}>{w.observedAt ? dateTime(w.observedAt) : 'not yet'}</span> },
  ];
  return <DataTable<TreasuryWalletView> caption="Treasury wallets" columns={columns} rows={wallets} rowKey={(w) => w.walletId} empty={<Empty title="No treasury wallet registered" />} />;
}

const STATE: Record<TransferView['state'], { label: string; tone: 'success' | 'brand' | 'danger' | 'warning' }> = {
  DETECTED: { label: 'Awaiting finality', tone: 'brand' },
  CONFIRMED: { label: 'Solidified', tone: 'success' },
  FAILED: { label: 'Failed on chain', tone: 'danger' },
  ORPHANED: { label: 'Orphaned by a reorg', tone: 'warning' },
};

export function TransfersTable({ transfers }: { transfers: readonly TransferView[] }) {
  const columns: Column<TransferView>[] = [
    { key: 'at', header: 'Detected', render: (t) => <span className={d.num}>{dateTime(t.detectedAt)}</span> },
    {
      key: 'tx',
      header: 'Transaction',
      render: (t) => (
        <span className={d.row} style={{ flexWrap: 'nowrap' }}>
          <span className={d.mono} title={t.txHash}>
            {shortenHash(t.txHash)}
            {t.logIndex > 0 ? `:${t.logIndex}` : ''}
          </span>
          <CopyButton value={t.txHash} label="transaction hash" />
        </span>
      ),
    },
    { key: 'amount', header: 'USDT', align: 'right', render: (t) => <strong>{usdt(t.amount, { exact: true, unit: false })}</strong> },
    { key: 'state', header: 'State', render: (t) => <Chip tone={STATE[t.state].tone}>{STATE[t.state].label}</Chip> },
    {
      key: 'route',
      header: 'From → to',
      render: (t) => (
        <span className={d.mono} title={`${t.from} → ${t.to}`}>
          {shortenAddress(t.from)} → {shortenAddress(t.to)}
        </span>
      ),
    },
    {
      key: 'trade',
      header: 'Trade',
      render: (t) =>
        t.tradeRef ? (
          <Link href={`/orders/${encodeURIComponent(t.tradeRef)}`} className={d.link}>
            {t.tradeRef}
          </Link>
        ) : t.source === 'SCANNER' ? (
          <Chip tone="warning">Unattributed</Chip>
        ) : (
          <span className={d.muted}>desk submitted</span>
        ),
    },
  ];
  return (
    <DataTable<TransferView>
      caption="Transfers"
      columns={columns}
      rows={transfers}
      rowKey={(t) => t.id}
      rail={(t) => (t.tradeRef === null && t.source === 'SCANNER' ? 'danger' : t.state === 'DETECTED' ? 'action' : null)}
      empty={<Empty title="Nothing on chain here" body="The scanner reports transfers to the desk's addresses as it sees them." />}
    />
  );
}
