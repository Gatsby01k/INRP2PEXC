import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Direction } from '@inrp2p/kernel';
import { Button, DepositAddress, DirectionToggle, FirmQuote, MoneyInput, Receipt, SettlementLegList, SettlementLegRow, SettlementProgress, TradeHeader, TradeProgress, TradeTable, TransactionHash, AcceptanceVerification, EmptyState } from '../index.ts';
import { CANONICAL_SELL, DEPOSIT_ADDRESS, NOW, TRADE_REF, TX_HASH, at, clientRate, inr, usdt } from '../fixtures.ts';
import styles from './Validation.module.css';

const meta = { title: 'Validation/Client', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Exchange() {
  const [dir, setDir] = useState<Direction>('SELL_USDT');
  const [amount, setAmount] = useState('100000');
  return (
    <div className={styles.clientColumn}>
      <DirectionToggle value={dir} onChange={setDir} />
      <MoneyInput label={dir === 'SELL_USDT' ? 'Sell' : 'Buy'} currency="USDT" size="display" suffix="USDT · TRC20" value={amount} onChange={setAmount} />
      <div className={styles.stack}>
        <span className={styles.sectionTitle}>{dir === 'SELL_USDT' ? 'You receive' : 'You pay'}</span>
        <span className={styles.muted}>₹ — · rate provided by the desk</span>
      </div>
      <div className={styles.destination}>
        <span className={styles.muted}>{dir === 'SELL_USDT' ? 'Receive to' : 'Deliver to'}</span>
        <span>{dir === 'SELL_USDT' ? 'HDFC •••• 8219' : 'TRC20 · TVq…9fA2'}</span>
      </div>
      <Button intent="primary" size="lg" fullWidth>Request quote</Button>
    </div>
  );
}

const quoteArgs = { direction: 'SELL_USDT', base: CANONICAL_SELL.base, inr: CANONICAL_SELL.clientInr, rate: clientRate('102.00'), network: 'TRC20', destinationLabel: 'HDFC •••• 8219', validityMs: 180_000, now: NOW, settlementNote: 'INR in one or more transfers, tracked per UTR' } as const;

export const ExchangeDesktop: Story = { render: () => <Exchange /> };
export const ExchangeMobile: Story = { render: () => <Exchange /> };
export const FirmQuoteLocked: Story = { render: () => <div className={styles.clientColumn}><FirmQuote {...quoteArgs} state="LOCKED" expiresAt={at(72)} /></div> };
export const ExpiredQuote: Story = { render: () => <div className={styles.clientColumn}><FirmQuote {...quoteArgs} state="EXPIRED" expiresAt={at(-1)} /></div> };

export const QuoteLinkMobile: Story = {
  render: () => (
    <div className={styles.clientColumn}>
      <span className={styles.sectionTitle}>INRP2P Exchange · Private quote Q-8F2K</span>
      <FirmQuote {...quoteArgs} state="LOCKED" expiresAt={at(118)} onAccept={() => {}} onDecline={() => {}} />
    </div>
  ),
};
export const QuoteLinkVerificationMobile: Story = {
  render: () => (
    <div className={styles.clientColumn}>
      <span className={styles.sectionTitle}>You sell 100,000 USDT · You receive ₹10,200,000</span>
      <AcceptanceVerification state="sent" intent="accept" recipients={[{ id: 'u1', masked: 'a•••@acmepay.in' }]} code="" onCodeChange={() => {}} resendInSeconds={24} onSend={() => {}} onConfirm={() => {}} onCancel={() => {}} />
    </div>
  ),
};

function TradeView({ received, statuses, stage }: { received: string; statuses: ('COMPLETED' | 'PROCESSING' | 'PENDING')[]; stage: 'awaiting' | 'payout' | 'done' }) {
  const amounts = ['2000000', '2500000', '2500000', '2000000', '1200000'];
  const utrs = ['HDFCR52026091617118', 'ICICR52026091614412', 'AXISR52026091609921', 'HDFCR52026091618830', 'ICICR52026091620417'];
  return (
    <div className={styles.clientWide}>
      <div className={styles.stack}>
        <TradeHeader audience="client" tradeRef={TRADE_REF} direction="SELL_USDT" base={CANONICAL_SELL.base} inr={CANONICAL_SELL.clientInr} rate={clientRate('102.00')} startedAt={NOW} />
        <TradeProgress
          direction="SELL_USDT"
          stages={[
            { status: 'done', at: NOW },
            stage === 'awaiting' ? { status: 'current', detail: 'waiting for USDT' } : { status: 'done', at: at(180) },
            stage === 'awaiting' ? { status: 'pending' } : stage === 'payout' ? { status: 'current' } : { status: 'done', at: at(11520) },
            stage === 'done' ? { status: 'done', at: at(11520) } : { status: 'pending' },
          ]}
        />
        {stage === 'awaiting' ? (
          <DepositAddress address={DEPOSIT_ADDRESS} amount={usdt('100000')} network="TRC20" tradeRef={TRADE_REF} />
        ) : (
          <section className={styles.panel} aria-label="INR settlement">
            <span className={styles.sectionTitle}>INR settlement</span>
            <SettlementProgress received={inr(received)} total={CANONICAL_SELL.clientInr} />
            <SettlementLegList>
              {statuses.map((s, i) => (
                <SettlementLegRow key={i} audience="client" amount={inr(amounts[i]!)} status={s} {...(s === 'COMPLETED' ? { utr: utrs[i]!, at: at(1200 + i * 2600) } : {})} />
              ))}
            </SettlementLegList>
          </section>
        )}
      </div>
      <aside className={styles.panel} aria-label="Summary">
        <span className={styles.sectionTitle}>Summary</span>
        <div className={styles.destination}><span className={styles.muted}>Rate</span><span className="ix-num">₹102.00</span></div>
        <div className={styles.destination}><span className={styles.muted}>Network</span><span>TRC20</span></div>
        <div className={styles.destination}><span className={styles.muted}>Receive to</span><span>HDFC •••• 8219</span></div>
        {stage !== 'awaiting' ? <TransactionHash hash={TX_HASH} finality="Confirmed" copy={false} /> : null}
        {stage === 'done' ? <Button intent="secondary" fullWidth>Download receipt</Button> : null}
        <Button intent="ghost" size="sm">Report a problem</Button>
      </aside>
    </div>
  );
}

export const ActiveTradeAwaitingUsdt: Story = { render: () => <TradeView received="0" statuses={[]} stage="awaiting" /> };
export const PartialInrSettlement: Story = { render: () => <TradeView received="4500000" statuses={['COMPLETED', 'COMPLETED', 'PROCESSING', 'PENDING', 'PENDING']} stage="payout" /> };
export const PartialInrSettlementMobile: Story = { ...PartialInrSettlement };
export const CompletedTrade: Story = { render: () => <TradeView received="10200000" statuses={['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']} stage="done" /> };

export const History: Story = {
  render: () => (
    <div className={styles.clientWide} style={{ gridTemplateColumns: '1fr' }}>
      <TradeTable
        caption="History"
        rowKey={(r) => r.ref}
        columns={[
          { key: 'ref', header: 'Trade', render: (r) => r.ref },
          { key: 'date', header: 'Completed', render: (r) => r.date },
          { key: 'sold', header: 'Sold', numeric: true, render: (r) => r.sold },
          { key: 'recv', header: 'Received', numeric: true, render: (r) => r.recv },
          { key: 'rate', header: 'Rate', numeric: true, render: (r) => r.rate },
          { key: 'receipt', header: 'Receipt', render: () => <Button intent="ghost" size="sm">PDF</Button> },
        ]}
        rows={[
          { ref: 'IX-260916-1842', date: '16 Sep 2026, 19:23 IST', sold: '100,000 USDT', recv: '₹10,200,000', rate: '₹102.00' },
          { ref: 'IX-260912-1204', date: '12 Sep 2026, 15:02 IST', sold: '60,000 USDT', recv: '₹6,123,000', rate: '₹102.05' },
          { ref: 'IX-260903-0911', date: '03 Sep 2026, 11:47 IST', sold: '250,000 USDT', recv: '₹25,500,000', rate: '₹102.00' },
        ]}
      />
    </div>
  ),
};
export const HistoryEmpty: Story = { render: () => <EmptyState title="No completed trades yet" body="Completed trades and their receipts appear here." /> };

export const ReceiptSettled: Story = {
  render: () => (
    <div className={styles.clientWide} style={{ gridTemplateColumns: '1fr' }}>
      <Receipt
        tradeRef={TRADE_REF}
        direction="SELL_USDT"
        base={CANONICAL_SELL.base}
        inr={CANONICAL_SELL.clientInr}
        rate={clientRate('102.00')}
        network="TRC20"
        txHash={TX_HASH}
        acceptedAt={NOW}
        completedAt={at(11520)}
        legs={[
          { amount: inr('2000000'), utr: 'HDFCR52026091617118', confirmedAt: at(1200) },
          { amount: inr('2500000'), utr: 'ICICR52026091614412', confirmedAt: at(1500) },
          { amount: inr('2500000'), utr: 'AXISR52026091609921', confirmedAt: at(4200) },
          { amount: inr('2000000'), utr: 'HDFCR52026091618830', confirmedAt: at(7800) },
          { amount: inr('1200000'), utr: 'ICICR52026091620417', confirmedAt: at(11520) },
        ]}
      />
    </div>
  ),
};
