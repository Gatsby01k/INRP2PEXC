import type { ClientRate, Direction, Money } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatInr, formatRate, formatUsdtHeadline } from '../../format/money.ts';
import { ArcLoader } from '../ArcLoader/ArcLoader.tsx';
import { Button } from '../Button/Button.tsx';
import { QuoteCountdown } from '../QuoteCountdown/QuoteCountdown.tsx';
import styles from './FirmQuote.module.css';

export type FirmQuoteState = 'REQUESTING' | 'QUOTE_AVAILABLE' | 'LOCKED' | 'EXPIRING' | 'ACCEPTED' | 'EXPIRED' | 'UNAVAILABLE';

/**
 * Client-facing firm quote. The props type has no route rate, margin or provider fields:
 * the client projection cannot carry them (PRODUCT §10.2).
 */
export interface FirmQuoteProps {
  state: FirmQuoteState;
  direction: Direction;
  base: Money<'USDT'>;
  inr: Money<'INR'>;
  rate: ClientRate;
  network: 'TRC20';
  destinationLabel: string;
  expiresAt?: Date;
  validityMs?: number;
  now?: Date;
  settlementNote?: string;
  onAccept?: () => void;
  onDecline?: () => void;
  onRequestNew?: () => void;
  busy?: boolean;
}

export function FirmQuote(props: FirmQuoteProps) {
  const { state, direction, base, inr, rate, destinationLabel, expiresAt, validityMs, now, busy } = props;
  const sell = direction === 'SELL_USDT';
  const priced = state !== 'REQUESTING' && state !== 'UNAVAILABLE';
  const actionable = state === 'QUOTE_AVAILABLE' || state === 'LOCKED' || state === 'EXPIRING';

  return (
    <section className={cx(styles.root, styles[state.toLowerCase()])} aria-live="polite" aria-label="Firm quote">
      <div className={styles.leg}>
        <span className={styles.caption}>{sell ? 'You sell' : 'You receive'}</span>
        <span className={cx(styles.amount, 'ix-num')}>{formatUsdtHeadline(base, { unit: false })}</span>
        <span className={styles.unit}>USDT · {props.network}</span>
      </div>

      <div className={styles.leg}>
        <span className={styles.caption}>{sell ? 'You receive' : 'You pay'}</span>
        <span className={cx(styles.amount, styles.inr, 'ix-num')}>{priced ? formatInr(inr) : '₹ —'}</span>
      </div>

      <div className={styles.lock}>
        {state === 'REQUESTING' ? (
          <span className={styles.requesting}>
            <ArcLoader size="md" label="Desk is pricing your request" />
            <span>Desk is pricing your request</span>
          </span>
        ) : state === 'UNAVAILABLE' ? (
          <p className={styles.unavailable}>No firm quote is available right now. The desk has your request.</p>
        ) : (
          <>
            <span className={cx(styles.rate, 'ix-num', state === 'EXPIRED' && styles.struck)}>{formatRate(rate)}</span>
            <span className={styles.rateUnit}>/ USDT</span>
            {state === 'ACCEPTED' ? (
              <span className={styles.accepted}>Accepted · rate locked into your trade</span>
            ) : expiresAt && validityMs ? (
              <QuoteCountdown expiresAt={expiresAt} validityMs={validityMs} {...(now ? { now } : {})} />
            ) : null}
          </>
        )}
      </div>

      <dl className={styles.meta}>
        <div>
          <dt>{sell ? 'Receive to' : 'Deliver to'}</dt>
          <dd>{destinationLabel}</dd>
        </div>
        {props.settlementNote ? (
          <div>
            <dt>Settlement</dt>
            <dd>{props.settlementNote}</dd>
          </div>
        ) : null}
      </dl>

      <div className={styles.actions}>
        {actionable ? (
          <>
            <Button intent="primary" size="lg" fullWidth onClick={props.onAccept} loading={Boolean(busy)}>
              Accept quote
            </Button>
            {props.onDecline ? (
              <Button intent="ghost" onClick={props.onDecline}>
                Not now
              </Button>
            ) : null}
          </>
        ) : state === 'EXPIRED' ? (
          <Button intent="primary" size="lg" fullWidth onClick={props.onRequestNew}>
            Get new quote
          </Button>
        ) : null}
      </div>
    </section>
  );
}
