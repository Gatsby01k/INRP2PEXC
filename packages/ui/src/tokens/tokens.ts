/**
 * INRP2P design tokens — single source of truth (UX_FLOWS §1, DECISIONS D-10).
 * `styles/tokens.css` is generated from this file (`pnpm --filter @inrp2p/ui tokens:generate`)
 * and a unit test fails if the committed CSS drifts. Components reference only CSS variables.
 */

export const COLOR = {
  /** Logo orange: brand signal, arcs, active rails, focus rings, selection, large display elements. */
  'brand-primary': '#F04E23',
  /** Text-bearing orange: primary button fills (white label), orange text. 5.00:1 with white. */
  'brand-action': '#C8401A',
  'brand-action-hover': '#B83A16',
  'brand-soft': '#FDEDE7',
  'bg-app': '#F7F5F0',
  'bg-surface': '#FFFFFF',
  'bg-subtle': '#FBFAF7',
  'text-primary': '#121317',
  'text-secondary': '#656A73',
  'text-muted': '#6B6F77',
  /** Disabled / decorative only — exempt from AA text contrast. */
  'text-disabled': '#91959D',
  'text-on-action': '#FFFFFF',
  ivory: '#FFF8EE',
  'status-success': '#157A45',
  'status-success-soft': '#E8F4EC',
  'status-warning': '#8A5A00',
  'status-warning-soft': '#FBF3E2',
  'status-danger': '#B42318',
  'status-danger-soft': '#FCEBEA',
  'border-default': '#E8E4DC',
  'border-strong': '#D5D0C5',
  /** Non-text UI graphics (meter tracks, input outlines) — 3:1 against surfaces. */
  'border-control': '#82858C',
  'overlay-scrim': 'rgba(18, 19, 23, 0.40)',
} as const;

export const SPACE = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px', 16: '64px', 20: '80px' } as const;

export const FONT_SIZE = {
  'display-xl': '64px',
  display: '48px',
  title: '32px',
  'heading-lg': '24px',
  heading: '20px',
  'body-lg': '16px',
  body: '15px',
  'body-sm': '14px',
  table: '13px',
  meta: '12px',
  micro: '11px',
} as const;

export const LINE_HEIGHT = { tight: '1.1', snug: '1.25', normal: '1.45' } as const;
export const FONT_WEIGHT = { regular: '400', medium: '500', semibold: '600' } as const;
export const FONT_FAMILY = {
  sans: "'Geist', 'Helvetica Neue', Arial, sans-serif",
  mono: "'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
} as const;

export const RADIUS = { control: '8px', input: '10px', surface: '14px', pill: '999px' } as const;
export const SHADOW = { low: '0 1px 0 rgba(18, 19, 23, 0.04)', medium: '0 4px 16px rgba(18, 19, 23, 0.06)' } as const;
export const MOTION = { 'dur-fast': '150ms', 'dur-base': '220ms', 'dur-complete': '380ms', 'dur-loop': '1100ms', ease: 'cubic-bezier(0.2, 0, 0, 1)' } as const;

/** Density modes share every token except row geometry (brief "Density modes"). */
export const DENSITY = {
  comfortable: { 'row-h': '56px', 'cell-px': '16px', 'cell-font': 'var(--font-size-body)' },
  compact: { 'row-h': '36px', 'cell-px': '12px', 'cell-font': 'var(--font-size-table)' },
} as const;

export const LAYOUT = { 'client-exchange-max': '560px', 'client-list-max': '960px', 'operator-sidebar': '220px', 'operator-panel': '380px', 'touch-min': '44px' } as const;

export type ColorToken = keyof typeof COLOR;

/** Every foreground/background pair the components use for text or meaningful graphics. */
export interface ContrastRequirement {
  fg: ColorToken;
  bg: ColorToken;
  /** 4.5 normal text, 3 large text or UI graphics (WCAG 2.2 1.4.3 / 1.4.11). */
  min: 4.5 | 3;
  use: string;
}

