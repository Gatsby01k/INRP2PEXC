import type { ReactNode } from 'react';
import { cx } from '../../cx.ts';
import styles from './TradeTable.module.css';

export interface TradeTableColumn<Row> {
  key: string;
  header: string;
  numeric?: boolean;
  render: (row: Row) => ReactNode;
  sortable?: boolean;
}

export interface TradeTableProps<Row> {
  caption: string;
  columns: readonly TradeTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  sort?: { key: string; direction: 'ascending' | 'descending' };
  onSort?: (key: string) => void;
  onRowOpen?: (row: Row) => void;
}

/** Dense operator table. Numeric columns right-aligned and tabular; sort state exposed with aria-sort. */
export function TradeTable<Row>({ caption, columns, rows, rowKey, sort, onSort, onRowOpen }: TradeTableProps<Row>) {
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption className={styles.caption}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" className={cx(c.numeric && styles.numeric)} aria-sort={active ? sort!.direction : c.sortable ? 'none' : undefined}>
                  {c.sortable && onSort ? (
                    <button type="button" className={styles.sort} onClick={() => onSort(c.key)}>
                      {c.header}
                      <span aria-hidden="true" className={styles.arrow}>
                        {active ? (sort!.direction === 'ascending' ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={cx(onRowOpen && styles.clickable)} onClick={onRowOpen ? () => onRowOpen(row) : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={cx(c.numeric && styles.numeric, c.numeric && 'ix-num')}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
