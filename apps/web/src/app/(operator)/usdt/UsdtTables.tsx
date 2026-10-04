'use client';

import Link from 'next/link';
import type { BackfillView, TransferView, TreasuryWalletView, UsdtView } from '@inrp2p/desk';
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

type ProviderRow = UsdtView['providers'][number];
const HEALTH: Record<ProviderRow['health'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  OK: { label: 'answering', tone: 'success' },
  DEGRADED: { label: 'failing', tone: 'warning' },
  DOWN: { label: 'down', tone: 'danger' },
  UNKNOWN: { label: 'not used yet', tone: 'neutral' },
};

/** Each chain provider's last answer (A3): which one is failing, since when, and why — never a credential. */
export function ProvidersTable({ providers }: { providers: readonly ProviderRow[] }) {
  const columns: Column<ProviderRow>[] = [
    { key: 'provider', header: 'Provider', render: (p) => <Cell main={p.provider} sub={`independence group ${p.independenceGroup}`} /> },
    { key: 'health', header: 'State', render: (p) => <Chip tone={HEALTH[p.health].tone}>{HEALTH[p.health].label}</Chip> },
    { key: 'heads', header: 'Head · solidified', render: (p) => <span className={d.num}>{p.lastHead ?? '—'} · {p.lastSolidified ?? '—'}</span> },
    { key: 'ok', header: 'Last answered', render: (p) => <span className={d.secondary}>{p.lastOkAt ? dateTime(p.lastOkAt) : 'never'}</span> },
    { key: 'error', header: 'Last failure', render: (p) => <span className={d.secondary}>{p.lastErrorAt ? `${dateTime(p.lastErrorAt)} · ${p.lastError ?? ''}` : 'none'}</span> },
  ];
  return <DataTable<ProviderRow> caption="Chain providers" columns={columns} rows={providers} rowKey={(p) => p.provider} empty={<Empty title="No provider has been used yet" />} />;
}

/** Historical backfills (TD-06): what range, how far it has been proved read, what it found. */
export function BackfillsTable({ backfills }: { backfills: readonly BackfillView[] }) {
  const columns: Column<BackfillView>[] = [
    { key: 'ref', header: 'Backfill', render: (b) => <Cell main={b.ref} sub={dateTime(b.requestedAt)} /> },
    { key: 'status', header: 'Status', render: (b) => <Chip tone={b.status === 'COMPLETED' ? 'success' : b.status === 'RUNNING' ? 'brand' : 'warning'}>{b.status.toLowerCase()}</Chip> },
    { key: 'range', header: 'Blocks', render: (b) => <span className={d.num}>{b.fromBlock} – {b.toBlock}</span> },
    { key: 'next', header: 'Proved read to', render: (b) => <span className={d.num}>{BigInt(b.nextBlock) > BigInt(b.fromBlock) ? (BigInt(b.nextBlock) - 1n).toString() : '—'}</span> },
    { key: 'found', header: 'Found', align: 'right', render: (b) => `${b.detected} in ${b.addresses} ${b.addresses === 1 ? 'address' : 'addresses'}` },
    { key: 'error', header: 'Last problem', render: (b) => <span className={d.secondary}>{b.lastError ?? 'none'}</span> },
  ];
  return <DataTable<BackfillView> caption="Backfills" columns={columns} rows={backfills} rowKey={(b) => b.ref} empty={<Empty title="No backfill requested" />} />;
}
