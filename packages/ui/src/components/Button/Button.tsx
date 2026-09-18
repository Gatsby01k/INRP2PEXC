'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../cx.ts';
import { ArcLoader } from '../ArcLoader/ArcLoader.tsx';
import styles from './Button.module.css';

export type ButtonIntent = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  intent?: ButtonIntent;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  /** Hotkey hint shown to operators, e.g. "Q". */
  shortcut?: string;
  children: ReactNode;
}

export function Button({ intent = 'secondary', size = 'md', fullWidth, loading, shortcut, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(styles.button, styles[intent], styles[size], fullWidth && styles.full)}
    >
      {loading ? <ArcLoader size="sm" label="Working" tone="inherit" /> : null}
      <span className={styles.label}>{children}</span>
      {shortcut ? <kbd className={styles.kbd}>{shortcut}</kbd> : null}
    </button>
  );
}
