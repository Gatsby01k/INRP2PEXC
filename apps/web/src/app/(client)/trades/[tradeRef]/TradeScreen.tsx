'use client';

import Link from 'next/link';
import { Money, Rate } from '@inrp2p/kernel';
import type { PortalTrade } from '@inrp2p/portal';
import { DepositAddress, type LegStatus, SettlementLegList, SettlementLegRow, SettlementProgress, TransactionHash } from '@inrp2p/ui';
import { formatInr, formatIstDateTime, formatRate, formatUsdtHeadline, shortenHash } from '@inrp2p/ui/format';
import { AssistantPanel } from '../../_assistant/AssistantPanel.tsx';
import { type Step, at, tradeAssistant } from '../../_assistant/model.ts';
import { InfoIcon, ReceiptIcon } from '../../_workspace/icons.tsx';
import { Stepper } from '../../_workspace/Stepper.tsx';
import shell from '../../shell.module.css';
import styles from './trade.module.css';

const LEG_STATUS: Record<string, LegStatus> = {
  DRAFT: 'PENDING',
  PENDING: 'PENDING',
  SENT: 'PROCESSING',
  PROCESSING: 'PROCESSING',
  EVIDENCE_RECORDED: 'PROCESSING',
  CONFIRMED: 'COMPLETED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const STAGE_LABELS = {
  SELL_USDT: ['Quote accepted', 'USDT received', 'INR payout', 'Completed'],
  BUY_USDT: ['Quote accepted', 'INR received', 'USDT sent', 'Completed'],
} as const;

/** The portal's four stages, labelled for the direction; a cancelled trade stops at the stage it was waiting on. */
function stepsOf(view: PortalTrade): Step[] {
  const cancelled = view.trade.status === 'CANCELLED';
  return view.stages.map((s, i) => {
    const label = STAGE_LABELS[view.trade.direction][i] ?? s.key;
    if (cancelled && s.status === 'current') return { label, status: 'exception' as const, detail: 'cancelled' };
    const detail = s.detail ?? (s.status === 'done' && s.at ? formatIstDateTime(new Date(s.at)).split(', ')[1] : undefined);
    return { label, status: s.status, ...(detail ? { detail } : {}) };
  });
}

/**
 * The trade screen. It answers one question — where is my money — in the order the money moves: how far it has
 * got, what the client has to do (if anything), what has been paid out, and what was agreed.
 *
 * Everything here came from the domain's client projections. There is no figure on this page the desk has not
 * already committed to, and nothing about how the desk sourced the other side of the trade (SECURITY §5).
 */
