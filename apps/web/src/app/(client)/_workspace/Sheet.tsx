'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons.tsx';
import styles from './sheet.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** How long the sheet takes to leave, so it can be drawn leaving before it is removed (`sheet.module.css`). */
const EXIT_MS = 220;

/**
 * A task that needs the client's full attention without taking them off the page they were on: adding where they
 * are paid, archiving it, setting up an authenticator. From the right on a desktop, from the bottom on a phone.
 *
 * It is a real modal dialog: focus moves into it and is kept there, Escape and the scrim close it (unless `locked`,
 * while something is being sent), the page behind does not scroll, and focus returns to whatever opened it.
 * `variant="dialog"` is the same thing as a short centred card, for a single decision.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  eyebrow,
  children,
  footer,
  locked = false,
  variant = 'sheet',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  locked?: boolean;
  variant?: 'sheet' | 'dialog';
}) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open, mounted]);

  // Focus in on open, back to the opener on close; the page behind keeps its scroll position and stays still.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { overflow, paddingRight } = document.body.style;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    const frame = window.requestAnimationFrame(() => {
      const el = panel.current;
      const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el)?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      opener.current?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!mounted || typeof document === 'undefined') return null;

  const close = () => {
    if (!locked) onClose();
  };

  return createPortal(
    <div className={styles.root} data-variant={variant} data-state={leaving ? 'leaving' : 'open'}>
      <div className={styles.scrim} onClick={close} aria-hidden="true" />
      <div
        ref={panel}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description ? { 'aria-describedby': descId } : {})}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
            return;
          }
          if (e.key !== 'Tab') return;
          const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null);
          if (items.length === 0) return;
          const first = items[0]!;
          const last = items[items.length - 1]!;
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description ? (
              <p id={descId} className={styles.description}>
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" className={styles.close} onClick={close} disabled={locked} aria-label="Close">
            <CloseIcon className={styles.closeIcon} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
