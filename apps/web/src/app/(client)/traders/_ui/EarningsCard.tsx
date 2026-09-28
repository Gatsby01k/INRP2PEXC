import type { EarningsView } from '@inrp2p/traders';
import { inr, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * What INRP2P pays the trader, and nothing it does not. The reward is an explicit rate the desk sets, fixed on each
 * order when it starts and earned when it completes; the trader's own rate is its business and is not turned into a
 * "profit" here. With no reward configured, the card says so and shows only volume.
 */
export function EarningsCard({ earnings }: { earnings: EarningsView }) {
  const rewarded = earnings.rewardBps !== null && earnings.rewardBps > 0;
  const paid = /[1-9]/.test(earnings.paidOut);
  return (
    <section className={shell.card} aria-labelledby="earnings-title">
      <h2 id="earnings-title" className={shell.cardTitle}>
        Earnings
      </h2>
      <dl className={styles.numbers}>
        <div>
          <dt>Today</dt>
          <dd data-big="">{inr(earnings.today)}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd data-big="">{inr(earnings.available)}</dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>{inr(earnings.pending)}</dd>
        </div>
        <div>
          <dt>Being paid out</dt>
          <dd>{inr(earnings.payingOut)}</dd>
        </div>
        <div className={styles.wideNumber}>
          <dt>Total completed volume</dt>
          <dd>
            {usdt(earnings.completedUsdt)} · {inr(earnings.completedInr)}
          </dd>
        </div>
      </dl>
      <p className={styles.note}>
        {rewarded
          ? `INRP2P pays a reward of ${(earnings.rewardBps! / 100).toString()}% of each order’s INR value when the order completes. Pending is what your open orders will earn. Available is paid to your registered bank account by the desk.`
          : 'INRP2P does not pay a reward on orders at the moment. Your rate is your own.'}
        {paid ? ` Paid out so far: ${inr(earnings.paidOut)}.` : ''}
      </p>
    </section>
  );
}