export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  { fg: 'text-primary', bg: 'bg-surface', min: 4.5, use: 'body text' },
  { fg: 'text-primary', bg: 'bg-app', min: 4.5, use: 'body text on app background' },
  { fg: 'text-primary', bg: 'bg-subtle', min: 4.5, use: 'table zebra' },
  { fg: 'text-primary', bg: 'brand-soft', min: 4.5, use: 'selected row' },
  { fg: 'text-primary', bg: 'ivory', min: 4.5, use: 'receipt / quote link' },
  { fg: 'text-secondary', bg: 'bg-surface', min: 4.5, use: 'secondary text' },
  { fg: 'text-secondary', bg: 'bg-app', min: 4.5, use: 'secondary text on app' },
  { fg: 'text-secondary', bg: 'bg-subtle', min: 4.5, use: 'secondary in zebra rows' },
  { fg: 'text-muted', bg: 'bg-surface', min: 4.5, use: 'muted labels' },
  { fg: 'text-muted', bg: 'bg-app', min: 4.5, use: 'muted labels on app' },
  { fg: 'text-muted', bg: 'bg-subtle', min: 4.5, use: 'muted in zebra rows' },
  { fg: 'text-muted', bg: 'ivory', min: 4.5, use: 'muted on receipt' },
  { fg: 'text-secondary', bg: 'brand-soft', min: 4.5, use: 'secondary text on selection / quote lock (muted is not allowed on soft surfaces)' },
  { fg: 'text-secondary', bg: 'status-warning-soft', min: 4.5, use: 'secondary text on expiring lock' },
  { fg: 'text-secondary', bg: 'status-danger-soft', min: 4.5, use: 'secondary text on exception surface' },
  { fg: 'text-secondary', bg: 'status-success-soft', min: 4.5, use: 'secondary text on success surface' },
  { fg: 'text-on-action', bg: 'brand-action', min: 4.5, use: 'primary button label' },
  { fg: 'text-on-action', bg: 'brand-action-hover', min: 4.5, use: 'primary button hover' },
  { fg: 'text-on-action', bg: 'status-danger', min: 4.5, use: 'danger button label' },
  { fg: 'brand-action', bg: 'bg-surface', min: 4.5, use: 'orange text / links' },
  { fg: 'status-success', bg: 'bg-surface', min: 4.5, use: 'confirmed label' },
  { fg: 'status-success', bg: 'status-success-soft', min: 4.5, use: 'success banner' },
  { fg: 'status-warning', bg: 'bg-surface', min: 4.5, use: 'expiring label' },
  { fg: 'status-warning', bg: 'status-warning-soft', min: 4.5, use: 'warning banner' },
  { fg: 'status-danger', bg: 'bg-surface', min: 4.5, use: 'failed label' },
  { fg: 'status-danger', bg: 'status-danger-soft', min: 4.5, use: 'exception banner' },
  { fg: 'brand-primary', bg: 'bg-surface', min: 3, use: 'focus ring, active rail, countdown arc (graphic)' },
  { fg: 'brand-primary', bg: 'bg-app', min: 3, use: 'active rail on app background (graphic)' },
  { fg: 'status-danger', bg: 'bg-app', min: 3, use: 'exception rail (graphic)' },
  { fg: 'border-control', bg: 'bg-surface', min: 3, use: 'input outline, meter track (graphic)' },
  { fg: 'border-control', bg: 'bg-app', min: 3, use: 'input outline on app (graphic)' },
];

function block(prefix: string, record: Record<string, string>): string[] {
  return Object.entries(record).map(([k, v]) => `  --${prefix}${k}: ${v};`);
}

export function tokensToCss(): string {
  const root = [
    ...block('', COLOR),
    ...block('space-', SPACE as Record<string, string>),
    ...block('font-size-', FONT_SIZE),
    ...block('line-height-', LINE_HEIGHT),
    ...block('font-weight-', FONT_WEIGHT),
    ...block('font-', FONT_FAMILY),
    ...block('radius-', RADIUS),
    ...block('shadow-', SHADOW),
    ...block('', MOTION),
    ...block('', LAYOUT),
    ...block('', DENSITY.comfortable),
  ];
  return [
    '/* GENERATED from src/tokens/tokens.ts — do not edit by hand. */',
    ':root {',
    ...root,
    '}',
    '',
    "[data-density='compact'] {",
    ...block('', DENSITY.compact),
    '}',
    '',
    "[data-density='comfortable'] {",
    ...block('', DENSITY.comfortable),
    '}',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    '  :root {',
    '    --dur-fast: 0ms;',
    '    --dur-base: 0ms;',
    '    --dur-complete: 0ms;',
    '  }',
    '}',
    '',
  ].join('\n');
}
