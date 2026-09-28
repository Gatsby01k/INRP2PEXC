'use client';

import { useId, useState } from 'react';
import type { OrderSummary } from '@inrp2p/traders';
import { ArcLoader } from '@inrp2p/ui';
import { formatCountdown, formatIstTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { acceptOrderAction, declineOrderAction } from '../../../../server/actions/traders.ts';
import { playSound } from '../../_assistant/sound.ts';
import { ClockIcon } from '../../_workspace/icons.tsx';
import { inr, rate, sentence, sideTitle, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * A new order, offered privately: what it is, at the trader's own rate, how it settles and where the trader receives —
 * and the two answers. The time to respond is the backend's real offer expiry, counted on the server's clock; when
 * it runs out the buttons stop, because the server has stopped honouring them.
 */
export function OfferCard({
  order,
  now,
  canAct,
  receiveAt,
}: {
  order: OrderSummary;
  now: number;
  canAct: boolean;
  /** Where the trader receives on this order: its own registered wallet (Buy USDT) or bank account (Sell USDT). */
  receiveAt: string;
}) {
  const { run, busy, error, dialog } = useCommand();
  const [declining, setDeclining] = useState(false);
  const titleId = useId();
  const buy = order.side === 'BUY_USDT';
  const remaining = Date.parse(order.offerExpiresAt) - now;
  const expired = remaining <= 0;

  const accept = async () => {
    const out = await run(`Accept ${order.ref}`, (key) => acceptOrderAction({ ref: order.ref }, key));
    // The one sound a trader's own action earns: the order is theirs now.
    if (out.ok) playSound('success');
  };
  const decline = () => run(`Decline ${order.ref}`, (key) => declineOrderAction({ ref: order.ref }, key));

  return (
    <section className={`${shell.surface} ${styles.offer}`} aria-labelledby={titleId} data-robot-target="panel">
      <div className={styles.offerHead}>
        <p className={styles.eyebrow}>New order</p>
        <span className={styles.countdown} aria-live="off">
          <ClockIcon className={shell.infoIcon} />
          {expired ? (
            <span>This offer has expired</span>
          ) : (
            <span>
              Respond within <strong>{formatCountdown(remaining)}</strong> · until {formatIstTime(new Date(order.offerExpiresAt))}
            </span>
          )}
        </span>
      </div>
      <h2 id={titleId} className={styles.offerTitle}>
        {sideTitle(order.side)}
        <span className={styles.ref}>{order.ref}</span>
      </h2>
      <dl className={styles.terms}>
        <div>
          <dt>Amount</dt>
          <dd>
            {usdt(order.usdt)}
            <span className={styles.sub}>{buy ? `You pay ${inr(order.inr)}` : `You receive ${inr(order.inr)}`}</span>
          </dd>
        </div>
        <div>
          <dt>Your rate</dt>
          <dd>
            {rate(order.rate)}
            {order.reward ? <span className={styles.sub}>Reward on completion {inr(order.reward)}</span> : null}
          </dd>
        </div>
      </dl>
      <dl className={shell.facts}>
        <div>
          <dt>Settlement</dt>
          <dd>{buy ? 'You pay INR by bank transfer to INRP2P. INRP2P sends USDT on TRC20.' : 'You send USDT on TRC20 to INRP2P. INRP2P pays INR by bank transfer.'}</dd>
        </div>
        <div>
          <dt>You receive at</dt>
          <dd>{receiveAt}</dd>
        </div>
        <div>
          <dt>When you send</dt>
          <dd>Only after the other side is funded. You will be told when it is your turn.</dd>
        </div>
      </dl>

      {!canAct ? (
        <p className={shell.info}>Someone who can accept quotes for your account has to answer this order.</p>
      ) : declining ? (
        <div className={styles.actions}>
          <button type="button" className={shell.secondaryAction} disabled={busy || expired} onClick={() => void decline()}>
            Yes, decline
          </button>
          <button type="button" className={shell.textAction} disabled={busy} onClick={() => setDeclining(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={shell.action} disabled={busy || expired} aria-busy={busy || undefined} onClick={() => void accept()} data-robot-target="cta">
            {busy ? <ArcLoader size="sm" label="Accepting" tone="inherit" /> : null}
            <span>Accept</span>
          </button>
          <button type="button" className={shell.secondaryAction} disabled={busy || expired} onClick={() => setDeclining(true)}>
            Decline
          </button>
        </div>
      )}
      {error ? (
        <p className={shell.error} role="alert">
          {sentence(error)}
        </p>
      ) : null}
      {dialog}
    </section>
  );
}
