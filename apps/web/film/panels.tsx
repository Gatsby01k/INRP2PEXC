import type { CSSProperties, ReactNode } from 'react';
import { Money, Rate } from '@inrp2p/kernel';
import { ArcLoader, SettlementLegList, SettlementLegRow, SettlementProgress, TransactionHash } from '@inrp2p/ui';
import { formatIstTime, formatRate } from '@inrp2p/ui/format';
import { HeldFor } from '../src/app/(client)/exchange/HeldFor.tsx';
import { LEGS } from '../src/app/(client)/exchange/Legs.tsx';
import { legAmount } from '../src/app/(client)/exchange/amounts.ts';
import exchange from '../src/app/(client)/exchange/exchange.module.css';
import shell from '../src/app/(client)/shell.module.css';
import trade from '../src/app/(client)/trades/[tradeRef]/trade.module.css';
import type { Step } from '../src/app/(client)/_assistant/model.ts';
import { ArrowIcon, CheckIcon, InfoIcon } from '../src/app/(client)/_workspace/icons.tsx';
import { StatusPill } from '../src/app/(client)/_workspace/StatusPill.tsx';
import { Stepper } from '../src/app/(client)/_workspace/Stepper.tsx';
import { AT, TRADE, inOut, progress, productEase } from './timeline.ts';
import styles from './film.module.css';

/**
 * The product, as the film shows it: the workspace's own components and styles, composed the way its Exchange and
 * trade pages compose them, for one trade at one moment of the film. Nothing here is drawn for the film — a panel is
 * the product's markup with the trade's figures in it; what the film adds is only which panel shows when, and the
 * product's own entrance (a short fade and rise on its curve) as each one arrives.
 */

const RATE = formatRate(Rate.parse(TRADE.rate, 'CLIENT'));
const time = (iso: string) => formatIstTime(new Date(iso));

/** The product's entrance for something new: a quarter of a second, a few pixels of rise, on the product's curve. */
export function entrance(t: number, at: number, rise = 6): CSSProperties {
  const p = progress(t, at, at + 0.26, productEase);
  return p >= 1 ? {} : { opacity: p, transform: `translateY(${(1 - p) * rise}px)` };
}

/** How long the old state takes to leave; the new one arrives once it has gone, as a page does in the workspace. */
const LEAVE = 0.14;

/** Leaving: fading out before the new state takes its place. */
function exit(t: number, at: number): CSSProperties {
  const p = progress(t, at, at + LEAVE, productEase);
  return p <= 0 ? {} : { opacity: 1 - p };
}

/** The workspace shell's surface variables (its hairlines and lifts), without its page: no height, no background. */
function Surface({ children }: { children: ReactNode }) {
  return (
    <div className={shell.shell} style={{ display: 'block', minHeight: 0, background: 'none' }}>
      {children}
    </div>
  );
}

/** A request with the desk: the side the client fixed, the side the desk is pricing (PricingCard). */
function RequestTicket() {
  const [sold, received] = LEGS.SELL_USDT;
  return (
    <section className={shell.surface} aria-label="Request with the desk" data-robot-target="panel">
      <header className={exchange.ticketHead}>
        <div className={exchange.ticketId}>
          <span className={shell.label}>Request</span>
          <span className={exchange.ticketRef}>{TRADE.requestRef}</span>
          <span className={exchange.side}>Sell USDT</span>
        </div>
        <span className={exchange.pricing}>
          <ArcLoader size="sm" label="The desk is pricing this request" />
          With the desk
        </span>
      </header>
      <dl className={exchange.ledger} data-robot-target="amount">
        <div className={exchange.ledgerRow}>
          <dt>{sold.label}</dt>
          <dd>
            <span className={exchange.figure}>{legAmount(TRADE.usdt, 'USDT')}</span>
            <span className={exchange.unit}>USDT</span>
          </dd>
        </div>
        <div className={exchange.ledgerRow}>
          <dt>{received.label}</dt>
          <dd>
            <span className={exchange.figurePending}>Priced by the desk</span>
            <span className={exchange.unit}>INR</span>
          </dd>
        </div>
      </dl>
      <dl className={`${shell.facts} ${exchange.terms}`}>
        <div>
          <dt>Receive INR to</dt>
          <dd>{TRADE.destination}</dd>
        </div>
        <div>
          <dt>Sent</dt>
          <dd>{time(TRADE.requestedAt)}</dd>
        </div>
      </dl>
      <p className={shell.info}>
        <InfoIcon className={shell.infoIcon} />
        <span>The desk’s quote appears here as soon as it is sent — no need to reload.</span>
      </p>
    </section>
  );
}

