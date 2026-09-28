import { Money } from '@inrp2p/kernel';
import type { DeskTrade } from '@inrp2p/desk';
import { StatusGlyph } from '@inrp2p/ui';
import { inr, inrCompact, money, payoutAsset, rate, rateDelta, receivableAsset, share, sub, time, usdt, usdtCompact } from '../_desk/format.ts';
import { Meter } from '../_desk/ui.tsx';
import t from './trade.module.css';

/**
 * The parts of a trade that are read, not acted on: what was agreed, what it makes, how far it has got.
 * Server-renderable; the frozen terms come from the trade, never from a recomputation here (FI-10).
 */

export function Headline({ trade, large = false }: { trade: DeskTrade; large?: boolean }) {
  const sell = trade.direction === 'SELL_USDT';
  const base = usdt(trade.base, { exact: false });
  const quote = inr(trade.quoteInr);
  return (
    <div className={t.headline}>
      <div className={`${t.amounts} ${large ? t.amountsLg : ''}`}>
        <span>{sell ? base : quote}</span>
        <span className={t.arrow} aria-label="to">
          →
        </span>
        <span>{sell ? quote : base}</span>
      </div>
      {trade.clientRate ? <span className={t.at}>at {rate(trade.clientRate)} per USDT · TRC20</span> : <span className={t.at}>TRC20 · client rate frozen at acceptance</span>}
    </div>
  );
}

/**
 * Client rate, route rate, spread and margin — kept visibly apart so a route rate can never be read as a price
 * (brief, "Margin visualization"). Only rendered with `economics:view`; the read model omits the fields otherwise.
 */
export function Economics({ trade, realized, compact = false }: { trade: DeskTrade; realized: boolean; compact?: boolean }) {
  if (!trade.clientRate || !trade.routeRate || trade.expectedMargin === undefined) return null;
  const spread = rateDelta(trade.routeRate, trade.clientRate);
  const negative = Money.parse(trade.expectedMargin, 'INR').isNegative();
  return (
    <div className={t.econ} aria-label="Trade economics" {...(compact ? { 'data-compact': '' } : {})}>
      <div className={t.econItem}>
        <span className={t.econLabel}>Client rate</span>
        <span className={t.econValue}>{rate(trade.clientRate)}</span>
        <span className={t.econSub}>frozen at acceptance</span>
      </div>
      <div className={t.econItem} data-kind="route">
        <span className={t.econLabel}>Route rate</span>
        <span className={t.econValue}>{rate(trade.routeRate)}</span>
        <span className={t.econSub}>{trade.payoutOptions.routeName ?? 'route'}{trade.executionMode === 'DIRECT_TO_CLIENT' ? ' · direct' : ''}</span>
      </div>
      <div className={t.econItem}>
        <span className={t.econLabel}>Spread</span>
        <span className={t.econValue}>{spread.text.replace(/^[+−±]/, '')}</span>
        <span className={t.econSub}>per USDT</span>
      </div>
      <div className={t.econItem} data-kind="margin" {...(negative ? { 'data-negative': '' } : {})}>
        <span className={t.econLabel}>{realized ? 'Gross margin' : 'Expected margin'}</span>
        <span className={t.econValue}>{inr(trade.expectedMargin, { sign: true })}</span>
        <span className={t.econSub}>{realized ? 'realized in the ledger' : 'not yet realized'}</span>
      </div>
    </div>
  );
}

type StageState = 'done' | 'partial' | 'pending' | 'blocked';

/** Stage captions are a summary: compact where the figure is large, exact on the legs below (D-11). */
const compact = (amount: string, asset: 'INR' | 'USDT') => (asset === 'INR' ? inrCompact(amount) : usdtCompact(amount));

