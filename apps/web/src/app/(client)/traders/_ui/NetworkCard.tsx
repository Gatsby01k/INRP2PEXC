import Link from 'next/link';
import type { TraderNetworkView } from '@inrp2p/traders';
import { inr, isZero, trx } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * The network deposit in brief: the TRX that pays TRON for the USDT the exchange sends on this trader's orders. Its own
 * money, apart from the Security Reserve; what the client's price already paid for comes back with the rewards.
 */
export function NetworkCard({ network }: { network: TraderNetworkView }) {
  return (
    <section className={shell.card} aria-labelledby="network-title">
      <div className={shell.cardHead}>
        <h2 id="network-title" className={shell.cardTitle}>
          Network deposit
        </h2>
        <Link className={shell.textAction} href="/traders/network">
          {network.short ? 'Top up' : 'Manage'}
        </Link>
      </div>
      <dl className={styles.numbers}>
        <div className={styles.wideNumber}>
          <dt>Free for new orders</dt>
          <dd data-big="">{trx(network.available)}</dd>
        </div>
        <div>
          <dt>Held for open orders</dt>
          <dd>{trx(network.held)}</dd>
        </div>
        <div>
          <dt>Paid back with rewards</dt>
          <dd>{inr(network.repaidInrTotal)}</dd>
        </div>
      </dl>
      <p className={styles.note}>
        {network.short
          ? network.perOrderNeed
            ? `Each order holds up to ${trx(network.perOrderNeed)} until it finishes. Top up to receive new orders.`
            : 'Network fees are being updated; new orders resume shortly.'
          : network.ordersCovered !== null && !isZero(network.available)
            ? `Enough TRX for ${network.ordersCovered} more ${network.ordersCovered === 1 ? 'order' : 'orders'} at today’s network fees.`
            : 'TRX that pays TRON for the USDT sent on your orders. What the client’s price covers is paid back to you.'}
      </p>
    </section>
  );
}
