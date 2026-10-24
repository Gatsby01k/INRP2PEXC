'use client';

import Link from 'next/link';
import type { DeskDeal } from '@inrp2p/traders';
import { formatCountdown, formatIstDateTime } from '@inrp2p/ui/format';
import { useServerClock } from '../../exchange/useServerClock.ts';
import { DealStatus } from './DeskStatus.tsx';
import { initial, inr, isZero, rate, usdt } from './format.ts';
import styles from '../desk.module.css';

/** What the desk does next on a deal that waits on it, in one line. */
export function nextMove(d: DeskDeal): string {
  const sells = d.direction === 'BUY_USDT';
  if (d.step === 'ESCROW' && sells) return `Fund the escrow for ${d.clientName}`;
  if (d.step === 'PAY' && !sells) return `Pay ${d.clientName}`;
  if (d.step === 'CONFIRM' && sells) return `Confirm ${d.clientName}’s rupees`;
  return `Continue with ${d.clientName}`;
}

/** The figure that matters for a deal right now: the USDT the desk escrows, otherwise the rupees between them. */
const keyAmount = (d: DeskDeal) => (d.yourMove && d.step === 'ESCROW' && d.direction === 'BUY_USDT' ? usdt(d.deskUsdt) : inr(d.inr));

function Due({ dueBy, now, label }: { dueBy: string | null; now: number; label: string }) {
  if (!dueBy) return null;
  const left = Date.parse(dueBy) - now;
  if (left <= 0) return <span className={styles.due}>Time is up</span>;
  return (
    <span className={styles.due} {...(left < 10 * 60_000 ? { 'data-urgent': '' } : {})}>
      {label} {left < 60 * 60_000 ? formatCountdown(left) : `${Math.round(left / 3_600_000)} h`}
    </span>
  );
}

/**
 * Deals as a list: who, which way and how much — and, on the right, what the deal waits for and until when. A deal that
 * waits on the desk says what to do. Counts down from the server's clock.
 */
export function DealList({ deals, now: serverNow, showNext = false }: { deals: readonly DeskDeal[]; now: string; showNext?: boolean }) {
  const now = useServerClock(serverNow, deals.some((d) => d.dueBy !== null));
  return (
    <ul className={styles.deals}>
      {deals.map((d) => (
        <li key={d.ref}>
          <Link className={styles.deal} href={`/desk/deals/${encodeURIComponent(d.ref)}`}>
            <span className={styles.avatar} data-tone={d.direction === 'BUY_USDT' ? 'buy' : undefined} aria-hidden="true">
              {initial(d.clientName)}
            </span>
            <span className={styles.dealText}>
              <span className={styles.dealTitle}>{showNext && d.yourMove ? nextMove(d) : d.clientName}</span>
              <span className={styles.dealMeta}>
                {d.direction === 'SELL_USDT' ? 'Sells' : 'Buys'} {usdt(d.usdt)} at {rate(d.rate)}
                {d.via === 'LINK' ? ' · by link' : ''}
                {/* The escrow is the client's USDT plus INRP2P's fee: say so, or 802 beside "800" reads as a mistake. */}
                {d.yourMove && d.step === 'ESCROW' && d.direction === 'BUY_USDT' && !isZero(d.fee) ? ` · escrow incl. ${usdt(d.fee)} fee` : ''}
                {d.completedAt ? ` · ${formatIstDateTime(new Date(d.completedAt))}` : ''}
              </span>
            </span>
            <span className={styles.dealRight}>
              <span className={styles.dealAmount}>{keyAmount(d)}</span>
              {d.state === 'IN_PROGRESS' && d.yourMove ? (
                <Due dueBy={d.dueBy} now={now} label="Due in" />
              ) : d.state === 'ASKING' ? (
                <Due dueBy={d.dueBy} now={now} label="Price held" />
              ) : (
                <DealStatus state={d.state} yourMove={d.yourMove} inReview={d.stage === 'REVIEW'} />
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
