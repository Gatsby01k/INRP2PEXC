'use client';

import { useEffect } from 'react';

/** How long one character takes to roll; the class is taken off just after, so the next change rolls again. */
const ROLL_MS = 520;

/**
 * Figures that change roll like a counter: when a digit of a figure (`Amount`, `data-amount`) or of a display marked
 * `data-roll` (a countdown) changes, the old character slides out and the new one in — up when it grows, down when it
 * shrinks. Nothing is drawn on the first paint, and the figure's own text never changes: the rolling characters are
 * drawn by its `::before`/`::after` from two attributes, then taken away, so what a reader, a screen reader or a copy
 * sees is always exactly the figure. Mounted once, in the workspace; off when the person asks for less motion.
 */
export function Odometer() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timers = new WeakMap<Element, number>();
    const roll = (el: HTMLElement, was: string, now: string) => {
      const a = Number(was);
      const b = Number(now);
      // A countdown only ever counts down, so its digits fall from above; a figure's digit rises when it grows (9 → 0
      // is a carry, so it rises too); anything that is not a digit just rises.
      const dir = el.closest('[data-roll="down"]') ? 'down' : Number.isNaN(a) || Number.isNaN(b) || b > a || (a === 9 && b === 0) ? 'up' : 'down';
      el.removeAttribute('data-rolling');
      el.setAttribute('data-was', was);
      el.setAttribute('data-now', now);
      // A reflow between taking the attribute off and putting it back restarts the animation for a quick second change.
      void el.offsetWidth;
      el.setAttribute('data-rolling', dir);
      const t = timers.get(el);
      if (t) window.clearTimeout(t);
      timers.set(
        el,
        window.setTimeout(() => {
          el.removeAttribute('data-rolling');
          el.removeAttribute('data-was');
          el.removeAttribute('data-now');
        }, ROLL_MS),
      );
    };
    const seen = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type !== 'characterData') continue;
        const el = r.target.parentElement;
        const was = r.oldValue ?? '';
        const now = r.target.nodeValue ?? '';
        if (!el || was === now || was.length !== 1 || now.length !== 1) continue;
        if (!el.closest('[data-amount], [data-roll]')) continue;
        roll(el, was, now);
      }
    });
    seen.observe(document.body, { subtree: true, characterData: true, characterDataOldValue: true });
    return () => seen.disconnect();
  }, []);
  return null;
}

/**
 * A display's text, one character per span, so each can roll on its own when it changes (`Odometer`). Its text is the
 * text it was given. `down` for a countdown: its digits fall from above.
 */
export function Digits({ text, down = false, className }: { text: string; down?: boolean; className?: string | undefined }) {
  return (
    <span className={className} data-roll={down ? 'down' : 'up'}>
      {[...text].map((c, i) => (
        // Places are counted from the right, so a figure that loses a digit keeps its seconds where they were.
        <span key={text.length - i} data-ch="">
          {c}
        </span>
      ))}
    </span>
  );
}