/** The desk's firm quote, as an execution ticket (QuoteCard): held, priced, and the decision. */
function QuoteTicket({ t }: { t: number }) {
  const [sold, received] = LEGS.SELL_USDT;
  const quotedAt = Date.parse(TRADE.quotedAt);
  const now = quotedAt + Math.max(0, Math.min(t, AT.accepted) - AT.quote) * 1000;
  const expiresAt = new Date(quotedAt + TRADE.heldForMs);
  const busy = t >= AT.press && t < AT.accepted;
  const accepted = t >= AT.accepted;
  const pressed = t >= AT.press - 0.08 && t < AT.press + 0.1;
  return (
    <section className={shell.surface} aria-label="Firm quote" data-robot-target="panel">
      <header className={exchange.ticketHead}>
        <div className={exchange.ticketId}>
          <span className={shell.label}>Firm quote</span>
          <span className={exchange.ticketRef}>{TRADE.quoteRef}</span>
          <span className={exchange.side}>Sell USDT</span>
        </div>
        <HeldFor expiresAt={expiresAt} now={now} />
      </header>
      <dl className={exchange.ledger}>
        <div className={exchange.ledgerRow}>
          <dt>{sold.label}</dt>
          <dd>
            <span className={exchange.figure}>{legAmount(TRADE.usdt, 'USDT')}</span>
            <span className={exchange.unit}>USDT</span>
          </dd>
        </div>
        <div className={exchange.ledgerRow}>
          <dt>{received.label}</dt>
          <dd>
            <span className={exchange.figure}>{legAmount(TRADE.inr, 'INR')}</span>
            <span className={exchange.unit}>INR</span>
          </dd>
        </div>
      </dl>
      <div className={exchange.rate} data-robot-target="rate">
        <div className={exchange.headText}>
          <span className={shell.label}>Your rate</span>
          <span className={exchange.rateFigure}>
            <span className={exchange.rateValue}>{RATE}</span>
            <span className={exchange.rateUnit}>/ USDT</span>
          </span>
        </div>
        <span className={exchange.rateNote}>Locked until {formatIstTime(expiresAt)}</span>
      </div>
      <dl className={`${shell.facts} ${exchange.terms}`}>
        <div>
          <dt>Receive INR to</dt>
          <dd>{TRADE.destination}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>USDT on TRC20</dd>
        </div>
      </dl>
      {accepted ? (
        <p className={`${shell.info} ${styles.accepted}`} role="status" style={entrance(t, AT.accepted, 4)}>
          <CheckIcon className={shell.infoIcon} />
          <span>Accepted · rate locked into your trade</span>
        </p>
      ) : (
        <div className={exchange.actions}>
          <button
            type="button"
            className={`${shell.action} ${pressed ? styles.pressed : ''}`}
            data-robot-target="cta"
            data-film="accept"
            disabled={busy}
            aria-busy={busy || undefined}
            style={t >= AT.cursorOn && !busy ? { background: 'var(--brand-action-hover)', borderColor: 'var(--brand-action-hover)' } : undefined}
          >
            {busy ? <ArcLoader size="sm" label="Accepting" tone="inherit" /> : null}
            <span>Accept quote at {RATE}</span>
            {busy ? null : <ArrowIcon className={shell.actionIcon} />}
          </button>
          <button type="button" className={shell.secondaryAction} disabled={busy}>
            Decline
          </button>
        </div>
      )}
    </section>
  );
}

/** The trade's four stages, as the trade page's stepper shows them at `t`. */
function stepsAt(t: number): Step[] {
  const accepted: Step = { label: 'Quote accepted', status: 'done', detail: time(TRADE.acceptedAt) };
  if (t < AT.final) {
    return [
      accepted,
      { label: 'USDT received', status: 'current', detail: t < AT.seen ? 'waiting for your USDT' : 'seen, waiting to be final' },
      { label: 'INR payout', status: 'pending' },
      { label: 'Completed', status: 'pending' },
    ];
  }
  const received: Step = { label: 'USDT received', status: 'done', detail: time(TRADE.finalAt) };
  if (t < AT.complete) {
    return [accepted, received, { label: 'INR payout', status: 'current', detail: t < AT.payout ? 'preparing your payment' : 'paying out' }, { label: 'Completed', status: 'pending' }];
  }
  const done = TRADE.legs.at(-1)!.at;
  return [accepted, received, { label: 'INR payout', status: 'done', detail: time(done) }, { label: 'Completed', status: 'done', detail: time(done) }];
}

