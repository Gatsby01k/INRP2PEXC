'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Rate } from '@inrp2p/kernel';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDateTime, formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { requestQuoteAction, withdrawRequestAction } from '../../../server/actions/client.ts';
import { RobotFigure } from '../_assistant/RobotFigure.tsx';
import { requestAmount } from '../_assistant/model.ts';
import { ArrowIcon, BoltIcon, CheckIcon, PlaneIcon, UserIcon, UsersIcon } from '../_workspace/icons.tsx';
import { useMarket } from '../_workspace/useMarket.ts';
import { legAmount } from './amounts.ts';
import { RequestSheet } from './RequestSheet.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';
import stage from './stage.module.css';

/** How the client hears that its price is ready: its Telegram, when linked, and its email, when it has a real one. */
export interface WaitingAlerts {
  readonly telegram: { readonly on: boolean; readonly username: string | null };
  readonly email: string | null;
}

/** How long it has been looking: "0:42", "12:05", then "1 h 12 min". */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ordinal = (n: number): string => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

/**
 * ADR 0032: a request nothing priced is not turned away — this is the wait, as the twin of the firm quote's stage, so the
 * page keeps its shape when the price arrives: the request on its sheet; beside it, on the mark's orange, the robot
 * searching inside its halo, and only what the client needs to know — that it is being looked for and for how long,
 * how many traders know, its place in line, what it will cost at today's market, and the one thing it can do now.
 *
 * Every figure is one of record (the request, the wait's facts, the market reference), and the price is said as an
 * estimate: it is fixed only when a trader takes it. Waiting on the exchange's own market reading is said as that, not
 * as a search for traders. What a trader holds ready right now, when the client asked for more, is one tap away: a new
 * request for that amount, priced at once, in place of this one.
 */
