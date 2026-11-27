'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PaymentRow, TraderOrderDetail } from '@inrp2p/traders';
import { Money } from '@inrp2p/kernel';
import { formatInr, formatIstDateTime } from '@inrp2p/ui/format';
import { Amount } from '../../../../../components/Amount.tsx';
import { CopyButton } from '@inrp2p/ui';
import { useAssistantState } from '../../../_assistant/AssistantPanel.tsx';
import { traderOrderAssistant } from '../../../_assistant/traders.ts';
import { BackIcon, InfoIcon } from '../../../_workspace/icons.tsx';
import { DealRail } from '../../../_workspace/DealRail.tsx';
import { type Figure, Figures, Track } from '../../../_workspace/OrderSummary.tsx';
import { useServerClock } from '../../../exchange/useServerClock.ts';
import { OfferCard } from '../../_ui/OfferCard.tsx';
import { P2pOrderAction, P2pOrderChat } from './P2pOrderAction.tsx';
import { amountIn, inr, rate, usdt, usdtExact } from '../../_ui/format.ts';
import shell from '../../../shell.module.css';
import styles from '../../traders.module.css';
import trade from '../../../trades/[tradeRef]/trade.module.css';


function Payments({ title, rows, empty }: { title: string; rows: readonly PaymentRow[]; empty: string }) {
  return (
    <div className={styles.instructions}>
      <span className={shell.label}>{title}</span>
      {rows.length === 0 ? (
        <p className={styles.note}>{empty}</p>
      ) : (
        <ul className={styles.evidence}>
          {rows.map((p, i) => (
            <li key={`${p.reference ?? 'row'}:${i}`}>
              <span className={styles.orderText}>
                <span className={styles.orderMain}>{amountIn(p.currency, p.amount)}</span>
                <span className={`${styles.orderMeta} ${styles.mono}`}>{p.reference ?? '—'}</span>
              </span>
              <span className={styles.pill} data-tone={p.status === 'CONFIRMED' ? 'done' : p.status === 'FAILED' ? 'neutral' : 'waiting'}>
                <span className={styles.pillDot} aria-hidden="true" />
                {p.status === 'CONFIRMED' ? `Confirmed ${formatIstDateTime(new Date(p.at)).split(', ')[1]}` : p.status === 'FAILED' ? 'Failed' : 'Being checked'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NextAction({ detail }: { detail: TraderOrderDetail }) {
  const o = detail.order;
  const buy = o.side === 'BUY_USDT';
  const body = (() => {
    switch (o.stage) {
      case 'HELD':
        return <p className={styles.note}>Your capacity is held while the trade is confirmed with the other side{o.holdUntil ? `, until ${formatIstDateTime(new Date(o.holdUntil)).split(', ')[1]} at the latest` : ''}. Nothing to send yet.</p>;
      case 'AWAITING_FUNDING':
        return <p className={styles.note}>The trade is open. Wait until the other side’s funds are confirmed — you will be told, here and in Notifications, when it is your turn.</p>;
      case 'CHECKING_YOURS':
        return <p className={styles.note}>{buy ? 'INRP2P is checking your payment against its bank account.' : 'Your USDT is on-chain. It counts once it is final on TRON.'}</p>;
      case 'REVIEW':
        return (
          <p className={shell.info} data-tone="warning">
            <InfoIcon className={shell.infoIcon} />
            <span>A transfer reached this order’s address from a wallet that is not your registered wallet, or more than the order needs. It was not counted; the desk is reviewing it.</span>
          </p>
        );
      case 'INRP2P_SENDING':
        return <p className={styles.note}>Your side is confirmed. INRP2P is sending {buy ? `${usdt(o.usdt)} to your registered wallet` : `${inr(o.inr)} to your registered bank account`}.</p>;
      case 'CHECKING_INRP2P':
        return <p className={styles.note}>INRP2P’s payment to you is recorded and being confirmed.</p>;
      case 'COMPLETED':
        return <p className={styles.note}>Settled in full on both sides.</p>;
      default:
        return <p className={styles.note}>{o.closeNote ?? 'Nothing is held for this order.'}</p>;
    }
  })();
  const title: Record<string, string> = {
    HELD: 'Waiting for confirmation',
    AWAITING_FUNDING: 'Waiting for the other side',
    CHECKING_YOURS: 'Checking your payment',
    REVIEW: 'Under review',
    INRP2P_SENDING: buy ? 'Your USDT is on its way' : 'Your INR is on its way',
    CHECKING_INRP2P: 'Confirming INRP2P’s payment',
    COMPLETED: 'Completed',
    CLOSED: 'Closed',
  };
  return (
    <section className={shell.card} aria-labelledby="next-title" data-robot-target="panel">
      <span className={shell.label}>What happens now</span>
      <h2 id="next-title" className={shell.cardTitle}>
        {title[o.stage] ?? 'Order'}
      </h2>
      {body}
    </section>
  );
}

/**
 * One order: what is happening and what the trader does now, then what was agreed and every payment on it. Built
 * only from the trader projection — the other side is "the other side", never a name, a rate or a reference.
 */
/**
 * `personal` (ADR 0033): the client's own deal as the other side of a meeting — the same deal and the same steps, named
 * as a deal, started from the Exchange (never accepted here as a trader's offer), and leading back to the Exchange.
 */
export function OrderScreen({ detail, canAct, initial, personal = false }: { detail: TraderOrderDetail; canAct: boolean; initial?: string; personal?: boolean }) {
  const router = useRouter();
  const o = detail.order;
  const live = o.status === 'OFFERED' || o.status === 'ACCEPTED' || o.status === 'IN_PROGRESS';
  const now = useServerClock(detail.now, o.status === 'OFFERED');
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [live, router]);
  const buy = o.side === 'BUY_USDT';

  const status = traderOrderAssistant(detail);
  useAssistantState(status);
  // The figures as statements (the trade page's), and where the order is of its stops.
  const inrExact = formatInr(Money.parse(o.inr, 'INR'), { fraction: 'always' });
  const stopAt = detail.steps.findIndex((s) => s.status === 'current' || s.status === 'exception');
  const figures: Figure[] = [
    { label: buy ? 'You pay' : 'You sell', value: <Amount value={buy ? inrExact : usdt(o.usdt)} /> },
    { label: 'You receive', value: <Amount value={buy ? usdt(o.usdt) : inrExact} /> },
    { label: 'Rate', value: <Amount value={rate(o.rate).replace(' / USDT', '')} /> },
    ...(stopAt >= 0
      ? [
          {
            label: 'Step',
            value: (
              <>
                {stopAt + 1}
                <span className={trade.stepOf}>
                  of {detail.steps.length} · {detail.steps[stopAt]!.label}
                </span>
              </>
            ),
          },
        ]
      : []),
  ];
  const chat = detail.p2p && o.status !== 'ACCEPTED' && o.status !== 'OFFERED';

  return (
    <>
      <main className={shell.main} {...(detail.p2p ? { 'data-deal-rail': '' } : {})}>
        {o.status === 'OFFERED' && personal ? (
          <section className={shell.card} aria-label="Not started yet">
            <p className={styles.note}>
              Another client said yes to your price. Start the deal on the Exchange.{' '}
              <Link className={shell.textAction} href="/exchange">
                Open the Exchange
              </Link>
            </p>
          </section>
        ) : o.status === 'OFFERED' ? (
          <OfferCard order={o} now={now} canAct={canAct} receiveAt={detail.youReceiveAt} />
        ) : (
          <section className={`${shell.card} ${trade.hero}`} aria-label="Order summary">
            {o.p2pStep && detail.steps.length > 0 ? (
              <div className={trade.progress} role="group" aria-label="Order progress">
                <div className={trade.rail}>
                  <DealRail
                    viewer={buy ? 'buyer' : 'seller'}
                    step={o.p2pStep}
                    usdt={usdt(o.usdt)}
                    inr={inrExact}
                    label={status.title}
                    {...(initial ? { initial } : {})}
                    rail={detail.p2p?.payments.findLast((x) => x.rail)?.rail ?? null}
                  />
                </div>
                <Track steps={detail.steps} label="Stops" />
              </div>
            ) : detail.steps.length > 0 ? (
              <Track steps={detail.steps} label="Order progress" />
            ) : null}
            <Figures figures={figures} />
          </section>
        )}
        {o.status === 'OFFERED' ? null : detail.p2p && o.status !== 'ACCEPTED' ? <P2pOrderAction detail={detail} canAct={canAct} /> : <NextAction detail={detail} />}

        {o.status === 'IN_PROGRESS' || o.status === 'COMPLETED' ? (
          <section className={shell.card} aria-labelledby="evidence-title">
            <h2 id="evidence-title" className={shell.cardTitle}>
              Payments
            </h2>
            <div className={styles.twoCol}>
              <Payments title={buy ? 'Your INR' : 'Your USDT'} rows={detail.yourPayments} empty={detail.p2p && buy ? 'Your INR goes straight to the seller; it is counted when they confirm it.' : 'Nothing recorded yet.'} />
              <Payments
                title={detail.p2p ? (buy ? 'USDT from escrow' : 'INR from the buyer') : buy ? 'USDT from INRP2P' : 'INR from INRP2P'}
                rows={detail.inrp2pPayments}
                empty={detail.p2p && !buy ? 'The buyer’s INR is counted when you confirm it.' : 'Nothing sent yet.'}
              />
            </div>
          </section>
        ) : null}
      </main>

      <aside className={`${shell.aside} ${trade.side}`} aria-label="Chat and details">
        {chat ? <P2pOrderChat detail={detail} /> : null}
        {/* The order's terms are words on the paper, as a trade's details are: the page's cards are its work. */}
        <section className={trade.paper} aria-labelledby="terms-title">
          <h2 id="terms-title" className={trade.paperTitle}>
            {personal ? 'The deal' : 'The order'}
          </h2>
          <dl className={shell.facts}>
            <div>
              <dt>Reference</dt>
              <dd className={trade.refValue}>
                <span className="ix-num">{o.ref}</span>
                <CopyButton value={o.ref} label={personal ? 'deal reference' : 'order reference'} />
              </dd>
            </div>
            <div>
              <dt>Direction</dt>
              <dd>{buy ? 'You buy USDT with INR' : 'You sell USDT for INR'}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd className="ix-num">{usdtExact(o.usdt)}</dd>
            </div>
            <div>
              <dt>{buy ? 'You pay' : 'You receive'}</dt>
              <dd className="ix-num">{inr(o.inr)}</dd>
            </div>
            <div>
              <dt>Rate</dt>
              <dd className="ix-num">{rate(o.rate)}</dd>
            </div>
            <div>
              <dt>You receive at</dt>
              <dd>{detail.youReceiveAt}</dd>
            </div>
            <div>
              <dt>{personal ? 'Matched' : 'Offered'}</dt>
              <dd>{formatIstDateTime(new Date(o.offeredAt))}</dd>
            </div>
            {o.startedAt ? (
              <div>
                <dt>Started</dt>
                <dd>{formatIstDateTime(new Date(o.startedAt))}</dd>
              </div>
            ) : null}
          </dl>
          <p className={styles.note}>{detail.method}</p>
        </section>
        <div className={styles.navRow}>
          <Link className={shell.textAction} href={personal ? '/exchange' : '/traders/orders'}>
            <BackIcon />
            {personal ? 'Exchange' : 'All orders'}
          </Link>
        </div>
      </aside>
    </>
  );
}
