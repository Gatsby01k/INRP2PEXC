'use client';

import { useEffect, useRef } from 'react';

/**
 * Which control the visitor is reading, written to the trust section as `data-active` for the record to light.
 *
 * The control that crosses the middle of the viewport is the one being read. It stays active until another one
 * crosses, so the record never goes dark between two controls; scrolling back above the first one clears it.
 * Renders nothing: it only watches the server's markup.
 */
export function TrustStage() {
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const section = anchor.current?.closest<HTMLElement>('[data-trust]');
    if (!section) return;
    const controls = [...section.querySelectorAll<HTMLElement>('[data-trust-control]')];
    const first = controls[0];
    if (!first) return;

    const reading = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.trustControl;
          if (!key) continue;
          if (entry.isIntersecting) section.dataset.active = key;
          // Leaving the band downwards from the first control means the visitor has scrolled back above them all.
          else if (entry.target === first && entry.boundingClientRect.top > (entry.rootBounds?.bottom ?? window.innerHeight / 2)) {
            delete section.dataset.active;
          }
        }
      },
      { rootMargin: '-48% 0px -48% 0px' },
    );
    for (const control of controls) reading.observe(control);
    return () => reading.disconnect();
  }, []);

  return <span ref={anchor} hidden />;
}
