/**
 * The operator validation list, named once.
 *
 * This is a **static** manifest on purpose. The reporter has to know the whole expected set before any test has
 * run, so that after an intentional update it can drop what is no longer expected without touching what is —
 * and a set collected from tests as they run is empty at that moment. (It was: the reporter read runtime
 * annotations in `onBegin`, found none, and deleted all eleven freshly recorded baselines as stale.)
 *
 * Every name here must be captured by `pages.spec.ts`, and every capture there must be named here. Both
 * directions are asserted by `apps/web/test/visual-manifest.unit.test.ts`, so the manifest cannot quietly
 * disagree with the suite.
 */
export const CAPTURES = [
  'operator-desk',
  'operator-trade-panel',
  'operator-payout-direct-route',
  'operator-exception',
  'operator-orders',
  'operator-rates',
  'operator-inr',
  'operator-usdt',
  'operator-clients',
  'operator-command-bar',
  'operator-step-up',
] as const;

export type CaptureName = (typeof CAPTURES)[number];

/** The baseline files those captures produce, which is what the reporter and the compare guard work in. */
export const CAPTURE_FILES: readonly string[] = CAPTURES.map((name) => `${name}.png`);

export const isCaptureName = (name: string): name is CaptureName => (CAPTURES as readonly string[]).includes(name);
