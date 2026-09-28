import Link from 'next/link';
import type { DestinationView, TraderHome } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import { inr, usdt } from './format.ts';
import { ReviewPill } from './ReviewPill.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

const EXPERIENCE: Record<string, string> = { BINANCE: 'Binance P2P', BYBIT: 'Bybit P2P', OTHER: 'Another P2P platform', NONE: 'No P2P experience' };

function Detail({ title, d }: { title: string; d: DestinationView }) {
  return (
    <div className={styles.detailRow}>
      <div>
        <span className={shell.label}>{title}</span>
        <div>{d.label}</div>
      </div>
      <ReviewPill state={d.state} />
      {d.note ? <p className={styles.detailNote}>The desk’s note: {d.note}</p> : null}
    </div>
  );
}

/**
 * Under review, or not approved: what was applied for, where the desk's review of the bank account and the wallet
 * stands, and — when there is one — the way forward. A detail the desk rejected can be replaced without starting over.
 */
export function ApplicationStatus({ home }: { home: TraderHome }) {
  const a = home.application!;
  const rejected = home.state === 'REJECTED';
  const provides = a.offersBuy && a.offersSell ? 'INR and USDT' : a.offersBuy ? 'INR' : 'USDT';
  const detailRejected = a.bank.state === 'REJECTED' || a.wallet.state === 'REJECTED';
  const contact = [a.telegram, a.phoneLast4 ? `phone ••••${a.phoneLast4}` : null].filter(Boolean).join(' · ');
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
          <span>The desk verifies your bank account and wallet and sets your Security Reserve. You cannot provide liquidity until it approves.</span>
        </p>
      )}
      <div className={styles.choices}>
        <Detail title="Bank account" d={a.bank} />
        <Detail title="TRC20 wallet" d={a.wallet} />
      </div>
      {!rejected && detailRejected && home.canApply ? (
        <div>
          <Link className={shell.secondaryAction} href="/traders/settlement">
            Submit new details
            <ArrowIcon className={shell.actionIcon} />
          </Link>
        </div>
      ) : null}
      <dl className={shell.facts}>
        <div>
          <dt>Name</dt>
          <dd>
            {a.fullName} · {a.entityType === 'COMPANY' ? 'Company' : 'Individual'}
          </dd>
        </div>
        {contact ? (
          <div>
            <dt>Contact</dt>
            <dd>{contact}</dd>
          </div>
        ) : null}
        {a.experience ? (
          <div>
            <dt>P2P experience</dt>
            <dd>{EXPERIENCE[a.experience]}</dd>
          </div>
        ) : null}
        <div>
          <dt>You provide</dt>
          <dd>{provides}</dd>
        </div>
        {a.typicalInr ? (
          <div>
            <dt>{a.dailyInr ? 'INR · typical / daily' : 'Typical INR'}</dt>
            <dd className="ix-num">{a.dailyInr ? `${inr(a.typicalInr)} / ${inr(a.dailyInr)}` : inr(a.typicalInr)}</dd>
          </div>
        ) : null}
        {a.typicalUsdt ? (
          <div>
            <dt>{a.dailyUsdt ? 'USDT · typical / daily' : 'Typical USDT'}</dt>
            <dd className="ix-num">{a.dailyUsdt ? `${usdt(a.typicalUsdt)} / ${usdt(a.dailyUsdt)}` : usdt(a.typicalUsdt)}</dd>
          </div>
        ) : null}
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
