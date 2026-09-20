/**
 * The validation list, named once — the operator product's pages, the client product's pages, and the public
 * quote link.
 *
 * This is a **static** manifest on purpose. The reporter has to know the whole expected set before any test has
 * run, so that after an intentional update it can drop what is no longer expected without touching what is —
 * and a set collected from tests as they run is empty at that moment. (It was: the reporter read runtime
 * annotations in `onBegin`, found none, and deleted all eleven freshly recorded baselines as stale.)
 *
 * Every name here must be captured by one of the suite's spec files, and every capture there must be named
 * here. Both directions are asserted by `apps/web/test/visual-manifest.unit.test.ts`, so the manifest cannot
 * quietly disagree with the suite.
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
  // Phase 8 finance outputs: the P&L screen, and the statement reconciliation panel on the INR screen.
  'operator-pnl',
  'operator-statement',
  'operator-command-bar',
  'operator-step-up',
  // The client product (Phase 7). Same rules, same environment; different surface and, for the link, a phone.
  'client-exchange-quote',
  'client-trade-awaiting-usdt',
  'client-trade-settling',
  'client-trade-completed',
  'client-history',
  'client-accounts',
  'client-notifications',
  'link-quote-mobile',
  'link-verification-mobile',
  // Phase 9: the public site, on the same phone the link is read on.
  'public-home-mobile',
  'public-usdt-to-inr-mobile',
] as const;

export type CaptureName = (typeof CAPTURES)[number];

/** The baseline files those captures produce, which is what the reporter and the compare guard work in. */
export const CAPTURE_FILES: readonly string[] = CAPTURES.map((name) => `${name}.png`);

export const isCaptureName = (name: string): name is CaptureName => (CAPTURES as readonly string[]).includes(name);
