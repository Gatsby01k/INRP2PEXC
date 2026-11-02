import Link from 'next/link';
import type { DestinationView, TraderHome } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import { StopChange } from './StopChange.tsx';
import { ReviewPill } from './ReviewPill.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

function Row({ title, label, state, note, detail }: { title: string; label: string; state: DestinationView['state']; note?: string | null; detail?: string }) {
  return (
    <div className={styles.detailRow}>
      <div>
        <span className={shell.label}>{title}</span>
        <div {...(detail ? { title: detail } : {})}>{label}</div>
      </div>
      <ReviewPill state={state} />
      {note ? <p className={styles.detailNote}>The desk’s note: {note}</p> : null}
    </div>
  );
}

/**
 * The trader's registered settlement details, and any replacement it has submitted. The registered pair settles every
 * order; a replacement waits for the desk and never touches an order already in progress (TD-24).
 */
export function SettlementCard({ home }: { home: TraderHome }) {
  const r = home.registered!;
  const { bank, wallet, effectiveAt, waitingOn } = home.proposal;
  const pending = waitingOn !== null;
  const when = effectiveAt ? formatIstDateTime(new Date(effectiveAt)) : null;
  return (
    <section className={shell.card} aria-labelledby="registered-title">
      <div className={shell.cardHead}>
        <h2 id="registered-title" className={shell.cardTitle}>
          Settlement details
        </h2>
      </div>
      <div className={styles.choices}>
        <Row title="Bank account" label={r.bank} state="VERIFIED" />
        {bank ? <Row title="New bank account" label={bank.label} state={bank.state} note={bank.note} /> : null}
        <Row title="TRC20 wallet" label={`TRC20 · ${r.wallet}`} state="VERIFIED" detail={r.walletAddress} />
        {wallet ? <Row title="New TRC20 wallet" label={wallet.label} state={wallet.state} note={wallet.note} /> : null}
      </div>
      {pending ? (
        <p className={shell.info} data-tone="warning">
          <InfoIcon className={shell.infoIcon} />
          <span>
            {waitingOn === 'HOLD' && when
              ? `The new details take effect from ${when}. Everyone on your account was told; if this was not you, stop it now.`
              : waitingOn === 'ORDERS'
                ? 'The new details take effect as soon as your orders in progress finish — they settle with the details they were accepted under.'
                : 'INRP2P is checking the new details before they take effect.'}
          </span>
        </p>
      ) : (
        <p className={styles.note}>
          You settle only through verified details. A new bank account or wallet takes effect after a safety wait, everyone on your account is told, and orders in progress finish with
          the details they were accepted under.
        </p>
      )}
      {pending && home.canApply ? <StopChange /> : null}
      {home.canApply && !pending ? (
        <div>
          <Link className={shell.textAction} href="/traders/settlement">
            Submit a new bank account or wallet
            <ArrowIcon className={shell.actionIcon} />
          </Link>
        </div>
      ) : null}
    </section>
  );
}
