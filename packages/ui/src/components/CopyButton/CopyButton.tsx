'use client';

import { useState } from 'react';
import { cx } from '../../cx.ts';
import styles from './CopyButton.module.css';

const icon = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false };

/**
 * Copies one value: a glyph that turns into a tick for a moment once the value is on the clipboard. Its name is
 * always the words — "Copy account number", "Copied account number" — so it is never a bare icon to a screen reader.
 *
 * `defaultCopied` renders the confirmation state directly (Storybook state coverage); it clears on the next copy cycle.
 */
export function CopyButton({ value, label, defaultCopied = false }: { value: string; label: string; defaultCopied?: boolean }) {
  const [copied, setCopied] = useState(defaultCopied);
  return (
    <button
      type="button"
      className={cx(styles.button, copied && styles.copied)}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? (
        <svg {...icon}>
          <path d="m5.5 12.5 4 4 9-9" />
        </svg>
      ) : (
        <svg {...icon}>
          <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" />
          <path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8" />
        </svg>
      )}
      <span className="ix-visually-hidden">
        {copied ? 'Copied' : 'Copy'} {label}
      </span>
    </button>
  );
}
