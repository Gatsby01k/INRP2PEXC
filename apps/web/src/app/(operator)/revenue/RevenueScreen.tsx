'use client';

import { useState } from 'react';
import type { RevenueDesk, RevenueReport, RevenueSweep } from '@inrp2p/desk';
import { Money } from '@inrp2p/kernel';
import { Button } from '@inrp2p/ui';
import { registerRevenueWalletAction, setNetworkFeePolicyAction, sweepAddressNowAction } from '../../../server/actions/network.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { Checkbox, TextField } from '../_desk/fields.tsx';
import { dateTime, usdt } from '../_desk/format.ts';
import { Chip, Empty, KpiBand, Notice, Section } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import r from './revenue.module.css';

type AddressRow = { readonly address: string; readonly earned: string; readonly free: boolean; readonly trades: number };

const SWEEP_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  CONFIRMED: { label: 'In the revenue wallet', tone: 'success' },
  SENDING: { label: 'On chain', tone: 'neutral' },
  PLANNED: { label: 'Planned', tone: 'neutral' },
  AWAITING_RESOURCES: { label: 'Being fuelled', tone: 'neutral' },
  AWAITING_APPROVAL: { label: 'Needs approval', tone: 'warning' },
  BLOCKED: { label: 'Waiting', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** `999,786.6 TRX`: TRX as a person reads it — grouped, no trailing zeros. */
const trx = (v: string): string => {
  const [whole = '0', frac = ''] = v.split('.');
  const kept = frac.replace(/0+$/, '');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${kept ? `.${kept}` : ''} TRX`;
};

/**
 * What INRP2P earned in USDT and where it is. Earnings are realized when a deal completes (the ledger's revenue); they sit
 * at the deal address until a sweep moves them — one transfer per address, from the platform's TRX — to the revenue
 * wallet. So the screen reads top to bottom: earned → where it is → what moving it costs → where it came from.
 */
export function RevenueScreen({ report, addresses, perms }: { report: RevenueReport; addresses: readonly AddressRow[]; perms: { sweep: boolean; policy: boolean; wallet: boolean } }) {
  const cmd = useCommand();
  const w = report.where;

  const addressColumns: Column<AddressRow>[] = [
    { key: 'address', header: 'Deal address', render: (a) => <Cell main={short(a.address)} sub={`${a.trades} completed deal${a.trades === 1 ? '' : 's'}`} mono /> },
    { key: 'earned', header: 'Earned there', align: 'right', render: (a) => <span className={d.num}>{usdt(a.earned)}</span> },
    {
      key: 'state', header: 'State', render: (a) =>
        !a.free ? <Chip tone="neutral">In use by a deal</Chip>
          : Money.parse(a.earned, 'USDT').minor >= Money.parse(report.policy.minUsdt, 'USDT').minor ? <Chip tone="warning">Due</Chip>
            : <Chip tone="neutral">Below {usdt(report.policy.minUsdt)}</Chip>,
    },
    {
      key: 'act', header: '', align: 'right', render: (a) =>
        perms.sweep && a.free ? (
          <Button size="sm" intent="secondary" disabled={cmd.busy} onClick={() => void cmd.run(`Sweep ${short(a.address)} to the revenue wallet`, (k) => sweepAddressNowAction({ address: a.address }, k))}>
            Sweep now
          </Button>
        ) : null,
    },
  ];

  const sweepColumns: Column<RevenueSweep>[] = [
    { key: 'ref', header: 'Sweep', render: (s) => <Cell main={s.ref} sub={short(s.address)} mono /> },
    { key: 'amount', header: 'USDT', align: 'right', render: (s) => <span className={d.num}>{usdt(s.amount)}</span> },
    {
      key: 'status', header: 'Status', render: (s) => {
        const st = SWEEP_STATUS[s.status] ?? { label: s.status, tone: 'neutral' as const };
        return <Cell main={<Chip tone={st.tone}>{st.label}</Chip>} {...(s.blockedReason ? { sub: s.blockedReason } : {})} />;
      },
    },
    { key: 'at', header: 'When', render: (s) => <span className={d.num}>{dateTime(s.closedAt ?? s.at)}</span> },
  ];

  const deskColumns: Column<RevenueDesk>[] = [
    { key: 'desk', header: 'Desk', render: (x) => <Cell main={x.name} sub={`/${x.handle}`} /> },
    { key: 'deals', header: 'Deals', align: 'right', render: (x) => <span className={d.num}>{x.deals}</span> },
    { key: 'volume', header: 'Volume', align: 'right', render: (x) => <span className={d.num}>{usdt(x.volume)}</span> },
    { key: 'fees', header: 'Platform fees', align: 'right', render: (x) => <span className={d.num}>{usdt(x.fees)}</span> },
  ];

  return (
    <div className={d.stack}>
      <KpiBand
        label="Earned in the period"
        items={[
          { key: 't', label: 'Earned', value: usdt(report.earned.total), sub: 'realized when deals completed', size: 'lg', tone: 'success' },
          { key: 'f', label: 'Platform fees', value: usdt(report.earned.platformFees), sub: 'desks’ own deals' },
          { key: 'm', label: 'INRP2P margins', value: usdt(report.earned.margins), sub: 'deals INRP2P’s desk routes' },
          { key: 's', label: 'Swept in the period', value: usdt(w.sweptInPeriod), sub: `${usdt(w.sweptAllTime)} in all` },
        ]}
      />

      <div className={r.where} aria-label="Where INRP2P’s USDT is">
        <div className={r.place}>
          <span className={d.eyebrow}>At deal addresses</span>
          <span className={r.figure}>{usdt(w.atAddresses)}</span>
          <span className={d.muted}>
            across {w.addresses} address{w.addresses === 1 ? '' : 'es'} · {w.dueAddresses} worth sweeping now
          </span>
        </div>
        <span className={r.arrow} aria-hidden="true">→</span>
        <div className={r.place} data-tone="wallet">
          <span className={d.eyebrow}>Revenue wallet</span>
          <span className={r.figure}>{usdt(w.inRevenueWallet)}</span>
          <span className={d.muted}>{report.wallet ? <span className={d.mono}>{report.wallet.label} · {short(report.wallet.address)}</span> : 'not registered yet'}</span>
        </div>
      </div>

      {!report.wallet ? <RevenueWallet canRegister={perms.wallet} /> : null}

      <Section
        title="Sweeping"
        hint={report.policy.enabled ? `An address no deal uses is swept once it holds ${usdt(report.policy.minUsdt)} of earnings, with the platform’s TRX.` : 'Off: earnings stay at their deal addresses.'}
        actions={perms.policy ? <SweepPolicy policy={report.policy} /> : null}
      >
        <KpiBand
          label="What sweeping costs"
          items={[
            { key: 'c', label: 'TRX spent on sweeps', value: trx(report.network.sweepCostTrx), sub: 'in the period, the platform’s' },
            { key: 'r', label: 'TRX reclaimed', value: trx(report.network.reclaimedTrx), sub: `${trx(report.network.reclaimedToTradersTrx)} of it back to traders` },
            {
              key: 'a', label: 'Platform TRX free', value: trx(report.network.platformAvailableTrx), sub: 'what sweeps are paid from',
              ...(Number.parseFloat(report.network.platformAvailableTrx) < 30 ? { tone: 'warning' as const } : {}),
            },
          ]}
        />
        {addresses.length === 0 ? (
          <Empty title="Nothing at the deal addresses" body="Every completed deal’s earnings are in the revenue wallet." />
        ) : (
          <DataTable caption="Earnings by deal address" columns={addressColumns} rows={addresses} rowKey={(a) => a.address} />
        )}
        {cmd.error ? (
          <Notice tone="danger" role="alert">
            {cmd.error}
          </Notice>
        ) : null}
      </Section>

      <Section title="Recent sweeps" count={report.sweeps.length}>
        {report.sweeps.length === 0 ? <Empty title="No sweep yet" /> : <DataTable caption="Recent sweeps" columns={sweepColumns} rows={report.sweeps} rowKey={(s) => s.ref} />}
      </Section>

      <Section title="Platform fees by desk" hint="Completed deals in the period.">
        {report.desks.length === 0 ? <Empty title="No desk deal completed in the period" /> : <DataTable caption="Platform fees by desk" columns={deskColumns} rows={report.desks} rowKey={(x) => x.deskId} />}
      </Section>
      {cmd.dialog}
    </div>
  );
}

/** Registering the platform's revenue wallet: an address it holds the keys of, watch-only here. */
function RevenueWallet({ canRegister }: { canRegister: boolean }) {
  const cmd = useCommand();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('INRP2P revenue');
  return (
    <Section tone="brand" title="Register the revenue wallet" hint="Where earnings are swept to. A TRON address INRP2P holds the keys of — never a deal address, never an exchange account. Nothing is swept until it is registered.">
      {canRegister ? (
        <div className={r.walletForm}>
          <TextField label="TRON address" value={address} onChange={setAddress} mono placeholder="T…" maxLength={40} />
          <TextField label="Label" value={label} onChange={setLabel} maxLength={80} />
          <Button
            intent="primary"
            size="sm"
            disabled={cmd.busy || address.trim().length < 30 || label.trim().length < 1}
            onClick={() => void cmd.run('Register the revenue wallet', (k) => registerRevenueWalletAction({ address: address.trim(), label: label.trim() }, k))}
          >
            Register
          </Button>
        </div>
      ) : (
        <Notice>Registering it needs a role with treasury:manage_wallets.</Notice>
      )}
      {cmd.error ? (
        <Notice tone="danger" role="alert">
          {cmd.error}
        </Notice>
      ) : null}
      {cmd.dialog}
    </Section>
  );
}

/** The sweep policy: on or off, from how much an address is worth it, and from how much TRX left is worth reclaiming. */
function SweepPolicy({ policy }: { policy: RevenueReport['policy'] }) {
  const cmd = useCommand();
  const [enabled, setEnabled] = useState(policy.enabled);
  const [min, setMin] = useState(policy.minUsdt.replace(/\.?0+$/, ''));
  const [reclaim, setReclaim] = useState(policy.reclaimMinTrx.replace(/\.?0+$/, ''));
  return (
    <>
      <GuardedAction
        label="Change"
        trigger="ghost"
        busy={cmd.busy}
        consequence={
          <span className={r.policyForm}>
            <Checkbox checked={enabled} onChange={setEnabled} label="Sweep earnings automatically" />
            <TextField label="Sweep an address from (USDT)" value={min} onChange={setMin} mono maxLength={12} />
            <TextField label="Reclaim TRX from (TRX)" value={reclaim} onChange={setReclaim} mono maxLength={8} />
          </span>
        }
        reasonLabel="Why"
        minReason={10}
        onConfirm={async (reason) => (await cmd.run('Change the sweep policy', (k) => setNetworkFeePolicyAction({ feeSweepEnabled: enabled, feeSweepMin: min, trxReclaimMin: reclaim, reason }, k))).ok}
      />
      {cmd.dialog}
    </>
  );
}
