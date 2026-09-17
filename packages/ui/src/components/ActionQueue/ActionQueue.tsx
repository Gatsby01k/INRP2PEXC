import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../cx.ts';
import styles from './ActionQueue.module.css';

export type QueueGroupKey = 'needs_action' | 'processing' | 'waiting_client' | 'settlement' | 'exception';

export interface QueueItem {
  id: string;
  client: string;
  /** e.g. "SELL 100,000 USDT" (pre-formatted by the page from Money). */
  amount: string;
  asks?: string;
  route?: string;
  /** Potential margin, pre-formatted ("+₹220,000"). */
  margin?: string;
  status: string;
  action?: { label: string; shortcut?: string; onAction: () => void };
  emphasis?: 'action' | 'exception' | 'none';
}

export interface QueueGroup {
  key: QueueGroupKey;
  items: readonly QueueItem[];
}

const TITLES: Record<QueueGroupKey, string> = {
  needs_action: 'Needs action',
  exception: 'Exception',
  settlement: 'Settlement',
  waiting_client: 'Waiting client',
  processing: 'Processing',
};

/** Priority order is fixed so critical work is never buried (brief "Desk queue"). */
export const QUEUE_ORDER: readonly QueueGroupKey[] = ['needs_action', 'exception', 'settlement', 'waiting_client', 'processing'];

/**
 * The desk work queue: what needs action right now. Rows are keyboard navigable
 * (↑/↓ move, Enter opens) and actionable rows carry a thin orange rail; exceptions a red rail.
 */
export function ActionQueue({ groups, onOpen, emptyState }: { groups: readonly QueueGroup[]; onOpen?: (id: string) => void; emptyState?: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const ordered = QUEUE_ORDER.map((k) => groups.find((g) => g.key === k)).filter((g): g is QueueGroup => Boolean(g && g.items.length));

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    const rows = Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]') ?? []);
    const i = rows.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows[Math.min(rows.length - 1, i + 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows[Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'Enter' && e.target === e.currentTarget) {
      onOpen?.(id);
    }
  };

  if (ordered.length === 0) return <>{emptyState ?? null}</>;

  return (
    <table ref={tableRef} className={styles.table} aria-label="Desk queue">
      <thead className="ix-visually-hidden">
        <tr>
          <th scope="col">Client</th>
          <th scope="col">Amount</th>
          <th scope="col">Client asks</th>
          <th scope="col">Route</th>
          <th scope="col">Potential margin</th>
          <th scope="col">Status</th>
          <th scope="col">Next action</th>
        </tr>
      </thead>
      {ordered.map((g) => (
        <tbody key={g.key} className={cx(styles.group, styles[g.key])}>
          <tr className={styles.groupRow}>
            <th scope="colgroup" colSpan={7} className={styles.groupTitle}>
              {TITLES[g.key]} <span className={styles.count}>({g.items.length})</span>
            </th>
          </tr>
          {g.items.map((item) => (
            <tr key={item.id} data-row tabIndex={0} className={cx(styles.row, styles[`emphasis_${item.emphasis ?? (g.key === 'exception' ? 'exception' : g.key === 'needs_action' ? 'action' : 'none')}`])} onKeyDown={(e) => onKey(e, item.id)} onDoubleClick={() => onOpen?.(item.id)}>
              <td className={styles.client}>{item.client}</td>
              <td className={cx(styles.num, 'ix-num')}>{item.amount}</td>
              <td className={cx(styles.num, 'ix-num')}>{item.asks ? <><span className={styles.k}>asks</span> {item.asks}</> : '—'}</td>
              <td className={cx(styles.num, styles.route, 'ix-num')}>{item.route ? <><span className={styles.k}>route</span> {item.route}</> : '—'}</td>
              <td className={cx(styles.num, styles.margin, 'ix-num')}>{item.margin ?? '—'}</td>
              <td className={styles.status}>{item.status}</td>
              <td className={styles.action}>
                {item.action ? (
                  <button type="button" className={styles.actionButton} onClick={item.action.onAction}>
                    {item.action.label}
                    {item.action.shortcut ? <kbd className={styles.kbd}>{item.action.shortcut}</kbd> : null}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
