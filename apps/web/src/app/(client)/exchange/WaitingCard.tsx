'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Rate } from '@inrp2p/kernel';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDateTime, formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { requestQuoteAction, withdrawRequestAction } from '../../../server/actions/client.ts';
import { declinePeerAction, meetPeerAction, setWaitAction, startPeerAction, stillLookingAction } from '../../../server/actions/peer.ts';
import { RobotFigure } from '../_assistant/RobotFigure.tsx';
import { ArrowIcon, BellIcon, BoltIcon, CheckIcon, MeetIcon, PeerIcon, PlaneIcon, RateIcon, UserIcon, UsersIcon } from '../_workspace/icons.tsx';
import { Amount } from '../../../components/Amount.tsx';
import { StateRing } from '../_workspace/StateRing.tsx';
import { Countdown } from './QuoteCard.tsx';
import { GapRail } from './GapRail.tsx';
import { useMarket } from '../_workspace/useMarket.ts';
import { legAmount } from './amounts.ts';
import { RequestSheet } from './RequestSheet.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';
import stage from './stage.module.css';
import { usePush } from './usePush.ts';

/** How the client hears that its price is ready: its Telegram, when linked, its email, when it has a real one, and this browser. */
export interface WaitingAlerts {
  readonly telegram: { readonly on: boolean; readonly username: string | null };
  readonly email: string | null;
  /** ADR 0033 §2.6: the deployment's Web Push key, when it has one — the browser can then be told too. */
  readonly pushKey?: string | null;
}

/** How long it has been looking: "0:42", "12:05", then "1 h 12 min". */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ordinal = (n: number): string => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
const rateOf = (decimal: string): string => formatRate(Rate.parse(decimal, 'CLIENT'));

/** ADR 0033: how long to keep looking, as the client chooses it. */
const LOOK_FOR = [
  { hours: 1, label: '1 h' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '1 week' },
] as const;

/**
 * ADR 0032: a request nothing priced is not turned away — this is the wait, as the twin of the firm quote's stage, so the
 * page keeps its shape when the price arrives: the request on its sheet; beside it, on the mark's orange, the robot
 * searching inside its halo, and only what the client needs to know.
 *
 * ADR 0033: the wait is also a place in the book. One thing leads the stage at a time — another client's yes waiting for
 * this one's start; this client's own yes waiting for the other's; a pause after this client missed a meeting; another
 * client ready at a price that works ("Buy at ₹102.26"); or the search itself, with another client's price close by as one
 * quiet line. Every figure is one of record; a price from the market is said as an estimate.
 */
