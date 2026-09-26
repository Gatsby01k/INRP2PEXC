'use client';

import { useEffect, useRef } from 'react';

/**
 * Logs the desk's timeline as it is read: each entry is marked `data-logged` once it has come up past the lower
 * part of the screen, and the spine behind it fills in. An entry is logged once and stays logged.
 *
 * Until this runs — without script, or when the visitor asked for less motion, when it never does — the timeline
 * is drawn complete, the way a finished trade's timeline reads. `data-live` on the section is what switches the
 * not-yet-logged look on, so nothing is ever drawn pending that no script will complete. Renders nothing.
 */
const STILL = '(prefers-reduced-motion: reduce)';
/** Entries that come into view in the same moment are logged one after another, never more than a few deep. */
const STAGGER_MS = 110;
const STAGGER_MAX = 3;

export function DeskStage() {
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const section = anchor.current?.closest<HTMLElement>('[data-desk]');
    if (!section || matchMedia(STILL).matches) return;
    const entries = [...section.querySelectorAll<HTMLElement>('[data-desk-entry]')];
    if (entries.length === 0) return;

    const log = new IntersectionObserver(
      (records) => {
        let n = 0;
        for (const record of records) {
          // Passed already, above the screen (the page was opened further down, or scrolled past quickly).
          const passed = record.boundingClientRect.bottom <= (record.rootBounds?.top ?? 0);
          if (!record.isIntersecting && !passed) continue;
          const el = record.target as HTMLElement;
          // What is already above the screen is logged at once: nobody is watching it happen.
          el.style.setProperty('--log-delay', passed ? '0ms' : `${Math.min(n++, STAGGER_MAX) * STAGGER_MS}ms`);
          el.setAttribute('data-logged', '');
          log.unobserve(el);
        }
      },
      { rootMargin: '0px 0px -22% 0px' },
    );
    section.setAttribute('data-live', '');
    for (const entry of entries) log.observe(entry);
    return () => {
      log.disconnect();
      section.removeAttribute('data-live');
    };
  }, []);

  return <span ref={anchor} hidden />;
}
