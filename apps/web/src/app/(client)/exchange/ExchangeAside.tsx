import Link from 'next/link';
import { Money } from '@inrp2p/kernel';
import type { HistoryRow } from '@inrp2p/portal';
import { formatInr, formatUsdtHeadline } from '@inrp2p/ui/format';
import { type Step, isOpenTrade } from '../_assistant/model.ts';
import { TRADE_STATUS } from '../_workspace/StatusPill.tsx';
import { ArrowIcon, CheckIcon, ClockIcon, PauseIcon } from '../_workspace/icons.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

type Mode = { kind: 'ready' } | { kind: 'pricing'; steps: readonly Step[] } | { kind: 'quote'; sell: boolean };

/**
 * The column beside the ticket, saying what is useful at that moment and nothing else:
 * - while the desk prices a request, where it has got;
 * - while a quote counts down, what accepting it starts — the decision is easier when its consequences are plain;
 * - otherwise, the client's own trades — the ones waiting on them first — or, before the first one, how it works.
 */
export function ExchangeAside({ mode, recent }: { mode: Mode; recent: readonly HistoryRow[] }) {
  return (
    <aside className={shell.aside} aria-label="Context">
      {mode.kind === 'pricing' ? (
        <section className={styles.panel} aria-labelledby="where-title">
          <h2 id="where-title" className={styles.panelTitle}>
            Where your request is
          </h2>
          <ol className={styles.sequence}>
            {mode.steps.map((s) => (
              <li key={s.label} data-status={s.status}>
                <span className={styles.sequenceText}>
                  <span className={styles.sequenceTitle}>{s.label}</span>
                  {s.detail ? <span className={styles.sequenceBody}>{s.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
          <p className={shell.muted}>You are told in Notifications too — and with a sound, if sound is on.</p>
        </section>
      ) : mode.kind === 'quote' ? (
        <section className={styles.panel} aria-labelledby="next-title">
          <h2 id="next-title" className={styles.panelTitle}>
            When you accept
          </h2>
          <ol className={styles.sequence}>
            <li>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceTitle}>The trade opens at this rate</span>
                <span className={styles.sequenceBody}>The rate and amounts are fixed from that moment.</span>
              </span>
            </li>
            <li>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceTitle}>{mode.sell ? 'You send the USDT' : 'You pay the INR'}</span>
                <span className={styles.sequenceBody}>
                  {mode.sell ? 'To an address that belongs to this trade alone, shown on the trade.' : 'To the account shown on the trade, with its reference.'}
                </span>
              </span>
            </li>
            <li>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceTitle}>{mode.sell ? 'The desk pays your INR' : 'The desk sends your USDT'}</span>
                <span className={styles.sequenceBody}>{mode.sell ? 'In one or more bank transfers, each with its UTR.' : 'To your wallet, with its transaction hash.'}</span>
              </span>
            </li>
            <li>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceTitle}>A receipt for your records</span>
                <span className={styles.sequenceBody}>Issued when the trade is settled in full.</span>
              </span>
            </li>
          </ol>
        </section>
      ) : recent.length > 0 ? (
        <Activity recent={recent} />
      ) : (
        <section className={styles.panel} aria-labelledby="how-title">
          <h2 id="how-title" className={styles.panelTitle}>
            How it works
          </h2>
          <ol className={styles.sequence}>
            <li>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceTitle}>Ask for a price</span>
                <span className={styles.sequenceBody}>Any size. A person on the desk prices every request.</span>
              </span>
            </li>
            <li>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceTitle}>Accept a firm quote</span>
                <span className={styles.sequenceBody}>One rate for the whole amount, held for a short time. Nothing is committed until you accept.</span>
              </span>
            </li>
            <li>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceTitle}>Settle and get paid</span>
                <span className={styles.sequenceBody}>Only to your own bank account or wallet, every payment with its reference.</span>
              </span>
            </li>
          </ol>
        </section>
      )}
    </aside>
  );
}

const AWAITING = new Set(['AWAITING_FIRST_LEG']);

function Activity({ recent }: { recent: readonly HistoryRow[] }) {
  const sorted = [...recent].sort((a, b) => Number(AWAITING.has(b.status) && !b.onHold) - Number(AWAITING.has(a.status) && !a.onHold));
  return (
    <section className={styles.panel} aria-labelledby="activity-title">
      <div className={styles.panelHead}>
        <h2 id="activity-title" className={styles.panelTitle}>
          Your trades
        </h2>
        <Link className={styles.panelLink} href="/history">
          All trades
        </Link>
      </div>
      <ul className={styles.activity}>
        {sorted.slice(0, 4).map((t) => {
          const sell = t.direction === 'SELL_USDT';
          const yours = AWAITING.has(t.status) && !t.onHold;
          const done = t.status === 'COMPLETED';
          const tone = yours ? 'action' : done ? 'done' : undefined;
          const usdt = formatUsdtHeadline(Money.parse(t.base, 'USDT'));
          const inr = formatInr(Money.parse(t.inr, 'INR'));
          const state = t.onHold && isOpenTrade(t.status) ? 'On hold' : yours ? (sell ? 'Send USDT' : 'Pay INR') : (TRADE_STATUS[t.status]?.label ?? t.status);
          return (
            <li key={t.ref}>
              <Link href={`/trades/${t.ref}`}>
                <span className={styles.activityMark} {...(tone ? { 'data-tone': tone } : {})} aria-hidden="true">
                  {done ? <CheckIcon /> : t.onHold ? <PauseIcon /> : yours ? <ArrowIcon /> : <ClockIcon />}
                </span>
                <span className={styles.activityText}>
                  <span className={styles.activityTitle}>{sell ? `${usdt} → ${inr}` : `${inr} → ${usdt}`}</span>
                  <span className={styles.activityMeta}>{t.ref}</span>
                </span>
                <span className={styles.activityState} {...(tone === 'action' ? { 'data-tone': 'action' } : {})}>
                  {state}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
