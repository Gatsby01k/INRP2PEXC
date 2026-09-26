'use client';

import { useEffect, useRef, useState } from 'react';
import type { Direction } from '@inrp2p/kernel';
import { FLOW_STATIONS, type FlowCopy, type FlowStation } from '../../../../content/site.ts';
import { storyDirection } from '../direction.ts';
import { ArrowIcon } from '../icons.tsx';
import { robotCues } from '../robot/cues.ts';
import styles from './flow.module.css';

/**
 * The execution flow's island: the direction switch, and the scroll that runs a trade along the rail.
 *
 * It renders only the switch. Everything else it touches is the server's markup, driven from outside React:
 * scroll position becomes a distance along the rail, the distance becomes the station the trade has reached, and
 * the station is written once, as attributes, when it changes — so a scroll frame costs two transforms and a
 * React render never happens while the page moves.
 *
 * Three modes, chosen from the screen and the visitor's settings and mirrored in `data-mode` for the styles:
 * - `pinned` — wide and tall enough to hold the whole scene: the section holds still while the page scrolls
 *   through it, and the trade runs from end to end.
 * - `free` — the rail moves with the page (narrow screens run it top to bottom), and the trade advances as the
 *   rail passes a reading line in the viewport.
 * - `still` — reduced motion: the trade is shown completed, and nothing follows the scroll.
 */

type Mode = 'pinned' | 'free' | 'still';

/** The rail runs across the page from this width; below it, down the page. Mirrors flow.module.css. */
const WIDE = '(min-width: 1100px)';
/** Tall enough to pin the whole scene — heading, ticket, rail and every station — in one viewport. */
const TALL = '(min-height: 800px)';
const STILL = '(prefers-reduced-motion: reduce)';
/** While pinned, the first and last stretches of the scroll hold the trade at its two ends. */
const LEAD_IN = 0.06;
const LEAD_OUT = 0.14;
/** Down the page, a station is reached when its node crosses this line (a fraction of the viewport's height). */
const READING_LINE = 0.62;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const stationIndex = (key: string | undefined): number => FLOW_STATIONS.indexOf(key as FlowStation);

