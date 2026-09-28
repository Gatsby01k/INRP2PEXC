import Link from 'next/link';
import type { ReserveView } from '@inrp2p/traders';
import { usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/** The Security Reserve in brief: what is held, what is locked, what could be withdrawn, what is on its way back. */
export function ReserveCard({ reserve }: { reserve: ReserveView }) {
  return (
    <section className={shell.card} aria-labelledby="reserve-title">
      <div className={shell.cardHead}>
        <h2 id="reserve-title" className={shell.cardTitle}>
          Security Reserve
        </h2>
        <Link className={shell.textAction} href="/traders/reserve">
          Manage
        </Link>
      </div>
      <dl className={styles.numbers}>
        <div className={styles.wideNumber}>
          <dt>Held</dt>
          <dd data-big="">{usdt(reserve.balance)}</dd>
        </div>
        <div>
          <dt>Locked</dt>
          <dd>{usdt(reserve.locked)}</dd>
        </div>
        <div>
          <dt>Available for withdrawal</dt>
          <dd>{usdt(reserve.available)}</dd>
        </div>
        <div>
          <dt>Pending release</dt>
          <dd>{usdt(reserve.pendingRelease)}</dd>
        </div>
        <div>
          <dt>Required</dt>
          <dd>{reserve.required ? usdt(reserve.required) : 'Not set'}</dd>
        </div>
      </dl>
      <p className={styles.note}>
        A USDT reserve is locked while you provide liquidity. It protects open orders and unresolved obligations, and is released only after they are finished.
      </p>
    </section>
  );
}
