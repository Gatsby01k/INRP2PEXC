'use client';

import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './hint.module.css';

/**
 * The explanation a page used to print, kept one tap away: a small lit ring beside what it explains, and the words on a
 * visor when asked for — the page itself says only what is happening. It opens on a tap (and on hover where there is a
 * pointer), closes on a tap elsewhere, Escape or a scroll, and keeps itself inside the screen's edges.
 *
 * The words are drawn over everything (`document.body`), so no sheet beside or below the ring can cover them.
 */
export function Hint({ children, label = 'What this means', tone }: { children: ReactNode; label?: string; tone?: 'field' }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const id = useId();
  const dot = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const hover = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!dot.current?.contains(t) && !bubble.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, { passive: true, capture: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // Under the ring, centred on it — then slid back inside the screen if it would cross an edge.
  useLayoutEffect(() => {
    if (!open || !dot.current) return;
    const r = dot.current.getBoundingClientRect();
    setAt({ x: r.left + r.width / 2, y: r.bottom + 10 });
  }, [open]);
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!open || !el || !at) return;
    el.style.setProperty('--shift', '0px');
    const r = el.getBoundingClientRect();
    const pad = 12;
    const shift = r.left < pad ? pad - r.left : r.right > window.innerWidth - pad ? window.innerWidth - pad - r.right : 0;
    el.style.setProperty('--shift', `${Math.round(shift)}px`);
  }, [open, at]);

  const fine = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const later = (next: boolean, ms: number) => {
    if (!fine()) return;
    if (hover.current) window.clearTimeout(hover.current);
    hover.current = window.setTimeout(() => setOpen(next), ms);
  };
  const stay = () => {
    if (hover.current) window.clearTimeout(hover.current);
  };

  return (
    <span className={styles.hint} data-tone={tone}>
      <button
        ref={dot}
        type="button"
        className={styles.dot}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onPointerEnter={() => later(true, 140)}
        onPointerLeave={() => later(false, 220)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path className={styles.ring} d="M 15.66 5.2 A 7.5 7.5 0 1 1 11.3 2.61" />
          <circle className="ix-node" cx="14.2" cy="3.9" r="1.6" />
          <path className={styles.stem} d="M10 9v5" />
          <circle className={styles.tittle} cx="10" cy="6.4" r="1.1" />
        </svg>
      </button>
      {open && at
        ? createPortal(
            <span
              id={id}
              ref={bubble}
              role="note"
              className={styles.bubble}
              style={{ left: at.x, top: at.y } as CSSProperties}
              onPointerEnter={stay}
              onPointerLeave={() => later(false, 220)}
            >
              {children}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