export function FlowStage({ copy, ends }: { copy: FlowCopy['direction']; ends: { from: Record<Direction, string>; to: Record<Direction, string> } }) {
  const root = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<Direction>(storyDirection.get);

  // The story's direction is shared with the controls' switch (direction.ts); this one shows whichever was chosen.
  useEffect(() => storyDirection.subscribe(setDirection), []);

  // A direction chosen in the quote module is the visitor's own, and the story follows it.
  useEffect(() => robotCues.subscribe((cue) => (cue.kind === 'direction' ? storyDirection.set(cue.direction) : undefined)), []);

  useEffect(() => {
    const section = root.current?.closest<HTMLElement>('[data-flow]');
    const diagram = section?.querySelector<HTMLElement>('[data-flow-diagram]');
    if (!section || !diagram) return;
    const all = (selector: string) => [...diagram.querySelectorAll<HTMLElement>(selector)];
    // The drawn mark inside each node — a node's box is as wide as its column.
    const nodes = all('[data-flow-node]').map((n) => (n.firstElementChild as HTMLElement | null) ?? n);
    const stations = all('[data-flow-station]');
    const reached = all('[data-at]');
    const now = all('[data-when]');
    const fill = diagram.querySelector<HTMLElement>('[data-flow-fill]');
    const signal = diagram.querySelector<HTMLElement>('[data-flow-signal]');
    const ticket = diagram.querySelector<HTMLElement>('[data-flow-ticket]');
    const leader = diagram.querySelector<HTMLElement>('[data-flow-leader]');
    if (nodes.length !== FLOW_STATIONS.length) return;

    const wide = matchMedia(WIDE);
    const tall = matchMedia(TALL);
    const still = matchMedia(STILL);

    let mode: Mode = 'free';
    let across = true;
    /** Each node's centre, measured along the rail from the first. */
    let centres: number[] = [];
    let ticketAt: number[] = [];
    let leaderAt: number[] = [];
    let station = -1;
    let travelled = -1;
    let frame = 0;
    let visible = false;

    const reach = (next: number) => {
      if (next === station) return;
      station = next;
      stations.forEach((el, i) => el.setAttribute('data-state', i < next ? 'passed' : i === next ? 'current' : 'upcoming'));
      for (const el of reached) el.toggleAttribute('data-reached', stationIndex(el.dataset.at) <= next);
      for (const el of now) el.toggleAttribute('data-now', stationIndex(el.dataset.when) === next);
      section.toggleAttribute('data-complete', next === FLOW_STATIONS.length - 1);
      if (across) {
        if (ticket) ticket.style.transform = `translateX(${ticketAt[next]}px)`;
        if (leader) leader.style.transform = `translateX(${leaderAt[next]}px)`;
      }
    };

    const distance = (): number => {
      const length = centres.at(-1) ?? 0;
      if (mode === 'still') return length;
      const vh = window.innerHeight;
      if (mode === 'pinned') {
        const box = section.getBoundingClientRect();
        const p = clamp01(-box.top / Math.max(1, box.height - vh));
        return clamp01((p - LEAD_IN) / (1 - LEAD_IN - LEAD_OUT)) * length;
      }
      const first = nodes[0]!.getBoundingClientRect();
      // Across an unpinned page: the trade runs while the rail rises from low in the viewport to its upper part.
      if (across) return clamp01((vh * 0.82 - first.top) / (vh * 0.45)) * length;
      return Math.min(Math.max(vh * READING_LINE - (first.top + first.height / 2), 0), length);
    };

    const update = () => {
      frame = 0;
      const d = distance();
      if (d === travelled) return;
      travelled = d;
      const length = centres.at(-1) || 1;
      if (fill) fill.style.transform = across ? `scaleX(${d / length})` : `scaleY(${d / length})`;
      if (signal) signal.style.transform = across ? `translateX(${d}px)` : `translateY(${d}px)`;
      let next = 0;
      centres.forEach((c, i) => {
        if (d >= c - 0.5) next = i;
      });
      reach(next);
    };

    const schedule = () => {
      if (!frame && visible) frame = requestAnimationFrame(update);
    };

    const measure = () => {
      across = wide.matches;
      mode = still.matches ? 'still' : across && tall.matches ? 'pinned' : 'free';
      // The mode changes the layout, so it is written before anything is measured.
      section.dataset.mode = mode;
      const box = diagram.getBoundingClientRect();
      const mids = nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return across ? r.left + r.width / 2 - box.left : r.top + r.height / 2 - box.top;
      });
      const first = nodes[0]!.getBoundingClientRect();
      const start = mids[0]!;
      centres = mids.map((m) => m - start);
      diagram.style.setProperty('--rail-start', `${start}px`);
      diagram.style.setProperty('--rail-across', `${across ? first.top + first.height / 2 - box.top : first.left + first.width / 2 - box.left}px`);
      diagram.style.setProperty('--rail-length', `${centres.at(-1) ?? 0}px`);
      if (across && ticket) {
        // The ticket stays inside the diagram; the leader always drops to the node itself.
        const w = ticket.offsetWidth;
        ticketAt = mids.map((m) => Math.min(Math.max(m - w / 2, 0), box.width - w));
        leaderAt = mids;
      }
      station = -1;
      travelled = -1;
      update();
    };

    const onScroll = () => schedule();
    const onMedia = () => measure();
    const seen = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      schedule();
    });
    const resized = new ResizeObserver(() => measure());

    measure();
    seen.observe(section);
    resized.observe(diagram);
    window.addEventListener('scroll', onScroll, { passive: true });
    for (const mq of [wide, tall, still]) mq.addEventListener('change', onMedia);
    return () => {
      cancelAnimationFrame(frame);
      seen.disconnect();
      resized.disconnect();
      window.removeEventListener('scroll', onScroll);
      for (const mq of [wide, tall, still]) mq.removeEventListener('change', onMedia);
    };
  }, []);

  return (
    <div ref={root} className={styles.switch} role="group" aria-label={copy.label}>
      {(['BUY_USDT', 'SELL_USDT'] as const).map((d) => (
        <button key={d} type="button" className={styles.switchOption} aria-pressed={direction === d} onClick={() => storyDirection.set(d)}>
          <span className="ix-visually-hidden">{copy.options[d]}</span>
          <span className={styles.switchEnds} aria-hidden="true">
            {ends.from[d]}
            <ArrowIcon className={styles.switchArrow} />
            {ends.to[d]}
          </span>
        </button>
      ))}
    </div>
  );
}
