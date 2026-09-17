import type { ReactNode, TdHTMLAttributes } from 'react';
import { cx } from '../../cx.ts';
import styles from './NumericCell.module.css';

export type NumericEmphasis = 'default' | 'strong' | 'muted' | 'positive' | 'negative';

/** Right-aligned tabular number cell for operator tables. Content is pre-formatted text. */
export function NumericCell({ children, emphasis = 'default', as = 'td', ...rest }: { children: ReactNode; emphasis?: NumericEmphasis; as?: 'td' | 'th' | 'span' } & Omit<TdHTMLAttributes<HTMLTableCellElement>, 'className' | 'children'>) {
  const Tag = as;
  return (
    <Tag {...(rest as object)} className={cx(styles.cell, 'ix-num', styles[emphasis])}>
      {children}
    </Tag>
  );
}