export function TradeScreen({ view }: { view: PortalTrade }) {
  const { trade, settlement } = view;
  const sell = trade.direction === 'SELL_USDT';
  const usdt = formatUsdtHeadline(Money.parse(trade.base.amount, 'USDT'));
  const inr = formatInr(Money.parse(trade.inr.amount, 'INR'));
  const inrSettlement = settlement.expected.currency === 'INR';
  const receipt = `/api/receipts/${encodeURIComponent(trade.ref)}`;

  return (
    <>
      <main className={shell.main} data-robot-target="panel">
        {view.onHold ? (
          <p className={shell.info} data-tone="warning" role="status">
            <InfoIcon className={shell.infoIcon} />
            <span>This trade is paused while we check something. Nothing is lost — we will move it on and you will see it here.</span>
          </p>
        ) : null}

        <section className={shell.card} aria-labelledby="progress-title">
          <div className={shell.cardHead}>
            <h2 id="progress-title" className={shell.cardTitle}>
              Progress
            </h2>
            {view.completedAt ? <span className={shell.muted}>Settled {at(view.completedAt)}</span> : null}
          </div>
          <Stepper steps={stepsOf(view)} label="Trade progress" />
          {view.incoming ? (
            <div className={styles.transfer}>
              <span className={shell.label}>Your transfer</span>
              <TransactionHash hash={view.incoming.txHash} finality={view.incoming.state === 'CONFIRMED' ? 'Confirmed' : 'Seen, not final'} copy={false} />
            </div>
          ) : null}
        </section>

        {sell && trade.depositInstructions && view.incoming === null && trade.status !== 'CANCELLED' ? (
          <section className={shell.card} aria-labelledby="deposit-title">
            <h2 id="deposit-title" className={shell.cardTitle}>
              Send your USDT
            </h2>
            <DepositAddress
              address={trade.depositInstructions.address}
              amount={Money.parse(trade.depositInstructions.amount, 'USDT')}
              network="TRC20"
              tradeRef={trade.ref}
            />
          </section>
        ) : null}

        {settlement.payments.length > 0 ? (
          inrSettlement ? (
            <section className={shell.card} aria-label="INR settlement">
              <h2 className={shell.cardTitle}>INR payout</h2>
              <SettlementProgress received={Money.parse(settlement.paid.amount, 'INR')} total={Money.parse(settlement.expected.amount, 'INR')} />
              <SettlementLegList>
                {settlement.payments.map((p) => (
                  <SettlementLegRow
                    key={p.ref}
                    audience="client"
                    amount={Money.parse(p.amount, 'INR')}
                    status={LEG_STATUS[p.status] ?? 'PENDING'}
                    {...(p.reference ? { utr: p.reference } : {})}
                    {...(p.confirmedAt ? { at: new Date(p.confirmedAt) } : {})}
                  />
                ))}
              </SettlementLegList>
            </section>
          ) : (
            <section className={shell.card} aria-label="USDT delivery">
              <h2 className={shell.cardTitle}>USDT delivery</h2>
              <ul className={styles.deliveries}>
                {settlement.payments.map((p) => (
                  <li key={p.ref}>
                    <span className="ix-num">{formatUsdtHeadline(Money.parse(p.amount, 'USDT'))}</span>
                    <span className={shell.muted}>{LEG_STATUS[p.status] === 'COMPLETED' ? 'Delivered' : LEG_STATUS[p.status] === 'PROCESSING' ? 'On its way' : 'Pending'}</span>
                    {p.reference ? <span className="ix-num">{shortenHash(p.reference)}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )
        ) : null}

        <section className={shell.card} aria-labelledby="details-title">
          <h2 id="details-title" className={shell.cardTitle}>
            What was agreed
          </h2>
          <div className={styles.details}>
            <dl className={shell.facts}>
              <div>
                <dt>{sell ? 'You sell' : 'You pay'}</dt>
                <dd className="ix-num">{sell ? usdt : inr}</dd>
              </div>
              <div>
                <dt>You receive</dt>
                <dd className="ix-num">{sell ? inr : usdt}</dd>
              </div>
              <div>
                <dt>Rate</dt>
                <dd className="ix-num">{formatRate(Rate.parse(trade.clientRate, 'CLIENT'))} / USDT</dd>
              </div>
            </dl>
            <dl className={shell.facts}>
              <div>
                <dt>{sell ? 'INR to' : 'USDT to'}</dt>
                <dd>{view.destination}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>USDT on TRC20</dd>
              </div>
              <div>
                <dt>Still to come</dt>
                <dd className="ix-num">
                  {inrSettlement ? formatInr(Money.parse(settlement.remaining.amount, 'INR')) : formatUsdtHeadline(Money.parse(settlement.remaining.amount, 'USDT'))}
                </dd>
              </div>
            </dl>
          </div>
          {view.receipt ? (
            <div className={styles.receipt}>
              <ReceiptIcon className={styles.receiptIcon} />
              <span>Settlement receipt</span>
              <a className={shell.textAction} href={receipt} target="_blank" rel="noreferrer">
                View
              </a>
              <a className={shell.textAction} href={`${receipt}?format=pdf`} download>
                PDF
              </a>
            </div>
          ) : null}
        </section>
      </main>
      <AssistantPanel state={tradeAssistant(view)}>
        <div className={styles.noteLinks}>
          <Link className={shell.textAction} href="/history">
            All trades
          </Link>
        </div>
      </AssistantPanel>
    </>
  );
}
