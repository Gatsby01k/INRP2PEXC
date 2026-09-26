'use client';

import { useEffect, useRef, useState } from 'react';
import type { Direction } from '@inrp2p/kernel';
import type { TrustCopy } from '../../../../content/site.ts';
import { storyDirection } from '../direction.ts';
import styles from './trust.module.css';

/**
 * The controls' island: which control is open, and which example the record shows.
 *
 * It renders only the record's switch between a Buy USDT and a Sell USDT example — the same choice as the
 * execution flow's switch (direction.ts), so moving one moves the other. The controls themselves are the server's
 * markup: pressing a control's heading opens it, closes the one that was open, and writes it to the section as
 * `data-active`, which is what lights its lines in the record. One is always open, so the open one's heading is
 * marked as not collapsible, as an accordion that cannot be emptied should be. Up, Down, Home and End move
 * between the headings.
 */
export function TrustStage({ copy }: { copy: TrustCopy['direction'] }) {
  const root = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<Direction>(storyDirection.get);

  useEffect(() => storyDirection.subscribe(setDirection), []);

  useEffect(() => {
    const section = root.current?.closest<HTMLElement>('[data-trust]');
    if (!section) return;
    const toggles = [...section.querySelectorAll<HTMLButtonElement>('[data-trust-toggle]')];
    if (toggles.length === 0) return;

    const open = (key: string) => {
      if (section.dataset.active === key) return;
      section.dataset.active = key;
      for (const toggle of toggles) {
        const on = toggle.dataset.trustToggle === key;
        toggle.setAttribute('aria-expanded', String(on));
        if (on) toggle.setAttribute('aria-disabled', 'true');
        else toggle.removeAttribute('aria-disabled');
        toggle.closest('[data-trust-control]')?.toggleAttribute('data-open', on);
      }
    };

    const toggleOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLButtonElement>('[data-trust-toggle]') : null;

    const onClick = (e: MouseEvent) => {
      const key = toggleOf(e.target)?.dataset.trustToggle;
      if (key) open(key);
    };

    const onKey = (e: KeyboardEvent) => {
      const toggle = toggleOf(e.target);
      if (!toggle) return;
      const i = toggles.indexOf(toggle);
      const n = toggles.length;
      const next =
        e.key === 'ArrowDown' ? toggles[(i + 1) % n]
        : e.key === 'ArrowUp' ? toggles[(i - 1 + n) % n]
        : e.key === 'Home' ? toggles[0]
        : e.key === 'End' ? toggles[n - 1]
        : undefined;
      if (!next) return;
      e.preventDefault();
      next.focus();
    };

    section.addEventListener('click', onClick);
    section.addEventListener('keydown', onKey);
    // The headings are live from here on: until now, pressing them did nothing, and they did not look pressable.
    section.setAttribute('data-live', '');
    return () => {
      section.removeEventListener('click', onClick);
      section.removeEventListener('keydown', onKey);
      section.removeAttribute('data-live');
    };
  }, []);

  return (
    <div ref={root} className={styles.switch} role="group" aria-label={copy.label}>
      {(['BUY_USDT', 'SELL_USDT'] as const).map((d) => (
        <button key={d} type="button" className={styles.switchOption} aria-pressed={direction === d} onClick={() => storyDirection.set(d)}>
          {copy.options[d]}
        </button>
      ))}
    </div>
  );
}
