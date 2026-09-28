'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import s from './desk.module.css';

export interface Column<R> {
  readonly key: string;
  readonly header: ReactNode;
  readonly align?: 'right';
  readonly width?: number | string;
  readonly wrap?: boolean;
  readonly render: (row: R) => ReactNode;
}

export interface RowGroup<R> {
  readonly key: string;
  readonly title: ReactNode;
  readonly tone?: 'danger' | 'brand';
  readonly rows: readonly R[];
}

export interface DataTableProps<R> {
  readonly caption: string;
  readonly columns: readonly Column<R>[];
  readonly rows?: readonly R[];
  /** Grouped rows render a header row per group, in the order given; empty groups are skipped. */
  readonly groups?: readonly RowGroup<R>[];
  readonly rowKey: (row: R) => string;
  readonly onOpen?: (row: R) => void;
  readonly selectedKey?: string | null;
  readonly rail?: (row: R) => 'action' | 'danger' | 'muted' | null;
  readonly dim?: (row: R) => boolean;
  /** A row-scoped hotkey: return true when the key was handled. Never fires while typing or with a modifier. */
  readonly onRowKey?: (row: R, key: string) => boolean;
  readonly empty?: ReactNode;
  readonly testId?: string;
  readonly label?: string;
}

/**
 * The desk's one table. Dense, tabular numbers right-aligned, a thin rail for rows that want the operator (orange)
 * or are blocked (red), and a keyboard model that works without the mouse: rows are in the tab order, ↑/↓ and j/k
 * move between them, Enter opens, and a row can own letter hotkeys (the desk's Q, P, U, E).
 */
export function DataTable<R>({ caption, columns, rows, groups, rowKey, onOpen, selectedKey, rail, dim, onRowKey, empty, testId, label }: DataTableProps<R>) {
  const table = useRef<HTMLTableElement>(null);
  const all = groups ? groups.flatMap((g) => g.rows) : (rows ?? []);

  const move = (from: HTMLTableRowElement, delta: number) => {
    const list = Array.from(table.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]') ?? []);
    const i = list.indexOf(from);
    list[Math.max(0, Math.min(list.length - 1, i + delta))]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: R) => {
    if (e.target !== e.currentTarget) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      move(e.currentTarget, 1);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      move(e.currentTarget, -1);
    } else if (e.key === 'Enter' && onOpen) {
      e.preventDefault();
      onOpen(row);
    } else if (onRowKey && e.key.length === 1 && onRowKey(row, e.key.toLowerCase())) {
      e.preventDefault();
    }
  };

  if (all.length === 0) return <>{empty ?? null}</>;

  const renderRow = (row: R) => {
    const key = rowKey(row);
    const r = rail?.(row) ?? null;
    const interactive = Boolean(onOpen);
    return (
      <tr
        key={key}
        data-row=""
        data-row-id={key}
        tabIndex={interactive || onRowKey ? 0 : undefined}
        aria-selected={selectedKey !== undefined ? selectedKey === key : undefined}
        {...(interactive ? { 'data-open': '' } : {})}
        {...(r ? { 'data-rail': r } : {})}
        {...(dim?.(row) ? { 'data-dim': '' } : {})}
        onClick={
          interactive
            ? (e) => {
                // A click on a control inside the row belongs to that control.
                if ((e.target as HTMLElement).closest('button, a, input, select, textarea, label')) return;
                onOpen?.(row);
              }
            : undefined
        }
        onKeyDown={(e) => onKey(e, row)}
      >
        {columns.map((c) => (
          <td key={c.key} {...(c.align ? { 'data-align': c.align } : {})} {...(c.wrap ? { 'data-wrap': '' } : {})} style={c.width !== undefined ? { width: c.width } : undefined}>
            {c.render(row)}
          </td>
        ))}
      </tr>
    );
  };

  return (
    <div className={s.tableWrap} {...(testId ? { 'data-testid': testId } : {})}>
      <table ref={table} className={s.table} {...(label ? { 'aria-label': label } : {})}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" {...(c.align ? { 'data-align': c.align } : {})} style={c.width !== undefined ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        {groups ? (
          groups
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <tbody key={g.key}>
                <tr className={s.groupRow}>
                  <th scope="colgroup" colSpan={columns.length} {...(g.tone ? { 'data-tone': g.tone } : {})}>
                    {g.title}
                    <span className={s.groupCount}>{g.rows.length}</span>
                  </th>
                </tr>
                {g.rows.map(renderRow)}
              </tbody>
            ))
        ) : (
          <tbody>{(rows ?? []).map(renderRow)}</tbody>
        )}
      </table>
    </div>
  );
}

/** Two-line cell: the thing, and what it is. */
export function Cell({ main, sub, mono }: { main: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <>
      <span className={s.cellMain} style={mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-meta)', fontWeight: 'var(--font-weight-regular)' } : undefined}>
        {main}
      </span>
      {sub ? <span className={s.cellSub}>{sub}</span> : null}
    </>
  );
}
