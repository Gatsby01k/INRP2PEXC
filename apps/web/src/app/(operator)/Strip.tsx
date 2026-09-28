import Link from 'next/link';
import type { DeskStrip, StripRoute } from '@inrp2p/desk';
import { Age } from './_desk/clock.tsx';
import { ROUTE_RATE_STALE_SECONDS, inr, inrCompact, rate, usdtCompact } from './_desk/format.ts';
import { KpiBand, type KpiItem } from './_desk/ui.tsx';
import q from './queue.module.css';

/**
 * The operational strip (UX_FLOWS W5): the numbers a dealer needs before pricing anything. Route rates sit in one
 * cluster — each desk route, both directions, how old each rate is — beside the INR the desk can still pay today,
 * the USDT it can deliver, the trades in flight and today's realized margin. Compact forms are used because it is a
 * summary; every screen where the exact figure is the evidence shows it in full (DECISIONS D-11).
 */
export function Strip({ strip, now }: { strip: DeskStrip; now: string }) {
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
    { key: 'inr', label: 'INR available today', value: inrCompact(strip.inrAvailableToday), sub: inr(strip.inrAvailableToday), href: '/inr' },
    { key: 'usdt', label: 'USDT available', value: usdtCompact(strip.usdtAvailable), sub: 'treasury less reserved', href: '/usdt' },
    {
      key: 'open',
      label: 'Open trades',
      value: String(strip.openTrades),
      sub: strip.tradesOnHold > 0 ? `${strip.tradesOnHold} on hold` : 'none on hold',
      href: '/orders',
      ...(strip.tradesOnHold > 0 ? { tone: 'danger' as const } : {}),
    },
    ...(strip.realizedMarginToday !== undefined
      ? [{ key: 'margin', label: 'Gross margin today', value: inr(strip.realizedMarginToday, { sign: true }), sub: 'realized in the ledger', href: '/pnl', tone: 'success' as const }]
      : []),
  ];

  return (
    <div className={q.stripRow} aria-label="Operational status">
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
      <KpiBand items={items} label="Money available and work in flight" />
    </div>
  );
}
