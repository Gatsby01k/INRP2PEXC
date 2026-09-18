import { Money } from '@inrp2p/kernel';
import type { DeskStrip } from '@inrp2p/desk';
import { formatInr, formatInrCompact, formatUsdtCompact } from '@inrp2p/ui/format';
import styles from './strip.module.css';

/**
 * The operational strip (UX_FLOWS W5). Compact forms are used here because it is a summary; every screen where
 * the exact figure is the evidence shows it in full (DECISIONS D-11).
 */
export function Strip({ strip }: { strip: DeskStrip }) {
  const items: { label: string; value: string; tone?: 'warning' }[] = [];
  for (const route of strip.routes ?? []) {
    items.push({
      label: `${route.routeName} ${route.direction === 'SELL_USDT' ? 'USDT→INR' : 'INR→USDT'}`,
      value: route.rate ? `₹${route.rate}` : 'no rate',
      ...(route.rate ? {} : { tone: 'warning' as const }),
    });
  }
  items.push({ label: 'INR available today', value: formatInrCompact(Money.parse(strip.inrAvailableToday, 'INR')) });
  items.push({ label: 'USDT available', value: formatUsdtCompact(Money.parse(strip.usdtAvailable, 'USDT')) });
  items.push({ label: 'Open trades', value: String(strip.openTrades) });
  if (strip.tradesOnHold > 0) items.push({ label: 'On hold', value: String(strip.tradesOnHold), tone: 'warning' });
  if (strip.realizedMarginToday !== undefined) {
    items.push({ label: 'Gross margin today (realized)', value: formatInr(Money.parse(strip.realizedMarginToday, 'INR')) });
  }

  return (
    <dl className={styles.strip} aria-label="Operational status">
      {items.map((i) => (
        <div key={i.label} className={styles.item}>
          <dt className={styles.label}>{i.label}</dt>
          <dd className={`${styles.value} ix-num ${i.tone === 'warning' ? styles.warning : ''}`}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