/** The trade's lifecycle state at `t`, in the portal's terms. */
function statusAt(t: number): string {
  if (t >= AT.complete) return 'COMPLETED';
  if (t >= AT.final) return AT.legs.some((l) => t >= l) ? 'PARTIALLY_SETTLED' : 'FIRST_LEG_CONFIRMED';
  return t >= AT.seen ? 'FIRST_LEG_DETECTED' : 'AWAITING_FIRST_LEG';
}

/** The trade page, in the column: which trade and how it stands, how far it has got, and the payout as it lands. */
function TradeRecord({ t }: { t: number }) {
  const steps = stepsAt(t);
  const confirmed = TRADE.legs.filter((_, i) => t >= AT.legs[i]!);
  const received = confirmed.reduce((sum, l) => sum.add(Money.parse(l.amount, 'INR')), Money.parse('0', 'INR'));
  const payout = t >= AT.payout;
  return (
    <div className={styles.column} data-robot-target="panel">
      <section className={shell.card} aria-label="Trade progress">
        <header className={`${exchange.ticketHead} ${styles.cardTicketHead}`}>
          <div className={exchange.ticketId}>
            <span className={shell.label}>Trade</span>
            <span className={exchange.ticketRef}>{TRADE.tradeRef}</span>
            <span className={exchange.side}>Sell USDT</span>
          </div>
          <StatusPill status={statusAt(t)} />
        </header>
        <Stepper steps={steps} label="Trade progress" />
        {t >= AT.seen && !payout ? (
          <div className={trade.transfer} style={entrance(t, AT.seen, 4)}>
            <span className={shell.label}>Your transfer</span>
            <TransactionHash hash={TRADE.txHash} finality={t >= AT.final ? 'Confirmed' : 'Seen, not final'} copy={false} />
          </div>
        ) : null}
      </section>
      {payout ? (
        <section className={shell.card} aria-label="INR settlement" style={entrance(t, AT.payout, 8)}>
          <h2 className={shell.cardTitle}>INR payout</h2>
          <SettlementProgress received={received} total={Money.parse(TRADE.inr, 'INR')} />
          <SettlementLegList>
            {confirmed.map((l, i) => (
              <Row key={l.utr} t={t} at={AT.legs[i]!} newest={i === confirmed.length - 1}>
                <SettlementLegRow audience="client" amount={Money.parse(l.amount, 'INR')} status="COMPLETED" utr={l.utr} at={new Date(l.at)} />
              </Row>
            ))}
          </SettlementLegList>
        </section>
      ) : null}
    </div>
  );
}

/**
 * A payment's row arriving. The row is the design system's own `<li>`; the film only fades it in, and marks the
 * newest one as where the robot looks.
 */
function Row({ t, at, newest, children }: { t: number; at: number; newest: boolean; children: ReactNode }) {
  return (
    <div className={styles.row} style={entrance(t, at, 6)} {...(newest ? { 'data-robot-target': 'row' } : {})}>
      {children}
    </div>
  );
}

/**
 * The product column at `t`: the request, the firm quote, then the trade. Each hands over to the next the way the
 * workspace does — the old state leaves as the new one arrives.
 */
export function ProductColumn({ t }: { t: number }) {
  if (t < AT.quote + 0.3) {
    // The opening pull finds the request as it arrives beside the robot, not as an edge of text at the frame's side.
    const reveal = progress(t, 1.9, 2.7, inOut);
    return (
      <Surface>
        <div className={styles.stack} style={reveal < 1 ? { opacity: reveal } : undefined}>
          {t < AT.quote + LEAVE ? (
            <div style={exit(t, AT.quote)}>
              <RequestTicket />
            </div>
          ) : null}
          {t >= AT.quote + LEAVE ? (
            <div style={entrance(t, AT.quote + LEAVE)}>
              <QuoteTicket t={t} />
            </div>
          ) : null}
        </div>
      </Surface>
    );
  }
  if (t < AT.trade + 0.3) {
    return (
      <Surface>
        <div className={styles.stack}>
          {t < AT.trade + LEAVE ? (
            <div style={exit(t, AT.trade)}>
              <QuoteTicket t={t} />
            </div>
          ) : null}
          {t >= AT.trade + LEAVE ? (
            <div style={entrance(t, AT.trade + LEAVE)}>
              <TradeRecord t={t} />
            </div>
          ) : null}
        </div>
      </Surface>
    );
  }
  return (
    <Surface>
      <TradeRecord t={t} />
    </Surface>
  );
}
