import type { SVGProps } from 'react';

/**
 * The desk's icons: drawn, 16px grid, 1.5 stroke in `currentColor`. They are SVG rather than text for the same
 * reason every other mark in this product is: a glyph outside Geist falls back to whatever font the machine has
 * (VISUAL_BASELINES §4). Decorative unless given a label — the control around them always carries the words.
 */
const PATHS = {
  desk: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h6.5M11 11.5l1.25 1.25L14.5 10.5',
  orders: 'M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3',
  exceptions: 'M8 2.2 14.3 13.3H1.7zM8 6.4v3.2M8 11.4v.3',
  rates: 'M2 12.5 6 8.5l2.6 2.6L14 5.6M10.5 5.5H14V9',
  inr: 'M4.5 3h7M4.5 6h7M4.5 3c3.3 0 4.3 1.3 4.3 3S7.8 9 4.5 9l5.5 4.5',
  usdt: 'M2.5 3.5h11L8 13.5zM5.2 3.5 8 8.7l2.8-5.2M4.2 6.6h7.6',
  traders: 'M6 7.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM1.8 13.2c.4-2.3 2.1-3.7 4.2-3.7s3.8 1.4 4.2 3.7M10.6 3a2.2 2.2 0 0 1 0 4.2M11.8 9.7c1.3.5 2.2 1.7 2.4 3.5',
  clients: 'M2.5 13.5V5.5l5.5-3 5.5 3v8M5.5 13.5v-4h5v4M1.5 13.5h13',
  pnl: 'M2.5 13.5h11M4.5 11V7.5M8 11V4.5M11.5 11V9',
  system: 'M1.5 8.5h3l1.8-4 3.4 8 1.8-4h3',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14',
  close: 'M4 4l8 8M12 4l-8 8',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  arrowRight: 'M2.5 8h11M9.5 4l4 4-4 4',
  arrowUpRight: 'M5 11 11 5M6 5h5v5',
  external: 'M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4H6.5',
  check: 'M3 8.5 6.5 12 13 4.5',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.8V8l2.2 1.4',
  link: 'M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8',
  refresh: 'M13.2 5.5A5.5 5.5 0 0 0 3 6.2M2.8 10.5A5.5 5.5 0 0 0 13 9.8M13.5 2.5v3h-3M2.5 13.5v-3h3',
  keyboard: 'M1.5 4.5h13v7h-13zM4 7h.3M6.5 7h.3M9 7h.3M11.5 7h.3M5 9.3h6',
  signOut: 'M6.5 2.5h-4v11h4M10.5 5l3 3-3 3M13.5 8H6',
  plus: 'M8 3v10M3 8h10',
  filter: 'M2 3.5h12L9.5 8.8v3.7l-3 1.5V8.8z',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5.2a2.5 2.5 0 0 1 5 0v2.3',
  shield: 'M8 1.8 13 3.7v4.1c0 3-2.1 5.3-5 6.4-2.9-1.1-5-3.4-5-6.4V3.7z',
  user: 'M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.5-2.6 2.5-4 5-4s4.5 1.4 5 4',
  bank: 'M2 6h12L8 2.5zM3.5 6v5.5M6.5 6v5.5M9.5 6v5.5M12.5 6v5.5M2 13.5h12',
  wallet: 'M2.5 4.5h10v9h-10zM2.5 4.5l7.5-2v2M10.5 9h1.2',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  dot: 'M8 9.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z',
  more: 'M3.5 8h.2M8 8h.2M12.5 8h.2',
  inbox: 'M2 9.5 3.8 3h8.4L14 9.5v4H2zM2 9.5h3.5l1 1.5h3l1-1.5H14',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
  flag: 'M3.5 14V2.5M3.5 3h8.5l-1.8 3 1.8 3H3.5',
  pause: 'M5.5 3v10M10.5 3v10',
  play: 'M5 3v10l8-5z',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.8h2.8M8 5v3.2l2 1.3',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, label, ...rest }: { name: IconName; size?: number; label?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * ⌘ drawn, because U+2318 is not in Geist Mono. Used in the palette hint and the shortcut sheet; the words
 * "Command" or "Control" are carried next to it for anyone who cannot see it.
 */
export function CommandGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
    </svg>
  );
}
