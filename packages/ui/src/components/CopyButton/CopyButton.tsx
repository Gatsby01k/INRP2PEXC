'use client';

import { useState } from 'react';
import { cx } from '../../cx.ts';
import styles from './CopyButton.module.css';

/** `defaultCopied` renders the confirmation state directly (Storybook state coverage); it clears on the next copy cycle. */
export function CopyButton({ value, label, defaultCopied = false }: { value: string; label: string; defaultCopied?: boolean }) {
  const [copied, setCopied] = useState(defaultCopied);
  return (
    <button
      type="button"
      className={cx(styles.button, copied && styles.copied)}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
      <span className="ix-visually-hidden"> {label}</span>
    </button>
  );
}