export function WaitingCard({ view, alerts, now }: { view: ExchangeView; alerts: WaitingAlerts; now: number }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [stopping, setStopping] = useState(false);
  const market = useMarket();
  const request = view.request!;
  const wait = request.waiting;
  const sell = request.direction === 'SELL_USDT';
  const onMarket = wait?.on === 'MARKET';
  const since = Date.parse(wait?.since ?? request.createdAt);
  const until = new Date(wait?.until ?? request.waitingUntil!);
  const day = (d: Date) => formatIstDateTime(d).split(',')[0];
  const lookingUntil =
    day(until) === day(new Date(now)) ? `today, ${formatIstTime(until)}` : day(until) === day(new Date(now + 86_400_000)) ? `tomorrow, ${formatIstTime(until)}` : formatIstDateTime(until);

  // The other side, about, at the market's rate for this direction — the same reference the firm price is bounded by.
  const rate = market ? Number((sell ? market.SELL_USDT : market.BUY_USDT) ?? NaN) : NaN;
  const amount = Number(request.amount);
  const known = Number.isFinite(rate) && rate > 0 && Number.isFinite(amount);
  const other = !known ? null : request.currency === 'USDT' ? { figure: `₹${legAmount(String(Math.round(amount * rate)), 'INR')}`, unit: null } : { figure: legAmount((amount / rate).toFixed(2), 'USDT'), unit: 'USDT' };
  const marketRate = known ? formatRate(Rate.parse(rate.toFixed(6), 'CLIENT')) : null;
  const expectLabel = request.currency === 'USDT' ? (sell ? 'At today’s market you get about' : 'At today’s market you pay about') : sell ? 'At today’s market you sell about' : 'At today’s market you get about';

  // What a trader holds ready now — less than asked, so asking for it is priced at once.
  const ready = !onMarket && wait?.readyNowUsdt && request.currency === 'USDT' && Number(wait.readyNowUsdt) < amount ? wait.readyNowUsdt : null;
  const destination = sell ? view.destinations.banks.find((b) => request.destination.includes(b.last4))?.id : view.destinations.wallets.find((w) => request.destination.includes(w.address.slice(-4)))?.id;

  const stop = async (then?: () => void) => {
    const out = await run('Stop looking for a trader', (key) => withdrawRequestAction({ requestRef: request.ref }, key));
    if (!out.ok) {
      robotCues.emit({ kind: 'problem' });
      return;
    }
    setStopping(false);
    then?.();
  };
  // Another amount is a new request: this one is withdrawn, and the form comes back on the same side.
  const changeAmount = () => void stop(() => router.push(`/exchange?direction=${sell ? 'sell' : 'buy'}`));
  // Asking for what is ready replaces this request (one live request per client) and is priced at once.
  const takeReady = async () => {
    if (!ready || !destination) return;
    robotCues.emit({ kind: 'wait', on: true });
    const out = await run(`${sell ? 'Sell' : 'Buy'} ${legAmount(ready, 'USDT')} USDT now`, (key) =>
      requestQuoteAction({ direction: request.direction, fixedSide: 'BASE', amount: ready, targetRate: null, ...(sell ? { bankAccountId: destination } : { walletId: destination }) }, key),
    );
    robotCues.emit({ kind: 'wait', on: false });
    robotCues.emit(out.ok ? { kind: 'submitted' } : { kind: 'problem' });
  };

  const told = wait?.tradersTold ?? 0;
  const line = onMarket
    ? 'The market rate is updating. Your request is priced the moment it is back — you can close this page.'
    : told > 0
      ? `${told} ${told === 1 ? 'trader knows' : 'traders know'} you want to ${sell ? 'sell' : 'buy'} ${requestAmount(request)}. When one takes it, the price is held for you for 10 minutes.`
      : `When a trader takes your ${requestAmount(request)}, the price is held for you for 10 minutes.`;

  return (
    <>
      <section className={stage.deal} data-even="" data-waiting="" aria-label="Request waiting for a trader" data-robot-target="panel">
        <RequestSheet
          direction={request.direction}
          amount={legAmount(request.amount, request.currency)}
          currency={request.currency}
          destination={request.destination}
          destinations={view.destinations}
          targetRate={request.targetRate ? formatRate(Rate.parse(request.targetRate, 'CLIENT')) : null}
          sentAt={formatIstTime(new Date(request.createdAt))}
          reference={request.ref}
          networkFee={null}
          estimate={other ? `≈ ${other.figure}${other.unit ? ` ${other.unit}` : ''} at today’s market` : null}
          until={lookingUntil}
        >
          {stopping ? (
            <div className={styles.confirmRow} role="group" aria-label="Stop looking for a trader">
              <p>We stop looking for a trader for {request.ref}. Nothing was committed, and you can ask again any time.</p>
              <div className={styles.confirmActions}>
                <button type="button" className={shell.secondaryAction} onClick={() => void stop()} disabled={busy}>
                  {busy ? <ArcLoader size="sm" label="Stopping" tone="inherit" /> : null}
                  Stop looking
                </button>
                <button type="button" className={shell.textAction} onClick={() => setStopping(false)} disabled={busy}>
                  Keep looking
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.waitActions}>
              <button type="button" className={`${shell.secondaryAction} ${shell.wide}`} onClick={changeAmount} disabled={busy}>
                Change the amount
              </button>
              <button type="button" className={shell.textAction} onClick={() => setStopping(true)} disabled={busy}>
                Stop looking
              </button>
            </div>
          )}
        </RequestSheet>

        {/* The quote's stage before there is a quote: the robot searching in its halo, the wait's facts, the one move. */}
        <div className={`${shell.brandField} ${stage.stage}`} data-searching="">
          <div className={stage.halo} aria-hidden="true">
            <i />
            <span className={stage.radar} />
            <span className={stage.radar} />
            <span className={stage.radar} />
            <svg className={stage.haloArcs} viewBox="0 0 400 400" focusable="false">
              <path d="M 27.6 230.4 A 175 175 0 0 1 117.8 45.5" />
              <path d="M 282.2 45.5 A 175 175 0 0 1 372.4 230.4" />
              <path d="M 297.9 345 A 175 175 0 0 1 102.1 345" />
            </svg>
          </div>
          <RobotFigure mood="waiting" className={stage.robot} />

          <header className={stage.stageHead}>
            <span className={stage.chip}>
              <span className={stage.liveDot} aria-hidden="true" />
              <span>
                {onMarket ? 'Prices paused' : 'Searching'} · <span className={stage.chipTime}>{elapsed(now - since)}</span>
              </span>
            </span>
            <span className={stage.ref}>{request.ref}</span>
          </header>

          <div className={stage.say} role="status">
            <h2 className={stage.sayTitle}>{onMarket ? 'Prices are paused for a moment' : 'Finding you a trader'}</h2>
            <p className={stage.sayBody}>{line}</p>
          </div>

          {other ? (
            <div className={stage.expect}>
              <span className={stage.getLabel}>{expectLabel}</span>
              <span className={stage.expectFigure}>
                {other.figure}
                {other.unit ? <span className={stage.getUnit}>{other.unit}</span> : null}
              </span>
              <span className={stage.getSub}>{marketRate} per USDT · your price is fixed when a trader takes it</span>
            </div>
          ) : null}

          {!onMarket && wait ? (
            <ul className={stage.facts} aria-label="Your wait">
              {told > 0 ? (
                <li className={stage.fact}>
                  <UsersIcon />
                  <span>
                    <span className={stage.factFigure}>{told}</span> {told === 1 ? 'trader told' : 'traders told'}
                  </span>
                </li>
              ) : null}
              <li className={stage.fact}>
                <UserIcon />
                <span>
                  <span className={stage.factFigure}>{ordinal(wait.ahead + 1)}</span> in line
                </span>
              </li>
            </ul>
          ) : null}

          <div className={stage.waitMoves}>
            {ready ? (
              <button type="button" className={stage.accept} onClick={() => void takeReady()} disabled={busy || !destination} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Getting the price" tone="inherit" /> : <BoltIcon />}
                <span>
                  {sell ? 'Sell' : 'Buy'} {legAmount(ready, 'USDT')} USDT now
                </span>
                {busy ? null : <ArrowIcon className={shell.actionIcon} />}
              </button>
            ) : null}
            {ready ? <p className={stage.waitNote}>A trader has it ready: priced at once, in place of this request.</p> : null}
            {alerts.telegram.on ? (
              <p className={stage.waitTold}>
                <CheckIcon />
                We’ll message you on Telegram{alerts.telegram.username ? ` · @${alerts.telegram.username}` : ''}
                {alerts.email ? ' and by email' : ''}
              </p>
            ) : (
              <>
                <Link className={ready ? stage.onFieldLink : stage.accept} href="/account#telegram">
                  <PlaneIcon />
                  <span>Tell me on Telegram</span>
                  {ready ? null : <ArrowIcon className={shell.actionIcon} />}
                </Link>
                {alerts.email ? <p className={stage.waitNote}>We’ll email you too.</p> : null}
              </>
            )}
            {error ? (
              <p className={stage.error} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </section>
      {dialog}
    </>
  );
}