/** Quote accepted → client funds → payout → completed: the four structural stages (UX_FLOWS F1), direction-aware. */
export function Stages({ trade }: { trade: DeskTrade }) {
  const sell = trade.direction === 'SELL_USDT';
  const inAsset = receivableAsset(trade.direction);
  const outAsset = payoutAsset(trade.direction);
  const received = Money.parse(trade.received, inAsset);
  const paid = Money.parse(trade.paid, outAsset);
  const owed = Money.parse(trade.payout.amount, outAsset);
  const cancelled = trade.lifecycle === 'CANCELLED';
  const completed = trade.lifecycle === 'COMPLETED';

  const fundsState: StageState = trade.hold && !received.isPositive() ? 'blocked' : ['FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED', 'COMPLETED'].includes(trade.lifecycle) ? 'done' : trade.lifecycle === 'FIRST_LEG_DETECTED' ? 'partial' : 'pending';
  const payoutState: StageState = completed ? 'done' : paid.isPositive() || trade.lifecycle === 'SETTLING' || trade.lifecycle === 'PARTIALLY_SETTLED' ? (trade.hold ? 'blocked' : 'partial') : trade.hold && fundsState === 'done' ? 'blocked' : 'pending';
  const confirmedIn = trade.legs.find((l) => l.side === 'CLIENT_TO_EXCHANGE' && l.status === 'COMPLETED');

  const stages: { name: string; state: StageState; sub: string }[] = [
    { name: 'Quote accepted', state: 'done', sub: time(trade.openedAt) },
    {
      name: sell ? 'USDT received' : 'INR received',
      state: cancelled && fundsState !== 'done' ? 'pending' : fundsState,
      sub: received.isPositive() ? `${compact(trade.received, inAsset)}${confirmedIn?.confirmedAt ? ` · ${time(confirmedIn.confirmedAt)}` : ''}` : `${compact(trade.receivable.amount, inAsset)} expected`,
    },
    {
      name: sell ? 'INR payout' : 'USDT payout',
      state: cancelled ? 'pending' : payoutState,
      sub: paid.minor === owed.minor && owed.isPositive() ? `${compact(trade.paid, outAsset)} paid in full` : paid.isPositive() ? `${compact(trade.paid, outAsset)} of ${compact(trade.payout.amount, outAsset)}` : `${compact(trade.payout.amount, outAsset)} owed`,
    },
    { name: cancelled ? 'Cancelled' : 'Completed', state: completed ? 'done' : cancelled ? 'blocked' : 'pending', sub: completed ? 'receipt issued' : cancelled ? 'no settlement' : paid.minor === owed.minor && owed.isPositive() ? 'closing' : '—' },
  ];
  return (
    <ol className={t.stages} aria-label="Trade progress">
      {stages.map((s) => (
        <li key={s.name} className={t.stage} data-state={s.state}>
          <span className={t.stageName}>
            <StatusGlyph state={s.state === 'done' ? 'done' : s.state === 'partial' ? 'partial' : s.state === 'blocked' ? 'closed' : 'pending'} />
            {s.name}
          </span>
          <span className={t.stageSub}>{s.sub}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Obligation · confirmed · in flight · unallocated, with one bar (UX_FLOWS W6). "Unallocated" is what a new leg
 * may still be created for (FI-20); the command checks it again inside its transaction.
 */
export function SettlementFigures({ trade }: { trade: DeskTrade }) {
  const asset = trade.payoutOptions.asset;
  const inFlight = sub(trade.committed, trade.paid, asset);
  return (
    <div className={t.progress}>
      <div className={t.progressFigures}>
        <div className={t.figure} data-tone="strong">
          <span className={t.figureLabel}>Obligation</span>
          <span className={t.figureValue}>{money(trade.payout.amount, asset)}</span>
        </div>
        <div className={t.figure} data-tone="success">
          <span className={t.figureLabel}>Confirmed</span>
          <span className={t.figureValue}>{money(trade.paid, asset)}</span>
        </div>
        <div className={t.figure}>
          <span className={t.figureLabel}>In flight</span>
          <span className={t.figureValue}>{money(inFlight, asset)}</span>
        </div>
        <div className={t.figure}>
          <span className={t.figureLabel}>Unallocated</span>
          <span className={t.figureValue}>{money(trade.unallocated, asset)}</span>
        </div>
      </div>
      <Meter
        label={`${money(trade.paid, asset)} of ${money(trade.payout.amount, asset)} confirmed, ${money(inFlight, asset)} in flight`}
        parts={[
          { value: share(trade.paid, trade.payout.amount, asset), tone: 'success' },
          { value: share(inFlight, trade.payout.amount, asset), tone: 'flight' },
        ]}
      />
    </div>
  );
}
