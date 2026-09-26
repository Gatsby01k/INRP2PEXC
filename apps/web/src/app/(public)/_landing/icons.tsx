import type { HeroPointIcon } from '../../../content/site.ts';

/**
 * The hero's glyphs, drawn rather than typed: the bundled Geist faces are the only font any glyph may come from
 * (VISUAL_BASELINES §4), and a rupee or an arrow from a system fallback would render differently on every
 * machine. One stroke weight, round joins, a 24-unit grid — the same drawing hand as the rest of the kit.
 */
const PATHS: Record<HeroPointIcon, string> = {
  rupee: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M8.5 7.5h7 M8.5 10.5h7 M10 7.5c2.6 0 3.9 1.1 3.9 2.9 0 1.9-1.4 3-3.9 3H9l4.8 3.6',
  lock: 'M6.5 10.5h11a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1Z M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5 M12 14.2v2.2',
  dealer: 'M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M5 20c.6-3.6 3.4-5.8 7-5.8s6.4 2.2 7 5.8 M17.8 6.2l1.7-1.7 M19.6 9h1.9',
  destination: 'M12 3.5 5 6.3v5.3c0 4.2 2.9 7.6 7 8.9 4.1-1.3 7-4.7 7-8.9V6.3L12 3.5Z M9 12.2l2.1 2.1 4-4.1',
};

export function PointIcon({ name, className }: { name: HeroPointIcon; className?: string | undefined }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 8h9.5 M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The execution flow's station marks, in the same hand: a price tag, the lock, the two sides changing hands. */
const STATION_PATHS = {
  quote: 'M4 12.3V5.5A1.5 1.5 0 0 1 5.5 4h6.8l7.4 7.4a1.5 1.5 0 0 1 0 2.1l-6.2 6.2a1.5 1.5 0 0 1-2.1 0Z M8.6 7.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z',
  execution: PATHS.lock,
  settlement: 'M4.5 8.5h14.5 M15.5 5l3.5 3.5-3.5 3.5 M19.5 15.5H5 M8.5 12 5 15.5 8.5 19',
} as const;

export type StationMark = keyof typeof STATION_PATHS;

export function StationIcon({ name, className }: { name: StationMark; className?: string | undefined }) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={STATION_PATHS[name]} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The rupee sign alone — the hero's rupee without its ring — for a face that is already round. */
export function RupeeMark({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="7 6 10 12.5" fill="none" aria-hidden="true" focusable="false">
      <path d="M8.5 7.5h7 M8.5 10.5h7 M10 7.5c2.6 0 3.9 1.1 3.9 2.9 0 1.9-1.4 3-3.9 3H9l4.8 3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.6 6.3l2.2 2.2 4.6-4.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
