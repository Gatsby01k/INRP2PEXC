'use client';

import { Money, Rate } from '@inrp2p/kernel';
import type { PortalTrade } from '@inrp2p/portal';
import {
  DepositAddress,
  SettlementLegList,
  SettlementLegRow,
  SettlementProgress,
  type LegStatus,
  type TradeStage as ProgressStage,
  TradeHeader,
  TradeProgress,
  TransactionHash,
  formatIstDateTime,
} from '@inrp2p/ui';
import styles from '../../shell.module.css';

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

/**
 * The trade screen. It answers one question — where is my money — and it answers it in the order the money
 * moves: what was agreed, what has arrived, what has been paid out, and whether it is finished.
 *
 * Everything here came from the domain's client projections. There is no figure on this page the desk has not
 * already committed to, and nothing about how the desk sourced the other side of the trade (SECURITY §5).
 */
export function TradeScreen({ view }: { view: PortalTrade }) {
  const { trade, settlement } = view;
  const sell = trade.direction === 'SELL_USDT';
  const stages = view.stages.map((s) => {
    const stage: ProgressStage = { status: s.status };
    if (s.at) stage.at = new Date(s.at);
    if (s.detail) stage.detail = s.detail;
    return stage;
  }) as [ProgressStage, ProgressStage, ProgressStage, ProgressStage];

  const paid = Money.parse(settlement.paid.amount, 'INR');
  const expected = Money.parse(settlement.expected.amount, 'INR');
  const settlementCurrencyIsInr = settlement.expected.currency === 'INR';

  return (
    <>
      <TradeHeader
        audience="client"
        tradeRef={trade.ref}
        direction={trade.direction}
        base={Money.parse(trade.base.amount, 'USDT')}
        inr={Money.parse(trade.inr.amount, 'INR')}
        rate={Rate.parse(trade.clientRate, 'CLIENT')}
        startedAt={new Date(trade.openedAt)}
      />

      {view.onHold ? (
        <p className={styles.notice} role="status">
          This trade is paused while we check something. Nothing is lost — we will move it on and you will see it here.
        </p>
      ) : null}

      <div className={styles.split}>
        <div className="ix-stack">
          <TradeProgress direction={trade.direction} stages={stages} />

          {sell && trade.depositInstructions && view.incoming === null ? (
            <DepositAddress
              address={trade.depositInstructions.address}
              amount={Money.parse(trade.depositInstructions.amount, 'USDT')}
              network="TRC20"
              tradeRef={trade.ref}
            />
          ) : null}

          {settlementCurrencyIsInr && settlement.payments.length > 0 ? (
            <section className={styles.panel} aria-label="INR settlement">
              <span className={styles.sectionTitle}>INR settlement</span>
              <SettlementProgress received={paid} total={expected} />
              <SettlementLegList>
                {settlement.payments.map((p) => {
                  const status = LEG_STATUS[p.status] ?? 'PENDING';
                  return (
                    <SettlementLegRow
                      key={p.ref}
                      audience="client"
                      amount={Money.parse(p.amount, 'INR')}
                      status={status}
                      {...(p.reference ? { utr: p.reference } : {})}
                      {...(p.confirmedAt ? { at: new Date(p.confirmedAt) } : {})}
                    />
                  );
                })}
              </SettlementLegList>
            </section>
          ) : null}
        </div>

        <aside className={styles.panel} aria-label="Summary">
          <span className={styles.sectionTitle}>Summary</span>
          <div className={styles.row}>
            <span className={styles.muted}>Rate</span>
            <span className="ix-num">₹{trade.clientRate}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.muted}>Network</span>
            <span>TRC20</span>
          </div>
          <div className={styles.row}>
            <span className={styles.muted}>{sell ? 'Receive to' : 'Deliver to'}</span>
            <span>{view.destination}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.muted}>Still to come</span>
            <span className="ix-num">₹{settlement.remaining.amount}</span>
          </div>
          {view.incoming ? <TransactionHash hash={view.incoming.txHash} finality={view.incoming.state === 'CONFIRMED' ? 'Confirmed' : 'Seen, not final'} copy={false} /> : null}
          {view.completedAt ? <p className={styles.muted}>Completed {formatIstDateTime(new Date(view.completedAt))}</p> : null}
        </aside>
      </div>
    </>
  );
}
