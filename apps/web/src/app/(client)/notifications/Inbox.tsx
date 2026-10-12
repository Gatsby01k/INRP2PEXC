'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClientNotification } from '@inrp2p/notifications';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDate, formatIstTime } from '@inrp2p/ui/format';
import { markNotificationsReadAction } from '../../../server/actions/client.ts';
import { RobotFigure } from '../_assistant/RobotFigure.tsx';
import { ArrowIcon, BankIcon, CheckIcon, ClockIcon, InfoIcon, ReceiptIcon, SwapIcon, UsersIcon } from '../_workspace/icons.tsx';
import shell from '../shell.module.css';
import styles from './inbox.module.css';

type Tone = 'brand' | 'success' | 'warning' | 'neutral';

/** What kind of news a message is, as a glyph and a tone — always beside its title, never instead of it. */
function look(kind: ClientNotification['kind']): { Icon: typeof SwapIcon; tone: Tone } {
  switch (kind) {
    case 'QUOTE_SENT':
      return { Icon: SwapIcon, tone: 'brand' };
    case 'TRADE_OPENED':
      return { Icon: ArrowIcon, tone: 'brand' };
    case 'PAYOUT_CONFIRMED':
      return { Icon: ReceiptIcon, tone: 'success' };
    case 'TRADE_COMPLETED':
      return { Icon: CheckIcon, tone: 'success' };
    case 'QUOTE_EXPIRED':
      return { Icon: ClockIcon, tone: 'neutral' };
    case 'REQUEST_DECLINED':
    case 'TRADE_CANCELLED':
    case 'TRADE_DESTINATION_CHANGED':
      return { Icon: InfoIcon, tone: 'warning' };
    case 'DESTINATION_ADDED':
    case 'DESTINATION_ARCHIVED':
      return { Icon: BankIcon, tone: 'neutral' };
    default:
      return { Icon: UsersIcon, tone: 'neutral' };
  }
}

const group3 = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Messages written before amounts were grouped at the source (`messages.ts`) carry them raw — "₹10200000.00",
 * "5000.000000 USDT". They are shown the way every other figure in the workspace is (D-11); the stored text is not
 * touched.
 */
export function readable(body: string): string {
  return body
    .replace(/₹(\d{4,})(?:\.(\d{2}))?(?!\d)/g, (_, whole: string, paise?: string) => `₹${group3(whole)}${paise && paise !== '00' ? `.${paise}` : ''}`)
    .replace(/(?<![\d,.])(\d+)\.(\d{6}) USDT/g, (_, whole: string, fraction: string) => {
      const kept = fraction.replace(/0+$/, '');
      return `${group3(whole)}${kept ? `.${kept}` : ''} USDT`;
    });
}

/** Titles written before Bank & wallets had its name, said the way the workspace says them now. */
const TITLES: Record<string, string> = {
  'A destination was added': 'A bank account or wallet was added',
  'A destination was archived': 'A bank account or wallet was archived',
  'A trade now pays to another destination': 'A trade now pays somewhere else',
};

const readableTitle = (title: string): string => TITLES[title] ?? title;

/** The day a message belongs to, as a person says it. */
function dayOf(iso: string, today: string, yesterday: string): string {
  const day = formatIstDate(new Date(iso));
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : day;
}

export function Inbox({ rows, now }: { rows: readonly ClientNotification[]; now: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unread = rows.filter((r) => !r.read);
  const today = formatIstDate(new Date(now));
  const yesterday = formatIstDate(new Date(Date.parse(now) - 86_400_000));
  const days: { day: string; items: ClientNotification[] }[] = [];
  for (const r of rows) {
    const day = dayOf(r.createdAt, today, yesterday);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(r);
    else days.push({ day, items: [r] });
  }

  return (
    <main className={`${shell.main} ${styles.inbox}`}>
      {rows.length === 0 ? (
        <section className={`${shell.card} ${styles.empty}`}>
          <RobotFigure mood="ready" className={styles.emptyFigure} live={false} />
          <h2 className={styles.emptyTitle}>Nothing to report yet</h2>
          <p className={styles.emptyBody}>You will hear from the desk here when a quote is ready, a payment goes out or a bank account or wallet changes.</p>
        </section>
      ) : (
        <section className={`${shell.card} ${styles.feed}`} aria-label="Notifications">
          <div className={styles.feedHead}>
            <span className={styles.summary}>{unread.length === 0 ? 'All read' : unread.length === 1 ? 'One new message' : `${unread.length} new messages`}</span>
            {unread.length > 0 ? (
              <button
                type="button"
                className={shell.secondaryAction}
                data-size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await markNotificationsReadAction(unread.map((r) => r.id));
                    router.refresh();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <ArcLoader size="sm" label="Marking as read" tone="inherit" /> : <CheckIcon />}
                Mark all as read
              </button>
            ) : null}
          </div>
          {days.map(({ day, items }) => (
            <div key={day} className={styles.day}>
              <h2 className={styles.dayTitle}>{day}</h2>
              <ul className={styles.list}>
                {items.map((n) => {
                  const { Icon, tone } = look(n.kind);
                  const content = (
                    <>
                      <span className={styles.icon} data-tone={tone} aria-hidden="true">
                        <Icon />
                      </span>
                      <span className={styles.body}>
                        <span className={styles.head}>
                          <strong className={styles.title}>
                            {readableTitle(n.title)}
                            {!n.read ? <span className="ix-visually-hidden"> (new)</span> : null}
                          </strong>
                          <time className={styles.time} dateTime={n.createdAt}>
                            {formatIstTime(new Date(n.createdAt))}
                          </time>
                        </span>
                        <span className={styles.text}>{readable(n.body).replace('A new destination was added to your account.', 'A new bank account or wallet was added.')}</span>
                        {n.subjectRef && !n.body.includes(n.subjectRef) ? <span className={styles.ref}>{n.subjectRef}</span> : null}
                      </span>
                      {!n.read ? <span className={styles.dot} aria-hidden="true" /> : <span aria-hidden="true" />}
                    </>
                  );
                  return (
                    <li key={n.id} className={styles.item} data-unread={!n.read || undefined}>
                      {n.href ? (
                        <Link className={styles.row} href={n.href}>
                          {content}
                        </Link>
                      ) : (
                        <div className={styles.row}>{content}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
