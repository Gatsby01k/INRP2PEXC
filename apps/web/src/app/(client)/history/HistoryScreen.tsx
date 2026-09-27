'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { Money, Rate } from '@inrp2p/kernel';
import type { HistoryCounts, HistoryRow } from '@inrp2p/portal';
import { formatInr, formatIstDateTime, formatRate, formatUsdtHeadline } from '@inrp2p/ui/format';
import { AssistantPanel } from '../_assistant/AssistantPanel.tsx';
import { historyAssistant, isOpenTrade, lifecycleSteps } from '../_assistant/model.ts';
import { EmptyState } from '../_workspace/EmptyState.tsx';
import { ArrowIcon, ChevronIcon, ClockIcon, ReceiptIcon } from '../_workspace/icons.tsx';
import { Stepper } from '../_workspace/Stepper.tsx';
import { StatusPill } from '../_workspace/StatusPill.tsx';
import shell from '../shell.module.css';
import styles from './history.module.css';

const FILTERS = [
  { key: 'all', label: 'All', href: '/history' },
  { key: 'open', label: 'In progress', href: '/history?filter=open' },
  { key: 'completed', label: 'Completed', href: '/history?filter=completed' },
] as const;

const usdt = (r: HistoryRow) => formatUsdtHeadline(Money.parse(r.base, 'USDT'));
const inr = (r: HistoryRow) => formatInr(Money.parse(r.inr, 'INR'));
/** "19 Sep 2026" over "14:41" in the list; a phone runs them together. */
function When({ iso }: { iso: string }) {
  const [date, time] = formatIstDateTime(new Date(iso)).replace(' IST', '').split(', ');
  return (
    <>
      {date}
      <span className={styles.time}>{time}</span>
    </>
  );
}

/** What, if anything, is the client's to do on this trade — from its status, in the product's own terms. */
function nextStep(r: HistoryRow): string {
  const sell = r.direction === 'SELL_USDT';
  if (r.status === 'CANCELLED') return 'Nothing further moves on this trade. The reason is in your notifications.';
  if (r.onHold && isOpenTrade(r.status)) return 'Nothing for now. The desk is checking something and moves the trade on when it is done.';
  switch (r.status) {
    case 'AWAITING_FIRST_LEG':
      return sell ? `Send exactly ${usdt(r)} to this trade’s deposit address on TRC20 — the trade page shows it.` : `Pay ${inr(r)}. The desk confirms it by its bank reference (UTR).`;
    case 'FIRST_LEG_DETECTED':
      return 'Nothing — your transfer is on-chain and becoming final.';
    case 'COMPLETED':
      return r.receipt ? 'Settled in full. The receipt is ready.' : 'Settled in full. The receipt follows shortly.';
    default:
      return sell ? 'Nothing — the desk is paying out your INR.' : 'Nothing — the desk is sending your USDT.';
  }
}

/**
 * The history list. A trade expands in place — how far it has got, what was agreed, and what, if anything, is the
 * client's to do — and the latest one still running starts expanded, since that is usually why they came. On a
 * phone the same rows become cards; nothing is drawn twice.
 */
