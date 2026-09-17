import type React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ActionQueue, Button, CapacityMeter, DepositPoolStatus, ExceptionBanner, MoneyInput, PayerSelector, PnlSummary, RateComparison, RateDisplay,
  RoutePositionRow, SettlementLegList, SettlementLegRow, SettlementProgress, TradeHeader, TradeTable, TransactionHash, UTRField, formatInr, type QueueGroup,
} from '../index.ts';
import { CANONICAL_SELL, NOW, TRADE_REF, TX_HASH, at, clientRate, inr, routeRate, usdt } from '../fixtures.ts';
import { OperatorNav, Strip } from './nav.tsx';
import styles from './Validation.module.css';

const meta = { title: 'Validation/Operator Desk', parameters: { layout: 'fullscreen', density: 'compact' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const STRIP: [string, string][] = [
  ['USDT→INR route', '₹104.20'],
  ['INR→USDT route', '₹100.00'],
  ['INR available', '₹18.4M'],
  ['USDT available', '1,200,220'],
  ['Open trades', '7'],
  ['Gross margin today · realized', '+₹612,400'],
];
const queue: QueueGroup[] = [
  { key: 'needs_action', items: [
    { id: '1', client: 'Acme Pay', amount: 'SELL 100,000 USDT', asks: '102.00', route: '104.20', margin: '+₹220,000', status: 'New request', action: { label: 'Quote', shortcut: 'Q', onAction: noop } },
    { id: '2', client: 'Nova OTC', amount: 'SELL 45,000 USDT', route: '104.20', status: 'USDT confirmed', action: { label: 'Create INR payout', shortcut: 'P', onAction: noop } },
  ] },
  { key: 'settlement', items: [{ id: '4', client: 'Kite FX', amount: 'SELL 250,000 USDT', asks: '102.10', route: '104.30', margin: '+₹550,000', status: '₹14.5M / ₹25.5M', action: { label: 'Add UTR', shortcut: 'U', onAction: noop } }] },
  { key: 'waiting_client', items: [{ id: '5', client: 'Delta Pay', amount: 'SELL 60,000 USDT', asks: '102.05', status: 'Quote sent · expires 02:48', action: { label: 'Copy link', onAction: noop } }] },
  { key: 'processing', items: [{ id: '6', client: 'Sigma', amount: 'SELL 100,000 USDT', status: 'USDT detected · awaiting solidification' }] },
  { key: 'exception', items: [{ id: '7', client: 'Zen Pay', amount: 'SELL 100,000 USDT', status: 'Short by 50 USDT', action: { label: 'Resolve', shortcut: 'E', onAction: noop } }] },
];

function Shell({ active, panel, children }: { active: Parameters<typeof OperatorNav>[0]['active']; panel?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`${styles.desk} ${panel ? '' : styles.deskNoPanel}`}>
      <OperatorNav active={active} />
      <main className={styles.stack}>{children}</main>
      {panel ? <aside className={styles.panel}>{panel}</aside> : null}
    </div>
  );
}

export const Desk: Story = { render: () => <Shell active="Desk"><Strip items={STRIP} /><ActionQueue groups={queue} /></Shell> };

export const NewRequestQuoteCreation: Story = {
  render: () => (
    <Shell active="Desk" panel={
      <>
        <span className={styles.sectionTitle}>Quote · Acme Pay · SELL</span>
        <MoneyInput label="Client rate" currency="INR" value="102.00" onChange={noop} hint="Client target ₹102.00 · route ₹104.20" suffix="/ USDT" />
        <RateComparison audience="operator" clientRate={clientRate('102.00')} routeRate={routeRate('104.20')} economics={CANONICAL_SELL} />
        <div className={styles.row}><Button intent="ghost">Decline</Button><Button intent="secondary">Copy link · 3:00</Button><Button intent="primary">Send quote</Button></div>
      </>
    }>
      <Strip items={STRIP} />
      <ActionQueue groups={queue.slice(0, 1)} />
    </Shell>
  ),
};

export const TradeProcessingPartialSettlement: Story = {
  render: () => (
    <Shell active="Orders" panel={
      <>
        <span className={styles.sectionTitle}>New payout leg</span>
        <SettlementProgress received={inr('4500000')} inFlight={inr('2500000')} total={CANONICAL_SELL.clientInr} />
        <PayerSelector value="EXCHANGE_ACCOUNT" onChange={noop} executionMode="DIRECT_TO_CLIENT" />
        <CapacityMeter accountLabel="ICICI · Company B" capacity={inr('10000000')} used={inr('2400000')} reserved={inr('1500000')} status="ACTIVE" />
        <MoneyInput label="Amount" currency="INR" value="2000000" onChange={noop} hint="Max ₹3,200,000 unallocated" />
        <UTRField value="AXISR52026091609921" onChange={noop} check="available" />
        <div className={styles.row}><Button intent="secondary">Reserve & create leg</Button><Button intent="primary">Confirm payout</Button></div>
      </>
    }>
      <TradeHeader audience="operator" clientName="Acme Pay" tradeRef={TRADE_REF} direction="SELL_USDT" base={CANONICAL_SELL.base} inr={CANONICAL_SELL.clientInr} rate={clientRate('102.00')} startedAt={NOW} />
      <TransactionHash hash={TX_HASH} finality="Solidified · 100,000.000000 USDT confirmed" />
      <SettlementLegList>
        <SettlementLegRow audience="operator" legRef="L1" payer="EXCHANGE_ACCOUNT" sourceLabel="HDFC · Company A" amount={inr('2000000')} status="COMPLETED" utr="HDFCR52026091617118" at={at(1200)} />
        <SettlementLegRow audience="operator" legRef="L2" payer="EXCHANGE_ACCOUNT" sourceLabel="ICICI · Company B" amount={inr('2500000')} status="COMPLETED" utr="ICICR52026091614412" at={at(1500)} />
        <SettlementLegRow audience="operator" legRef="L3" payer="EXCHANGE_ACCOUNT" sourceLabel="ICICI · Company B" amount={inr('2500000')} status="PROCESSING" />
      </SettlementLegList>
    </Shell>
  ),
};

export const ExceptionTrade: Story = {
  render: () => (
    <Shell active="Orders">
      <TradeHeader audience="operator" clientName="Zen Pay" tradeRef="IX-260916-1811" direction="SELL_USDT" base={CANONICAL_SELL.base} inr={CANONICAL_SELL.clientInr} rate={clientRate('102.00')} startedAt={NOW} />
      <ExceptionBanner severity="blocking" title="Short by 50 USDT" description="Received 99,950.000000 USDT to this trade's deposit address. Payout is on hold until resolved." action={<Button intent="secondary" size="sm">Resolve</Button>} />
      <div className={styles.row} style={{ justifyContent: 'flex-start' }}>
        <Button intent="secondary">Wait for top-up</Button>
        <Button intent="secondary">Adjust trade to received · approval</Button>
        <Button intent="danger">Refund & cancel · two-person</Button>
      </div>
    </Shell>
  ),
};

export const Rates: Story = {
  render: () => (
    <Shell active="Rates">
      <div className={styles.grid3}>
        <section className={styles.panel} aria-label="USDT to INR route"><span className={styles.sectionTitle}>USDT → INR</span><RateDisplay rate={routeRate('104.20')} size="lg" /><span className={styles.muted}>Previous ₹104.00 · updated 16:42 IST · available 780,000 USDT</span><Button intent="primary">Update route rate</Button></section>
        <section className={styles.panel} aria-label="INR to USDT route"><span className={styles.sectionTitle}>INR → USDT</span><RateDisplay rate={routeRate('100.00')} size="lg" /><span className={styles.muted}>Previous ₹100.10 · updated 15:05 IST · available 420,000 USDT</span><Button intent="primary">Update route rate</Button></section>
        <section className={styles.panel} aria-label="Reference"><span className={styles.sectionTitle}>Reference</span><RateDisplay rate={routeRate('103.85')} state="indicative" label="Reference" size="lg" /><span className={styles.muted}>External feed · display only</span></section>
      </div>
      <span className={styles.sectionTitle}>Route positions</span>
      <RoutePositionRow audience="operator" tradeRef={TRADE_REF} routeName="Route A" executionMode="DIRECT_TO_CLIENT" status="PARTIALLY_SETTLED" routeDelivers={{ total: inr('10420000'), allocated: inr('10200000'), note: '₹10,200,000 direct to client' }} exchangeDelivers={{ total: usdt('100000'), allocated: usdt('0') }} />
    </Shell>
  ),
};

export const InrAccounts: Story = {
  render: () => (
    <Shell active="INR">
      <div className={styles.grid3}>
        <CapacityMeter accountLabel="HDFC · Company A" capacity={inr('2500000')} used={inr('1700000')} reserved={inr('0')} status="ACTIVE" />
        <CapacityMeter accountLabel="ICICI · Company B" capacity={inr('10000000')} used={inr('2400000')} reserved={inr('1500000')} status="ACTIVE" />
        <CapacityMeter accountLabel="Axis · Company C" capacity={inr('5000000')} used={inr('900000')} reserved={inr('0')} status="PAUSED" />
      </div>
    </Shell>
  ),
};

export const UsdtTreasury: Story = {
  render: () => (
    <Shell active="USDT">
      <Strip items={[['Observed', '1,840,220 USDT'], ['Reserved', '640,000'], ['Available', '1,200,220'], ['Incoming', '315,000'], ['Outgoing', '230,000'], ['Today received', '2.1M'], ['Today sent', '1.7M']]} />
      <DepositPoolStatus capability="POOL" provider="Custody provider" available={48} assigned={7} cooldown={31} lowThreshold={20} />
    </Shell>
  ),
};

export const Clients: Story = {
  render: () => (
    <Shell active="Clients">
      <TradeTable
        caption="Dealer book"
        rowKey={(r) => r.client}
        columns={[
          { key: 'client', header: 'Client', render: (r) => r.client },
          { key: 'contact', header: 'Contact', render: (r) => r.contact },
          { key: 'typical', header: 'Typical volume', numeric: true, render: (r) => r.typical },
          { key: 'last', header: 'Last rate', numeric: true, render: (r) => r.last },
          { key: 'vol', header: 'Completed volume', numeric: true, render: (r) => r.vol },
          { key: 'margin', header: 'Margin generated', numeric: true, render: (r) => r.margin },
          { key: 'when', header: 'Last trade', render: (r) => r.when },
          { key: 'actions', header: 'Actions', render: () => <Button intent="secondary" size="sm">Create quote</Button> },
        ]}
        rows={[
          { client: 'Acme Pay', contact: '@acmepay_desk', typical: '100,000 USDT', last: '₹102.00', vol: '1,250,000 USDT', margin: formatInr(inr('2750000')), when: 'Today 16:11' },
          { client: 'Kite FX', contact: '+91 ••••5678', typical: '250,000 USDT', last: '₹102.10', vol: '3,100,000 USDT', margin: formatInr(inr('6820000')), when: 'Today 15:40' },
          { client: 'Orbit Ltd', contact: 'ops@orbit.example', typical: '20,000 USDT', last: '₹101.10', vol: '180,000 USDT', margin: formatInr(inr('198000')), when: 'Yesterday' },
        ]}
      />
    </Shell>
  ),
};

export const ProfitAndLoss: Story = {
  render: () => (
    <Shell active="P&L">
      <PnlSummary periodLabel="Today · 16 Sep 2026" realizedMargin={inr('612400')} completedVolume={usdt('290000')} completedTrades={4} openExpectedMargin={inr('1012000')} openTrades={7} />
    </Shell>
  ),
};
