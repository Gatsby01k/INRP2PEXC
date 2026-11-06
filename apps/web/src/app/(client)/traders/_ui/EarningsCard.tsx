import type { EarningsView } from '@inrp2p/traders';
import { inr, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * What the trader has done with INRP2P. A trader earns on its own rate (ADR 0019): INRP2P pays it nothing and never turns
 * that rate into a "profit" here, so this is its completed volume and no more.
 */
export function EarningsCard({ earnings }: { earnings: EarningsView }) {
  return (
    <section className={shell.card} aria-labelledby="earnings-title">
      <h2 id="earnings-title" className={shell.cardTitle}>
        Completed volume
      </h2>
      <dl className={styles.numbers}>
        <div className={styles.wideNumber}>
          <dt>Total</dt>
          <dd data-big="">
            {usdt(earnings.completedUsdt)} · {inr(earnings.completedInr)}
          </dd>
        </div>
      </dl>
      <p className={styles.note}>You earn on your own rate. INRP2P holds the USDT in escrow and takes nothing from your rupees.</p>
    </section>
  );
}
