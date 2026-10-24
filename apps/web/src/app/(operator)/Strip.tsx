import Link from 'next/link';
import type { DeskStrip, StripRoute } from '@inrp2p/desk';
import { MarkArt } from '../../components/MarkArt.tsx';
import { Age } from './_desk/clock.tsx';
import { ROUTE_RATE_STALE_SECONDS, inr, inrCompact, isPositive, rate, usdtSummary } from './_desk/format.ts';
import { KpiBand, type KpiItem } from './_desk/ui.tsx';
import d from './_desk/desk.module.css';
import q from './queue.module.css';

/** What in the queue is the desk's own to move: priced or paid by the desk now, held by a case, or being settled. */
export interface StripFocus {
  readonly act: number;
  readonly blocked: number;
  readonly settling: number;
}

/**
 * The operational strip (UX_FLOWS W5). First the one figure that says how much is the desk's to move — on the
 * mark's orange, the page's one brand moment, turning to ink when the queue is clear — then the route rates (each
 * desk route, both directions, how old each rate is), then the INR the desk can still pay today, the USDT it can
 * deliver, the trades in flight and today's realized margin. Compact forms are used because it is a summary; every
 * screen where the exact figure is the evidence shows it in full (DECISIONS D-11).
 */
export function Strip({ strip, now, focus }: { strip: DeskStrip; now: string; focus: StripFocus }) {
  const nowMs = new Date(now).getTime();
  const routes = new Map<string, { name: string; sell?: StripRoute; buy?: StripRoute }>();
  for (const r of strip.routes ?? []) {
    const entry = routes.get(r.routeId) ?? { name: r.routeName };
    if (r.direction === 'SELL_USDT') entry.sell = r;
    else entry.buy = r;
    routes.set(r.routeId, entry);
  }
  const stale = (r?: StripRoute) => !r?.publishedAt || nowMs - new Date(r.publishedAt).getTime() > ROUTE_RATE_STALE_SECONDS * 1000;
  const cell = (r?: StripRoute) =>
    r?.rate ? (
      <span className={q.rateCell} {...(stale(r) ? { 'data-stale': '' } : {})}>
        <span className={q.rateValue}>{rate(r.rate)}</span>
        <span className={q.rateAge}>
          {stale(r) ? 'stale · ' : ''}
          <Age at={r.publishedAt!} short />
        </span>
      </span>
    ) : (
      <span className={q.rateCell} data-stale="">
        <span className={q.rateValue}>—</span>
        <span className={q.rateAge}>no rate</span>
      </span>
    );

  const items: KpiItem[] = [
    { key: 'inr', label: 'INR payable', value: <span title={`${inr(strip.inrAvailableToday)} across the settlement accounts today`}>{inrCompact(strip.inrAvailableToday)}</span>, sub: 'today', href: '/inr' },
    { key: 'usdt', label: 'USDT free', value: <span title="Treasury less what is reserved for open trades">{usdtSummary(strip.usdtAvailable)}</span>, sub: 'less reserved', href: '/usdt' },
    {
      key: 'open',
      label: 'Open trades',
      value: String(strip.openTrades),
      sub: strip.tradesOnHold > 0 ? <span className={d.negative}>{strip.tradesOnHold} on hold</span> : 'none on hold',
      href: '/orders',
    },
    ...(strip.realizedMarginToday !== undefined
      ? [
          {
            key: 'margin',
            label: 'Margin today',
            value: <span title="Gross margin realized in the ledger today (IST)">{inr(strip.realizedMarginToday, { sign: isPositive(strip.realizedMarginToday, 'INR') })}</span>,
            sub: 'realized',
            href: '/pnl',
            ...(isPositive(strip.realizedMarginToday, 'INR') ? { tone: 'success' as const } : {}),
          },
        ]
      : []),
  ];

  const total = focus.act + focus.blocked;
  const view = focus.act === 0 && focus.blocked > 0 ? 'exception' : 'needs_action';
  return (
    <div className={q.stripRow} aria-label="Operational status">
      <Link href={total > 0 ? `/?view=${view}` : '/'} className={q.focus} {...(total === 0 ? { 'data-calm': '' } : {})} data-testid="desk-focus">
        <MarkArt className={q.focusArt} stages={total === 0 ? 3 : focus.blocked > 0 ? 1 : 2} hub={false} />
        <span className={q.focusLabel}>{total > 0 ? 'Needs the desk' : 'Queue is clear'}</span>
        <span className={q.focusFigure}>
          <span className={q.focusCount}>{total}</span>
          <span className={q.focusWords}>{total === 1 ? 'thing to move now' : total > 0 ? 'things to move now' : 'nothing waiting on the desk'}</span>
        </span>
        <span className={q.focusParts}>
          {focus.act > 0 ? <span className={q.focusPart}>{focus.act} to act</span> : null}
          {focus.blocked > 0 ? (
            <span className={q.focusPart} data-tone="alert">
              {focus.blocked} blocked
            </span>
          ) : null}
          {focus.settling > 0 ? <span className={q.focusPart}>{focus.settling} settling</span> : null}
          {total === 0 && focus.settling === 0 ? <span className={q.focusPart}>new work appears here</span> : null}
        </span>
      </Link>
      {routes.size > 0 ? (
        <Link href="/rates" className={q.rates} aria-label="Route rates">
          <table className={q.ratesTable}>
            <thead>
              <tr>
                <th scope="col">Route rates</th>
                <th scope="col">USDT → INR</th>
                <th scope="col">INR → USDT</th>
              </tr>
            </thead>
            <tbody>
              {[...routes.entries()].map(([id, r]) => (
                <tr key={id}>
                  <th scope="row">{r.name}</th>
                  <td>{cell(r.sell)}</td>
                  <td>{cell(r.buy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Link>
      ) : null}
      <div className={q.stripKpis}>
        <KpiBand items={items} label="Money available and work in flight" />
      </div>
    </div>
  );
}
