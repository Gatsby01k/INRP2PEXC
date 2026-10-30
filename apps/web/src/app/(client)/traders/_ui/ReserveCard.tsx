import Link from 'next/link';
import type { LimitsView, ReserveView } from '@inrp2p/traders';
import { balanceIn, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

const LEVEL: Record<LimitsView['level'], string> = { NEW: 'New', PROVEN: 'Proven', TRUSTED: 'Trusted' };

/** How to reach the next level, in a sentence: what is left of deals and days, or why it is held back. */
function growth(l: LimitsView): string {
  if (l.heldBack) return 'A recent deal did not go through on your side, so your limits are back at the first level for now.';
  if (!l.next) return 'You are at the top level. Deposit more to deal larger.';
  const parts = [l.next.deals > 0 ? `${l.next.deals} more completed ${l.next.deals === 1 ? 'deal' : 'deals'}` : null, l.next.days > 0 ? `${l.next.days} more ${l.next.days === 1 ? 'day' : 'days'}` : null].filter(Boolean);
  return parts.length > 0 ? `${LEVEL[l.next.level]} after ${parts.join(' and ')}. Or deposit more to deal larger now.` : `${LEVEL[l.next.level]} with your next completed deal.`;
}

/**
 * The Security Reserve in brief: what is held, what is locked, what could be withdrawn, what is on its way back — and
 * (ADR 0024) the deals it allows at the trader's level: one deal, everything open together, and how to grow.
 */
export function ReserveCard({ reserve, limits }: { reserve: ReserveView; limits?: LimitsView | null }) {
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
      {limits ? (
        <dl className={`${styles.numbers} ${styles.limits}`} aria-label={`Your limits, level ${LEVEL[limits.level]}`}>
          <div>
            <dt>One deal · {LEVEL[limits.level]}</dt>
            <dd>up to {balanceIn('USDT', limits.maxDeal)}</dd>
          </div>
          <div>
            <dt>Open now</dt>
            <dd>
              {balanceIn('USDT', limits.open)} <span className={styles.of}>of {balanceIn('USDT', limits.maxOpen)}</span>
            </dd>
          </div>
        </dl>
      ) : null}
      <p className={styles.note}>
        {limits
          ? `Your reserve sets how much you deal: deposit more and your limits grow at once. ${growth(limits)} The part that backs your open deals stays locked until they finish.`
          : 'A USDT reserve is locked while you provide liquidity. It protects open orders and unresolved obligations, and is released only after they are finished.'}
      </p>
    </section>
  );
}
