/** The page's glyphs, in the kit's hand: one stroke weight, round joins, a 24-unit grid. Decoration: always aria-hidden. */

const PATHS = {
  escrow: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z M12 8.5v1 M12 14.5v1 M8.5 12h1 M14.5 12h1',
  bank: 'M3.5 9.5 12 4.5l8.5 5 M5 10v7.5 M9.7 10v7.5 M14.3 10v7.5 M19 10v7.5 M3.5 19.5h17',
  refused: 'M12 3.5 5 6.5v5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9v-5Z M9.5 9.5l5 5 M14.5 9.5l-5 5',
  ceo: 'M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z M5 19.5c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6',
  clients: 'M9 5.3a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z M3 19.5c.7-3.2 3-5 6-5s5.3 1.8 6 5 M15.5 5.6a3.2 3.2 0 0 1 0 5.8 M17.5 14.8c1.8.6 3 2.2 3.5 4.7',
  flow: 'M4 7h12 M13 4l3 3-3 3 M20 17H8 M11 14l-3 3 3 3',
  arrow: 'M5 12h13 M13 7l5 5-5 5',
  check: 'M6 12.5l4 4 8-9',
  cross: 'M7 7l10 10 M17 7 7 17',
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 22, stroke = 1.6, className }: { name: GlyphName; size?: number; stroke?: number; className?: string | undefined }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Telegram's paper plane, as Telegram draws it. */
export function TelegramGlyph({ size = 20, className }: { size?: number; className?: string | undefined }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="12" fill="currentColor" />
      <path d="M5.4 11.7 16.9 7.3c.5-.2 1 .1.9.9l-2 9.3c-.1.7-.5.8-1.1.5l-3-2.2-1.4 1.4c-.2.2-.3.3-.6.3l.2-3.1 5.6-5.1c.2-.2 0-.3-.4-.1l-6.9 4.4-3-.9c-.6-.2-.7-.7.2-1Z" fill="#fff" />
    </svg>
  );
}

/** The dotted orbits of the mark's field — texture, never the mark itself. */
export function Orbits({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 1200 1200" fill="none" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeLinecap="round" strokeWidth="2">
        <circle cx="600" cy="600" r="300" strokeDasharray="2 13" />
        <circle cx="600" cy="600" r="420" strokeDasharray="2 17" opacity="0.7" />
        <circle cx="600" cy="600" r="540" strokeDasharray="2 22" opacity="0.45" />
      </g>
      <circle cx="388" cy="812" r="7" fill="currentColor" />
      <circle cx="897" cy="303" r="6" fill="currentColor" opacity="0.8" />
    </svg>
  );
}