export function WaitingCard({ view, alerts, now }: { view: ExchangeView; alerts: WaitingAlerts; now: number }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [stopping, setStopping] = useState(false);
  const market = useMarket();
  const push = usePush(alerts.pushKey ?? null);
  const request = view.request!;
  const wait = request.waiting;
  const peer = request.peer;
  const sell = request.direction === 'SELL_USDT';
  const other = sell ? 'buyer' : 'seller';
  const onMarket = wait?.on === 'MARKET';
  const since = Date.parse(wait?.since ?? request.createdAt);
  const until = new Date(wait?.until ?? request.waitingUntil!);
  const day = (d: Date) => formatIstDateTime(d).split(',')[0];
  const lookingUntil =
    day(until) === day(new Date(now)) ? `today, ${formatIstTime(until)}` : day(until) === day(new Date(now + 86_400_000)) ? `tomorrow, ${formatIstTime(until)}` : formatIstDateTime(until);

  // The book: a meeting this request is in leads; then a pause; then another client's price.
  const meeting = peer?.meeting && peer.meeting.status === 'WAITING_MAKER' ? peer.meeting : null;
  const paused = !meeting && (peer?.paused ?? false);
  const offer = !meeting && !paused ? (peer?.offer ?? null) : null;
  const ready = offer?.kind === 'READY' ? offer : null;
  const near = offer?.kind === 'NEAR' ? offer : null;

  // The other side of the deal, about, at the market's rate for this direction — the same reference the firm price is bounded by.
  const rate = market ? Number((sell ? market.SELL_USDT : market.BUY_USDT) ?? NaN) : NaN;
  const amount = Number(request.amount);
  const known = Number.isFinite(rate) && rate > 0 && Number.isFinite(amount);
  const estimate = !known ? null : request.currency === 'USDT' ? { figure: `₹${legAmount(String(Math.round(amount * rate)), 'INR')}`, unit: null } : { figure: legAmount((amount / rate).toFixed(2), 'USDT'), unit: 'USDT' };
  const marketRate = known ? formatRate(Rate.parse(rate.toFixed(6), 'CLIENT')) : null;
  const expectLabel = request.currency === 'USDT' ? (sell ? 'At today’s market you get about' : 'At today’s market you pay about') : sell ? 'At today’s market you sell about' : 'At today’s market you get about';

  // What a meeting gives this client: rupees for its USDT when it sells, USDT for its rupees when it buys.
  const deal = meeting ? { base: meeting.base, inr: meeting.inr, network: meeting.network, rate: meeting.rate } : ready?.deal ? { ...ready.deal, rate: ready.rate } : null;
  // USDT to the cent, never rounded up: what a person reads; the deal page carries every decimal.
  const cents = (usdt: string): string => legAmount(usdt.replace(/^(\d+\.\d{2})\d+$/, '$1'), 'USDT');

  // What a trader holds ready now — less than asked, so asking for it is priced at once.
  const readyNow = !onMarket && !meeting && !ready && wait?.readyNowUsdt && request.currency === 'USDT' && Number(wait.readyNowUsdt) < amount ? wait.readyNowUsdt : null;
  const destination = sell ? view.destinations.banks.find((b) => request.destination.includes(b.last4))?.id : view.destinations.wallets.find((w) => request.destination.includes(w.address.slice(-4)))?.id;

  const after = (ok: boolean) => robotCues.emit(ok ? { kind: 'submitted' } : { kind: 'problem' });
  const stop = async (then?: () => void) => {
    const out = await run('Stop looking', (key) => withdrawRequestAction({ requestRef: request.ref }, key));
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
    if (!readyNow || !destination) return;
    robotCues.emit({ kind: 'wait', on: true });
    const out = await run(`${sell ? 'Sell' : 'Buy'} ${legAmount(readyNow, 'USDT')} USDT now`, (key) =>
      requestQuoteAction({ direction: request.direction, fixedSide: 'BASE', amount: readyNow, targetRate: null, ...(sell ? { bankAccountId: destination } : { walletId: destination }) }, key),
    );
    robotCues.emit({ kind: 'wait', on: false });
    after(out.ok);
  };
  const meet = async (at: string) => after((await run(`${sell ? 'Sell' : 'Buy'} at ${rateOf(at)}`, (key) => meetPeerAction({ requestRef: request.ref, rate: at }, key))).ok);
  const start = async () => {
    if (!meeting) return;
    const out = await run('Start the deal', (key) => startPeerAction({ matchRef: meeting.ref }, key));
    // Started: the robot locks in, as on an accepted quote; then the deal's own page.
    robotCues.emit(out.ok ? { kind: 'lock' } : { kind: 'problem' });
    if (out.ok && meeting.orderRef) router.push(`/deals/${encodeURIComponent(meeting.orderRef)}`);
  };
  const decline = async () => meeting && after((await run('Not this one', (key) => declinePeerAction({ matchRef: meeting.ref }, key))).ok);
  const resume = async () => after((await run('Still looking', (key) => stillLookingAction({ requestRef: request.ref }, key))).ok);
  const lookFor = async (hours: number) => after((await run('Look for longer', (key) => setWaitAction({ requestRef: request.ref, hours }, key))).ok);

  const online = wait?.tradersOnline ?? 0;
  const Other = sell ? 'Buyer' : 'Seller';
  const pushable = push.state === 'off' || push.state === 'asking';

  // A gap, said as the one figure that matters: how far the other client's price is from this client's own.
  const own = request.targetRate ? Rate.parse(request.targetRate, 'CLIENT').micro : null;
  const gap = near && own !== null ? (() => {
    const at = Rate.parse(near.rate, 'CLIENT').micro;
    return formatRate(Rate.ofMicro(at > own ? at - own : own - at, 'CLIENT'));
  })() : null;

  // One title per state; a sentence only where a figure cannot say it.
  const title = meeting
    ? meeting.role === 'MAKER' ? `A ${other} took your price` : `Waiting for the ${other}`
    : paused ? `You missed a ${other}`
      : ready ? `A ${other} is ready`
        : near && gap ? `A ${other} is ${gap} away`
          : onMarket ? 'Prices are paused for a moment' : 'Finding you a price';
  const body = onMarket && !meeting ? 'Your request is priced the moment the market rate is back.' : null;

  const chip = meeting
    ? meeting.role === 'MAKER' ? 'Another client · waiting for you' : `${Other} · asked to start`
    : ready ? 'Another client · ready now'
      : paused ? 'Paused for other clients'
        : `${onMarket ? 'Prices paused' : 'Searching'} · ${elapsed(now - since)}`;

  // The robot answers what happens in the book: it reads another client's price the moment one is there to act on, and
  // rests in the state of record (focused on a price to act on, waiting on the other client, concerned when paused).
  const mood = meeting?.role === 'MAKER' || ready ? 'focused' : paused ? 'alert' : 'waiting';
  const actionable = meeting?.role === 'MAKER' ? `maker:${meeting.ref}` : ready ? `ready:${ready.rate}` : near ? `near:${near.rate}` : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (actionable && actionable !== seen.current) robotCues.emit({ kind: 'rate' });
    seen.current = actionable;
  }, [actionable]);

  // The wait's own length, chosen on the sheet: a length already behind it cannot be chosen.
  const waitedMs = now - since;
  const hours = wait?.waitHours ?? 24;

  return (
    <>
      <section className={stage.deal} data-even="" data-waiting="" aria-label="Request waiting for a price" data-robot-target="panel">
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
          estimate={estimate ? `≈ ${estimate.figure}${estimate.unit ? ` ${estimate.unit}` : ''} at today’s market` : null}
          until={lookingUntil}
        >
          {stopping ? (
            <div className={styles.confirmRow} role="group" aria-label="Stop looking">
              <p>We stop looking for {request.ref}{meeting ? ', and the other client is told' : ''}. Nothing was committed, and you can ask again any time.</p>
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
              {!meeting ? (
                <div className={styles.lookFor} role="radiogroup" aria-label="Keep looking for">
                  <span className={styles.lookForLabel}>Keep looking for</span>
                  <span className={styles.lookForOptions}>
                    {LOOK_FOR.map((o) => (
                      <button
                        key={o.hours}
                        type="button"
                        role="radio"
                        aria-checked={o.hours === hours}
                        data-on={o.hours === hours || undefined}
                        disabled={busy || o.hours === hours || o.hours * 3_600_000 <= waitedMs + 60_000}
                        onClick={() => void lookFor(o.hours)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </span>
                </div>
              ) : null}
              <button type="button" className={`${shell.secondaryAction} ${shell.wide}`} onClick={changeAmount} disabled={busy}>
                Change the amount
              </button>
              <button type="button" className={shell.textAction} onClick={() => setStopping(true)} disabled={busy}>
                Stop looking
              </button>
            </div>
          )}
        </RequestSheet>

        {/* The quote's stage before there is a quote: the robot in its halo, what leads now, the one move. A meeting is
            the quote's own stage — the figure as a monument, its facts, the other client's time on the visor, one
            decision; a gap is a rail of two prices; the search is the radar and its facts. */}
        <div className={`${shell.brandField} ${stage.stage}`} data-searching="" data-peer={meeting || ready ? '' : undefined}>
          <div className={stage.halo} aria-hidden="true">
            <i />
            {meeting || ready ? null : (
              <>
                <span className={stage.radar} />
                <span className={stage.radar} />
                <span className={stage.radar} />
              </>
            )}
            <svg className={stage.haloArcs} viewBox="0 0 400 400" focusable="false">
              <path d="M 27.6 230.4 A 175 175 0 0 1 117.8 45.5" />
              <path d="M 282.2 45.5 A 175 175 0 0 1 372.4 230.4" />
              <path d="M 297.9 345 A 175 175 0 0 1 102.1 345" />
            </svg>
            {meeting || ready ? (
              <svg className={stage.haloOrbit} viewBox="0 0 400 400" focusable="false">
                <circle cx="200" cy="200" r="194" />
                <circle className={stage.haloNode} cx="32" cy="297" r="6" />
                <circle className={stage.haloNode} cx="368" cy="297" r="6" />
              </svg>
            ) : null}
          </div>
          <RobotFigure mood={mood} className={stage.robot} />

          <header className={stage.stageHead}>
            <span className={`${stage.chip} ${stage.peerChip}`}>
              {meeting || ready ? <MeetIcon /> : paused ? <PeerIcon /> : <span className={stage.liveDot} aria-hidden="true" />}
              <span className={stage.chipTime}>{chip}</span>
            </span>
            <span className={stage.ref}>{meeting ? meeting.ref : request.ref}</span>
          </header>

          <div className={stage.say} role="status">
            <h2 className={stage.sayTitle}>{title}</h2>
            {body ? <p className={stage.sayBody}>{body}</p> : null}
          </div>

          {deal ? (
            <>
              <div className={stage.get}>
                <span className={stage.getLabel}>You get</span>
                <span className={stage.getFigure}>
                  <Amount value={sell ? `₹${legAmount(deal.inr, 'INR')}` : cents(deal.base)} />
                  {sell ? null : <span className={stage.getUnit}>USDT</span>}
                </span>
              </div>
              <div className={stage.facts}>
                <span className={stage.fact} data-robot-target="rate">
                  <RateIcon />
                  <span>
                    <span className={stage.factFigure}>{rateOf(deal.rate)}</span> per USDT
                  </span>
                </span>
                <span className={stage.fact}>
                  {sell ? `${cents(deal.base)} USDT out` : `₹${legAmount(deal.inr, 'INR')} out`}
                </span>
                <span className={`${stage.fact} ${stage.factQuiet}`}>½ network · {cents(deal.network)} USDT</span>
              </div>
            </>
          ) : near && gap ? (
            <GapRail
              own={request.targetRate ? formatRate(Rate.parse(request.targetRate, 'CLIENT')) : (marketRate ?? 'Market')}
              ownLabel={request.targetRate ? 'You' : 'Market'}
              theirs={rateOf(near.rate)}
              theirLabel={Other}
              gap={gap}
            />
          ) : !paused && estimate ? (
            <div className={stage.expect}>
              <span className={stage.getLabel}>{expectLabel}</span>
              <span className={stage.expectFigure}>
                {estimate.figure}
                {estimate.unit ? <span className={stage.getUnit}>{estimate.unit}</span> : null}
              </span>
              <span className={stage.getSub}>{marketRate} per USDT · fixed when someone takes it</span>
            </div>
          ) : null}

          {!onMarket && wait && !meeting && !ready && !paused && !near ? (
            <ul className={stage.facts} aria-label="Your wait">
              <li className={stage.fact}>
                <UsersIcon />
                <span>
                  <span className={stage.factFigure}>{online}</span> {online === 1 ? 'trader online' : 'traders online'}
                </span>
              </li>
              <li className={stage.fact}>
                <UserIcon />
                <span>
                  <span className={stage.factFigure}>{ordinal(wait.ahead + 1)}</span> in line
                </span>
              </li>
            </ul>
          ) : null}

          <div className={meeting ? stage.decide : stage.waitMoves}>
            {meeting ? (
              <>
                <div className={stage.decideRow}>
                  <Countdown sentAt={new Date(Date.parse(meeting.yesUntil) - 3_600_000)} expiresAt={new Date(meeting.yesUntil)} now={now} variant="ring" />
                  {meeting.role === 'MAKER' ? (
                    <button type="button" className={stage.accept} data-robot-target="cta" onClick={() => void start()} disabled={busy} aria-busy={busy || undefined}>
                      {busy ? <ArcLoader size="sm" label="Starting the deal" tone="inherit" /> : <StateRing state="lock" />}
                      <span>Start the deal</span>
                      {busy ? null : <ArrowIcon className={shell.actionIcon} />}
                    </button>
                  ) : (
                    <p className={stage.waitNote}>The deal starts the moment they say yes.</p>
                  )}
                </div>
                {meeting.role === 'MAKER' ? (
                  <button type="button" className={`${shell.textAction} ${stage.onField}`} onClick={() => void decline()} disabled={busy}>
                    Not this one
                  </button>
                ) : null}
              </>
            ) : paused ? (
              <button type="button" className={stage.accept} data-robot-target="cta" onClick={() => void resume()} disabled={busy} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Saving" tone="inherit" /> : <CheckIcon />}
                <span>Still looking</span>
              </button>
            ) : ready ? (
              <button type="button" className={stage.accept} data-robot-target="cta" data-meet="" onClick={() => void meet(ready.rate)} disabled={busy} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Saying yes" tone="inherit" /> : <MeetIcon />}
                <span>
                  {sell ? 'Sell' : 'Buy'} at {rateOf(ready.rate)}
                </span>
                {busy ? null : <ArrowIcon className={shell.actionIcon} />}
              </button>
            ) : near ? (
              <button type="button" className={stage.accept} data-robot-target="cta" data-meet="" onClick={() => void meet(near.rate)} disabled={busy} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Saying yes" tone="inherit" /> : <MeetIcon />}
                <span>Meet at {rateOf(near.rate)}</span>
                {busy ? null : <ArrowIcon className={shell.actionIcon} />}
              </button>
            ) : readyNow ? (
              <>
                <button type="button" className={stage.accept} onClick={() => void takeReady()} disabled={busy || !destination} aria-busy={busy || undefined}>
                  {busy ? <ArcLoader size="sm" label="Getting the price" tone="inherit" /> : <BoltIcon />}
                  <span>
                    {sell ? 'Sell' : 'Buy'} {legAmount(readyNow, 'USDT')} USDT now
                  </span>
                  {busy ? null : <ArrowIcon className={shell.actionIcon} />}
                </button>
                <p className={stage.waitNote}>A trader has it ready, priced at once.</p>
              </>
            ) : null}

            {meeting?.role === 'MAKER' || ready || paused ? null : alerts.telegram.on ? (
              <p className={stage.waitTold}>
                <CheckIcon />
                Telegram{alerts.telegram.username ? ` · @${alerts.telegram.username}` : ''}
                {alerts.email ? ' and email' : ''}
              </p>
            ) : push.state === 'on' ? (
              <p className={stage.waitTold}>
                <CheckIcon />
                This browser{alerts.email ? ' and email' : ''}
              </p>
            ) : (
              <div className={stage.tellRow}>
                {pushable ? (
                  <button type="button" className={stage.onFieldLink} onClick={() => void push.turnOn()} disabled={push.state === 'asking'}>
                    <BellIcon />
                    <span>Notify me</span>
                  </button>
                ) : null}
                <Link className={stage.onFieldLink} href="/account#telegram">
                  <PlaneIcon />
                  <span>{pushable ? 'Telegram' : 'Notify me on Telegram'}</span>
                </Link>
              </div>
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
