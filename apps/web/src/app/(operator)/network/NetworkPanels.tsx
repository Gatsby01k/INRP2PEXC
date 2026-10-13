'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FunderRow, NetworkSendRow, NetworkView, TradeNetworkRow } from '@inrp2p/desk';
import { Button, CopyButton } from '@inrp2p/ui';
import { shortenAddress, shortenHash } from '@inrp2p/ui/format';
import {
  approveChainSendAction, cancelChainSendAction, decideNetworkWithdrawalAction, publishTrxRateAction, raiseChainSendCapAction, recordCustodyHdAccountAction, recordNetworkDepositAction, setNetworkFeePolicyAction,
  unblockChainSendAction,
} from '../../../server/actions/network.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { Checkbox, TextField } from '../_desk/fields.tsx';
import { ATTEMPT, PURPOSE, STATUS, isPositiveDecimal, trx } from '../_desk/network.ts';
import { dateTime, inr, usdt } from '../_desk/format.ts';
import { Chip, Empty, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

/**
 * Raising one transfer's TRX cap: the only way it draws more than was fixed when it was planned. The new cap is typed,
 * never suggested, and the reason goes to the audit; the trade's hold rises with it if it must.
 */
function RaiseCap({ send, busy, run }: { send: NetworkSendRow; busy: boolean; run: ReturnType<typeof useCommand>['run'] }) {
  const [cap, setCap] = useState('');
  return (
    <span className={d.stackTight} style={{ gap: 4 }}>
      <TextField label="New cap, TRX" value={cap} onChange={setCap} mono placeholder={send.networkCap ?? ''} />
      <GuardedAction
        label="Raise TRX cap"
        stepUp
        reasonLabel="Why it may cost more"
        minReason={10}
        disabled={!isPositiveDecimal(cap)}
        disabledReason={!isPositiveDecimal(cap) ? `Now ${send.networkCap ? trx(send.networkCap) : '—'}, ${send.networkUsed ? trx(send.networkUsed) : '0 TRX'} drawn.` : null}
        consequence={<>This transfer may draw up to {trx(cap)} of its trade’s TRX, retries included, and is decided again now. What it costs beyond the price comes out of the platform’s margin.</>}
        busy={busy}
        onConfirm={async (reason) => (await run(`Raise the TRX cap of ${send.ref}`, (k) => raiseChainSendCapAction({ sendId: send.id, cap, reason }, k))).ok}
      />
    </span>
  );
}

export function SendsTable({ sends, canApprove, canCancel, canManage, me }: { sends: readonly NetworkSendRow[]; canApprove: boolean; canCancel: boolean; canManage: boolean; me: string }) {
  const cmd = useCommand();
  const columns: Column<NetworkSendRow>[] = [
    { key: 'ref', header: 'Send', render: (s) => <Cell main={<span className={d.mono}>{s.ref}</span>} sub={PURPOSE[s.purpose] ?? s.purpose} /> },
    {
      key: 'trade',
      header: 'Trade',
      render: (s) => (s.tradeRef ? <Link href={`/orders/${encodeURIComponent(s.tradeRef)}`} className={d.link}>{s.tradeRef}</Link> : <span className={d.muted}>—</span>),
    },
    {
      key: 'amount', header: 'Amount', align: 'right',
      render: (s) => <Cell main={<strong>{s.amount}</strong>} sub={s.networkCap ? `TRX ${trx(s.networkUsed ?? '0').replace(' TRX', '')} of ${trx(s.networkCap)}` : undefined} />,
    },
    {
      key: 'route',
      header: 'From → to',
      render: (s) => (
        <span className={d.mono} title={`${s.from} → ${s.to}`}>
          {shortenAddress(s.from)} → {shortenAddress(s.to)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => (
        <Cell
          main={<Chip tone={STATUS[s.status]?.tone ?? 'neutral'}>{STATUS[s.status]?.label ?? s.status}</Chip>}
          sub={s.blockedReason ?? s.lastError ?? (s.failedAttempts > 0 ? `${s.failedAttempts} failed on chain` : `fee: ${s.bearer.toLowerCase()}`)}
        />
      ),
    },
    {
      key: 'tx',
      header: 'Transactions',
      wrap: true,
      render: (s) =>
        s.attempts.length === 0 ? (
          <span className={d.muted}>not signed</span>
        ) : (
          <span className={d.stackTight}>
            {s.attempts.map((a) => (
              <span key={a.txid} className={d.row} style={{ flexWrap: 'nowrap', gap: 6 }}>
                <Chip tone={ATTEMPT[a.status] ?? 'neutral'}>{a.status.toLowerCase()}</Chip>
                <span className={d.mono} title={a.txid}>{shortenHash(a.txid)}</span>
                <CopyButton value={a.txid} label="transaction id" />
                {a.burned ? <span className={d.secondary}>{trx(a.burned)} burned</span> : a.broadcasts > 1 ? <span className={d.secondary}>sent {a.broadcasts}×</span> : null}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'act',
      header: '',
      render: (s) => (
        <span className={d.row}>
          {s.status === 'AWAITING_APPROVAL' && canApprove ? (
            <GuardedAction
              label="Approve"
              stepUp
              disabled={s.requestedBy === me}
              disabledReason={s.requestedBy === me ? 'You asked for it; someone else approves.' : null}
              consequence={<>The signer sends {s.amount} to {shortenAddress(s.to)} as soon as the deal address has the TRX for it. It cannot be sent twice.</>}
              busy={cmd.busy}
              onConfirm={async () => (await cmd.run(`Approve ${s.ref}`, (k) => approveChainSendAction({ sendId: s.id }, k))).ok}
            />
          ) : null}
          {s.status === 'BLOCKED' && s.networkCap && canManage ? <RaiseCap send={s} busy={cmd.busy} run={cmd.run} /> : null}
          {s.status === 'BLOCKED' && canCancel ? (
            <GuardedAction
              label="Send again"
              stepUp
              reasonLabel="What changed"
              consequence="The signer decides it again now: a top-up if the address is short of TRX, then the transfer."
              busy={cmd.busy}
              onConfirm={async (reason) => (await cmd.run(`Unblock ${s.ref}`, (k) => unblockChainSendAction({ sendId: s.id, reason }, k))).ok}
            />
          ) : null}
          {['AWAITING_APPROVAL', 'PLANNED', 'AWAITING_RESOURCES', 'BLOCKED'].includes(s.status) && canCancel ? (
            <GuardedAction
              label="Cancel"
              tone="danger"
              stepUp
              reasonLabel="Reason"
              minReason={10}
              consequence={s.purpose === 'CLIENT_PAYOUT' || s.purpose === 'REFUND' ? 'No transaction of it can land. Its payout fails and its earmark goes back; a replacement is a new payout.' : 'No transaction of it can land; what it would have paid goes back to where it was.'}
              busy={cmd.busy}
              onConfirm={async (reason) => (await cmd.run(`Cancel ${s.ref}`, (k) => cancelChainSendAction({ sendId: s.id, reason }, k))).ok}
            />
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <>
      {cmd.dialog}
      <DataTable<NetworkSendRow>
        caption="Sends"
        columns={columns}
        rows={sends}
        rowKey={(s) => s.id}
        rail={(s) => (s.status === 'BLOCKED' ? 'danger' : s.status === 'AWAITING_APPROVAL' ? 'action' : null)}
        dim={(s) => s.status === 'CONFIRMED' || s.status === 'CANCELLED'}
        empty={<Empty title="Nothing sent yet" body="A USDT payout, a payment to a counterparty or a refund from a deal address appears here the moment it is due." />}
      />
    </>
  );
}

export function FundersTable({ funders }: { funders: readonly FunderRow[] }) {
  const columns: Column<FunderRow>[] = [
    { key: 'who', header: 'Funder', render: (f) => <Cell main={f.name} sub={f.traderRef ?? 'desk routes and the platform’s own mistakes'} /> },
    { key: 'dep', header: 'Deposited', align: 'right', render: (f) => trx(f.deposited) },
    { key: 'spent', header: 'Spent', align: 'right', render: (f) => trx(f.spent) },
    { key: 'held', header: 'Held for open trades', align: 'right', render: (f) => trx(f.held) },
    { key: 'flight', header: 'Topping up', align: 'right', render: (f) => trx(f.inFlight) },
    { key: 'out', header: 'Withdrawing', align: 'right', render: (f) => trx(f.withdrawing) },
    { key: 'avail', header: 'Free', align: 'right', render: (f) => <strong>{trx(f.available)}</strong> },
  ];
  return <DataTable<FunderRow> caption="Network budget by funder" columns={columns} rows={funders} rowKey={(f) => f.funder} rail={(f) => (f.available.startsWith('-') || (f.traderRef !== null && /^0(\.0+)?$/.test(f.available)) ? 'danger' : null)} />;
}

export function TradesNetworkTable({ trades }: { trades: readonly TradeNetworkRow[] }) {
  const columns: Column<TradeNetworkRow>[] = [
    { key: 'ref', header: 'Trade', render: (t) => <Cell main={<Link href={`/orders/${encodeURIComponent(t.ref)}`} className={d.link}>{t.ref}</Link>} sub={`${t.direction === 'SELL_USDT' ? 'Client sells' : 'Client buys'} · ${t.lifecycle.toLowerCase().replace(/_/g, ' ')}`} /> },
    { key: 'gross', header: 'Gross margin', align: 'right', render: (t) => inr(t.grossMargin) },
    { key: 'reward', header: 'Trader reward', align: 'right', render: (t) => inr(t.reward) },
    { key: 'fee', header: 'Network fee in price', align: 'right', render: (t) => <Cell main={inr(t.feeCharged)} sub={trx(t.feeChargedTrx)} /> },
    { key: 'spent', header: 'Network cost', align: 'right', render: (t) => <Cell main={inr(t.spentInr)} sub={`${trx(t.spentTrx)} of ${trx(t.heldTrx)} held`} /> },
    {
      key: 'net', header: 'Net', align: 'right',
      render: (t) => <Cell main={t.netProfit.startsWith('-') ? <Chip tone="danger">{inr(t.netProfit)}</Chip> : <strong>{inr(t.netProfit)}</strong>} sub={t.netFinal ? 'actual' : 'expected'} />,
    },
    { key: 'funder', header: 'TRX from', render: (t) => <Cell main={t.funder} sub={t.reimbursed ? `paid back ${inr(t.reimbursed)}` : t.holdStatus === 'ACTIVE' ? 'held' : '—'} /> },
  ];
  return <DataTable<TradeNetworkRow> caption="Trades’ network economics" columns={columns} rows={trades} rowKey={(t) => t.tradeId} empty={<Empty title="No trade on the rails yet" />} />;
}

export function WithdrawalsTable({ withdrawals, canDecide }: { withdrawals: NetworkView['withdrawals']; canDecide: boolean }) {
  const cmd = useCommand();
  type Row = NetworkView['withdrawals'][number];
  const columns: Column<Row>[] = [
    { key: 'ref', header: 'Request', render: (w) => <Cell main={<span className={d.mono}>{w.ref}</span>} sub={`${w.traderRef} · ${dateTime(w.requestedAt)}`} /> },
    { key: 'amount', header: 'TRX', align: 'right', render: (w) => <Cell main={trx(w.amount)} sub={`+ ${trx(w.fee)} fee`} /> },
    { key: 'to', header: 'To its registered wallet', render: (w) => <span className={d.mono} title={w.to}>{shortenAddress(w.to, 6, 6)}</span> },
    {
      key: 'act',
      header: '',
      render: (w) =>
        w.status === 'REQUESTED' && canDecide ? (
          <span className={d.row}>
            <GuardedAction label="Approve" stepUp consequence="The signer sends this TRX from the budget wallet to the trader’s registered wallet." busy={cmd.busy}
              onConfirm={async () => (await cmd.run(`Approve ${w.ref}`, (k) => decideNetworkWithdrawalAction({ withdrawalId: w.id, approve: true }, k))).ok} />
            <GuardedAction label="Reject" tone="danger" stepUp reasonLabel="Reason the trader sees" consequence="The request closes; the TRX stays in the trader’s deposit." busy={cmd.busy}
              onConfirm={async (reason) => (await cmd.run(`Reject ${w.ref}`, (k) => decideNetworkWithdrawalAction({ withdrawalId: w.id, approve: false, reason }, k))).ok} />
          </span>
        ) : (
          <Chip tone="brand">{w.status.toLowerCase()}</Chip>
        ),
    },
  ];
  return (
    <>
      {cmd.dialog}
      <DataTable<Row> caption="Withdrawals of network deposits" columns={columns} rows={withdrawals} rowKey={(w) => w.id} empty={<Empty title="No withdrawal waiting" />} />
    </>
  );
}

export function TrxPriceForm({ current }: { current: string | null }) {
  const cmd = useCommand();
  const [price, setPrice] = useState(current ?? '');
  const [source, setSource] = useState('');
  const [confirm, setConfirm] = useState(false);
  const ok = isPositiveDecimal(price) && source.trim().length >= 2;
  return (
    <div className={d.stackTight}>
      {cmd.dialog}
      <div className={d.row} style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: '0 1 180px' }}>
          <TextField label="USDT per TRX" value={price} onChange={setPrice} mono placeholder="0.300000" />
        </div>
        <div style={{ flex: '1 1 280px', maxWidth: 420 }}>
          <TextField label="Where it was read" value={source} onChange={setSource} placeholder="Binance TRX/USDT, 14:05 IST" />
        </div>
        <Button size="sm" intent="primary" disabled={!ok || cmd.busy} onClick={() => cmd.run('Publish the TRX price', (k) => publishTrxRateAction({ usdtPerTrx: price, source: source.trim(), confirmLargeChange: confirm }, k))}>
          Publish
        </Button>
      </div>
      <Checkbox label="It moved more than tenfold, and that is right" checked={confirm} onChange={setConfirm} />
      {cmd.error ? <span className={d.fieldError}>{cmd.error}</span> : null}
    </div>
  );
}

export function DepositForm() {
  const cmd = useCommand();
  const [hash, setHash] = useState('');
  const [platform, setPlatform] = useState(false);
  const ok = /^(0x)?[0-9a-fA-F]{64}$/.test(hash.trim());
  return (
    <div className={d.stackTight}>
      {cmd.dialog}
      <div className={d.row} style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 360px', maxWidth: 640 }}>
          <TextField label="Transaction hash" value={hash} onChange={setHash} mono placeholder="TRX transfer into the budget wallet" />
        </div>
        <Button size="sm" disabled={!ok || cmd.busy} onClick={() => cmd.run('Record the TRX deposit', (k) => recordNetworkDepositAction({ txHash: hash.trim(), platform }, k))}>
          Record
        </Button>
      </div>
      <Checkbox label="This is the platform’s own top-up (no trader sent it)" checked={platform} onChange={setPlatform} />
      {cmd.error ? <span className={d.fieldError}>{cmd.error}</span> : null}
    </div>
  );
}

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * Registering the exchange's HD wallet, once. The account key is the web app's own (shown, never typed); the budget
 * wallet and the pool's record address are the ones `scripts/custody-seed.ts new` printed for the same seed.
 */
export function RegisterHdWallet({ xpub }: { xpub: string | null }) {
  const cmd = useCommand();
  const [budget, setBudget] = useState('');
  const [pool, setPool] = useState('');
  const ok = xpub !== null && TRON_ADDRESS.test(budget.trim()) && TRON_ADDRESS.test(pool.trim()) && budget.trim() !== pool.trim();
  if (!xpub) {
    return <Notice tone="warning" icon="lock">The web app has no account key: set INRP2P_CUSTODY_CAPABILITY=DERIVED and INRP2P_CUSTODY_XPUB (from scripts/custody-seed.ts) and redeploy.</Notice>;
  }
  return (
    <div className={d.stackTight}>
      {cmd.dialog}
      <div className={d.stackTight} style={{ gap: 4 }}>
        <span className={d.fieldLabel}>Account key — this deployment’s INRP2P_CUSTODY_XPUB</span>
        <span className={d.row} style={{ alignItems: 'center' }}>
          <span className={d.mono} style={{ overflowWrap: 'anywhere' }}>{xpub}</span>
          <CopyButton value={xpub} label="account key" />
        </span>
      </div>
      <TextField label="Network budget wallet" value={budget} onChange={setBudget} mono placeholder="T… printed by custody-seed as the budget wallet" />
      <TextField label="Deal-address pool record address" value={pool} onChange={setPool} mono placeholder="T… printed by custody-seed as the pool record address" />
      <GuardedAction
        label="Register the HD wallet"
        trigger="primary"
        stepUp
        disabled={!ok || cmd.busy}
        disabledReason={!ok ? 'Both addresses, as custody-seed printed them.' : null}
        consequence="From now on every new trade gets its own address derived from this key, and the worker signs only with the seed of this wallet. It is recorded once and never replaced in place."
        busy={cmd.busy}
        onConfirm={async () => (await cmd.run('Register the HD wallet', (k) => recordCustodyHdAccountAction({ feeWalletAddress: budget.trim(), depositPoolAddress: pool.trim() }, k))).ok}
      />
      {cmd.error ? <span className={d.fieldError}>{cmd.error}</span> : null}
    </div>
  );
}

export function SignerSwitch({ on, canSet }: { on: boolean; canSet: boolean }) {
  const cmd = useCommand();
  if (!canSet) return <Chip tone={on ? 'success' : 'danger'}>{on ? 'Signer on' : 'Signer off'}</Chip>;
  return (
    <>
      {cmd.dialog}
      <GuardedAction
        label={on ? 'Stop the signer' : 'Start the signer'}
        tone={on ? 'danger' : 'neutral'}
        stepUp
        reasonLabel="Reason"
        minReason={10}
        consequence={on ? 'Nothing new is signed. Transactions already broadcast are still followed to their end.' : 'Due sends are fuelled and signed again.'}
        busy={cmd.busy}
        onConfirm={async (reason) => (await cmd.run(on ? 'Stop the signer' : 'Start the signer', (k) => setNetworkFeePolicyAction({ autoSendEnabled: !on, reason }, k))).ok}
      />
    </>
  );
}

export { usdt };