export function HistoryScreen({ rows, open, counts, filter }: { rows: readonly HistoryRow[]; open: readonly HistoryRow[]; counts: HistoryCounts; filter: string }) {
  const firstOpen = rows.find((r) => isOpenTrade(r.status))?.ref;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(firstOpen ? [firstOpen] : []));
  const toggle = (ref: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  const count: Record<string, number> = { all: counts.all, open: counts.open, completed: counts.completed };

  return (
    <>
      <main className={shell.main}>
        <section className={`${shell.card} ${styles.list}`} aria-label="Trades" data-robot-target="panel">
          <nav className={styles.filters} aria-label="Filter">
            {FILTERS.map((f) => (
              <Link key={f.key} href={f.href} className={styles.filter} {...(filter === f.key ? { 'aria-current': 'page' as const } : {})}>
                {f.label}
                <span className={styles.count}>{count[f.key]}</span>
              </Link>
            ))}
          </nav>

          {rows.length === 0 ? (
            filter === 'all' ? (
              <EmptyState
                icon={<ReceiptIcon />}
                title="No trades yet"
                body="A trade appears here the moment you accept a quote, with its payments as they land and its receipt once it settles."
                action={
                  <Link className={shell.secondaryAction} href="/exchange">
                    Request a quote
                    <ArrowIcon className={shell.actionIcon} />
                  </Link>
                }
              />
            ) : (
              <EmptyState
                icon={<ClockIcon />}
                title={filter === 'open' ? 'Nothing in progress' : 'Nothing settled yet'}
                body={filter === 'open' ? 'Every trade you have is settled or closed.' : 'Settled trades, with their receipts, appear here.'}
                action={
                  <Link className={shell.textAction} href="/history">
                    Show all trades
                  </Link>
                }
              />
            )
          ) : (
            <table className={styles.table}>
              <caption className="ix-visually-hidden">Your trades, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="ix-visually-hidden">Details</span>
                  </th>
                  <th scope="col">Trade</th>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col" className={styles.num}>
                    USDT
                  </th>
                  <th scope="col" className={styles.num}>
                    INR
                  </th>
                  <th scope="col" className={styles.num}>
                    Rate
                  </th>
                  <th scope="col">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = expanded.has(r.ref);
                  const panelId = `trade-${r.ref}`;
                  const steps = lifecycleSteps(r.direction, r.status);
                  const sell = r.direction === 'SELL_USDT';
                  return (
                    <Fragment key={r.ref}>
                      <tr className={styles.row} data-expanded={isOpen || undefined} onClick={() => toggle(r.ref)}>
                        <td className={styles.toggleCell}>
                          <button
                            type="button"
                            className={styles.toggle}
                            aria-expanded={isOpen}
                            aria-controls={panelId}
                            aria-label={isOpen ? 'Hide details' : 'Show details'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(r.ref);
                            }}
                          >
                            <ChevronIcon className={styles.chevron} />
                          </button>
                        </td>
                        <td className={styles.ref}>
                          <Link href={`/trades/${r.ref}`} onClick={(e) => e.stopPropagation()}>
                            {r.ref}
                          </Link>
                          <span className={styles.direction}>{sell ? 'Sell USDT' : 'Buy USDT'}</span>
                        </td>
                        <td className={styles.started}>
                          <When iso={r.openedAt} />
                        </td>
                        <td className={styles.status}>
                          <StatusPill status={r.status} onHold={r.onHold} />
                        </td>
                        <td className={`${styles.num} ${styles.usdt}`} data-label="USDT">
                          {formatUsdtHeadline(Money.parse(r.base, 'USDT'), { unit: false })}
                          <span className={styles.cardUnit}> USDT</span>
                        </td>
                        <td className={`${styles.num} ${styles.inr}`} data-label="INR">
                          {inr(r)}
                        </td>
                        <td className={`${styles.num} ${styles.rate}`} data-label="Rate">
                          {formatRate(Rate.parse(r.clientRate, 'CLIENT'))}
                        </td>
                        <td className={styles.receipt}>
                          {r.receipt ? (
                            // Stops the row's own toggle: someone clicking the receipt wants the document.
                            <a
                              className={styles.receiptLink}
                              href={`/api/receipts/${encodeURIComponent(r.ref)}`}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`View the receipt for ${r.ref}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ReceiptIcon className={styles.receiptIcon} />
                              View
                            </a>
                          ) : (
                            <span className={shell.muted} aria-label="No receipt yet">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className={styles.detailRow} id={panelId}>
                          <td colSpan={8}>
                            <div className={styles.detail}>
                              {steps ? <Stepper steps={steps} label="Trade progress" /> : null}
                              <div className={styles.detailGrid}>
                                <dl className={shell.facts}>
                                  <div>
                                    <dt>Type</dt>
                                    <dd>{sell ? 'Sell USDT for INR' : 'Buy USDT with INR'}</dd>
                                  </div>
                                  <div>
                                    <dt>Started</dt>
                                    <dd>{formatIstDateTime(new Date(r.openedAt))}</dd>
                                  </div>
                                  {r.closedAt ? (
                                    <div>
                                      <dt>{r.status === 'CANCELLED' ? 'Cancelled' : 'Settled'}</dt>
                                      <dd>{formatIstDateTime(new Date(r.closedAt))}</dd>
                                    </div>
                                  ) : null}
                                </dl>
                                <dl className={shell.facts}>
                                  <div>
                                    <dt>{sell ? 'You sell' : 'You pay'}</dt>
                                    <dd className="ix-num">{sell ? usdt(r) : inr(r)}</dd>
                                  </div>
                                  <div>
                                    <dt>You receive</dt>
                                    <dd className="ix-num">{sell ? inr(r) : usdt(r)}</dd>
                                  </div>
                                  <div>
                                    <dt>Rate</dt>
                                    <dd className="ix-num">{formatRate(Rate.parse(r.clientRate, 'CLIENT'))} / USDT</dd>
                                  </div>
                                </dl>
                                <div className={styles.next}>
                                  <span className={shell.label}>What’s next</span>
                                  <p>{nextStep(r)}</p>
                                </div>
                              </div>
                              <div className={styles.detailActions}>
                                <Link className={shell.secondaryAction} href={`/trades/${r.ref}`}>
                                  Open the trade
                                  <ArrowIcon className={shell.actionIcon} />
                                </Link>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </main>
      <AssistantPanel state={historyAssistant(open, counts)} size="compact">
        <dl className={styles.legend}>
          <div>
            <dt>
              <StatusPill status="AWAITING_FIRST_LEG" />
            </dt>
            <dd>The trade needs your USDT or INR.</dd>
          </div>
          <div>
            <dt>
              <StatusPill status="FIRST_LEG_DETECTED" />
            </dt>
            <dd>Your transfer is on-chain, becoming final.</dd>
          </div>
          <div>
            <dt>
              <StatusPill status="SETTLING" />
            </dt>
            <dd>The desk is paying you out.</dd>
          </div>
          <div>
            <dt>
              <StatusPill status="COMPLETED" />
            </dt>
            <dd>Settled in full, with a receipt.</dd>
          </div>
        </dl>
      </AssistantPanel>
    </>
  );
}
