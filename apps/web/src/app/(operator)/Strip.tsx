import Link from 'next/link';
import type { DeskStrip } from '@inrp2p/desk';
import { MarkArt } from '../../components/MarkArt.tsx';
import { inr, isPositive, usdtSummary } from './_desk/format.ts';
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
 * mark's orange, the page's one brand moment, turning to ink when the queue is clear — then the USDT the exchange
 * holds free, the trades in flight and today's realized margin. Every P2P deal is priced by its trader (ADR 0019), so
 * there are no desk route rates to show. Compact forms are used because it is a summary; every screen where the exact
 * figure is the evidence shows it in full (DECISIONS D-11).
 */
export function Strip({ strip, focus }: { strip: DeskStrip; focus: StripFocus }) {
  const items: KpiItem[] = [
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
      <div className={q.stripKpis}>
        <KpiBand items={items} label="Money available and work in flight" />
      </div>
    </div>
  );
}
