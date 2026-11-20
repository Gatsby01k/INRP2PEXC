'use client';

import { useEffect, useRef, useState } from 'react';
import type { Direction } from '@inrp2p/kernel';
import type { FlowCopy } from '../../../../content/site.ts';
import { storyDirection } from '../direction.ts';
import { robotCues } from '../robot/cues.ts';
import styles from './deal.module.css';

/**
 * The deal section's island: the switch between selling and buying, and the moment being read.
 *
 * It renders only the switch. The moment is written once, as `data-step` on the section, whenever the step crossing
 * the reading line changes — an IntersectionObserver per step, no scroll handler — so the picture's coins, rings and
 * visor follow in CSS and a React render never happens while the page moves. Without script the section shows the
 * finished deal; under reduced motion it still follows the reading, without the travel.
 */
export function DealSteps({ copy }: { copy: FlowCopy['direction'] }) {
  const root = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<Direction>(storyDirection.get);

  // The story's direction is shared (direction.ts); this switch shows whichever was chosen.
  useEffect(() => storyDirection.subscribe(setDirection), []);

  // A direction chosen in the hero's converter is the visitor's own, and the story follows it.
  useEffect(() => robotCues.subscribe((cue) => (cue.kind === 'direction' ? storyDirection.set(cue.direction) : undefined)), []);

  useEffect(() => {
    const section = root.current?.closest<HTMLElement>('[data-deal]');
    if (!section) return;
    const steps = [...section.querySelectorAll<HTMLElement>('[data-deal-step]')];
    if (steps.length === 0) return;
    section.setAttribute('data-live', '');
    const seen = new Set<number>();
    const set = () => {
      // The furthest step that has reached the reading line; before the first, the first.
      const at = seen.size ? Math.max(...seen) : 0;
      section.dataset.step = String(at);
      steps.forEach((el, i) => el.toggleAttribute('data-current', i === at));
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.dealStep);
          // A step counts once its top has passed the line; scrolling back up below it un-counts it.
          if (e.isIntersecting || e.boundingClientRect.top < (e.rootBounds?.top ?? 0)) seen.add(i);
          else seen.delete(i);
        }
        set();
      },
      { rootMargin: '-55% 0px -45% 0px' },
    );
    for (const el of steps) io.observe(el);
    set();
    return () => io.disconnect();
  }, []);

  return (
    <div ref={root} className={styles.switch} role="group" aria-label={copy.label}>
      {(['SELL_USDT', 'BUY_USDT'] as const).map((d) => (
        <button key={d} type="button" className={styles.switchOption} aria-pressed={direction === d} onClick={() => storyDirection.set(d)}>
          {copy.options[d]}
        </button>
      ))}
    </div>
  );
}
