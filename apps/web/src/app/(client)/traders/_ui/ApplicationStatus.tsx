import Link from 'next/link';
import type { TraderHome } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import { inr, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/** Under review, or not approved: what was applied for, and — when there is one — the way forward. */
export function ApplicationStatus({ home }: { home: TraderHome }) {
  const a = home.application!;
  const rejected = home.state === 'REJECTED';
  const provides = a.offersBuy && a.offersSell ? 'INR and USDT' : a.offersBuy ? 'INR' : 'USDT';
  return (
    <section className={shell.surface} aria-labelledby="application-title" data-robot-target="panel">
      <div className={shell.cardHead}>
        <h2 id="application-title" className={shell.cardTitle}>
          Your application
        </h2>
        <span className={styles.pill} data-tone={rejected ? 'neutral' : 'waiting'}>
          <span className={styles.pillDot} aria-hidden="true" />
          {rejected ? 'Not approved' : 'Under review'}
        </span>
      </div>
      {rejected ? (
        <p className={shell.info} data-tone="warning">
          <InfoIcon className={shell.infoIcon} />
          <span>{a.reviewNote ? `The desk’s note: ${a.reviewNote}` : 'The desk did not approve this application.'}</span>
        </p>
      ) : (
        <p className={shell.info}>
          <InfoIcon className={shell.infoIcon} />
          <span>The desk checks your registered bank account and wallet and sets your Security Reserve. You cannot provide liquidity until it approves.</span>
        </p>
      )}
      <dl className={shell.facts}>
        <div>
          <dt>You provide</dt>
          <dd>{provides}</dd>
        </div>
        {a.typicalInr ? (
          <div>
            <dt>Typical INR</dt>
            <dd className="ix-num">{inr(a.typicalInr)}</dd>
          </div>
        ) : null}
        {a.typicalUsdt ? (
          <div>
            <dt>Typical USDT</dt>
            <dd className="ix-num">{usdt(a.typicalUsdt)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Bank account</dt>
          <dd>{a.bank}</dd>
        </div>
        <div>
          <dt>TRC20 wallet</dt>
          <dd>{a.wallet}</dd>
        </div>
        <div>
          <dt>Applied</dt>
          <dd>{formatIstDateTime(new Date(a.appliedAt))}</dd>
        </div>
      </dl>
      {rejected && home.canApply ? (
        <div>
          <Link className={shell.secondaryAction} href="/traders/apply">
            Apply again
            <ArrowIcon className={shell.actionIcon} />
          </Link>
        </div>
      ) : null}
    </section>
  );
}
