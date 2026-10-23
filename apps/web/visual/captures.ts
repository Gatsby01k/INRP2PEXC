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
  'operator-exceptions',
  'operator-orders',
  'operator-trade-record',
  'operator-rates',
  'operator-inr',
  'operator-usdt',
  'operator-clients',
  // Phase 8 finance outputs: the P&L screen, and the statement reconciliation panel on the INR screen.
  'operator-pnl',
  'operator-statement',
  'operator-command-bar',
  'operator-step-up',
  'operator-system',
  // The desk's Traders pages (TD-23): the list, and one trader with its order and reserve.
  'operator-trader-desk',
  'operator-trader',
  // Desks for INRP2P (ADR 0020 §2.17): every desk, and one desk with INRP2P's decisions; and the platform's revenue (§2.16).
  'operator-desks',
  'operator-desk-detail',
  'operator-revenue',
  // The client product (Phase 7). Same rules, same environment; different surface and, for the link, a phone.
  'client-exchange-quote',
  'client-trade-awaiting-usdt',
  'client-trade-awaiting-inr',
  // P2P (ADR 0019): a client buying from a trader, the seller's USDT in escrow, paying the seller's own account.
  'client-trade-p2p-pay',
  'client-trade-settling',
  'client-trade-completed',
  'client-history',
  'client-destinations',
  'client-notifications',
  // Traders, from the trader's own session (TD-23) — and the application, from a client of the exchange.
  'client-traders',
  'client-trader-orders',
  'client-trader-order',
  'client-trader-order-escrow',
  'client-trader-reserve',
  'client-trader-settlement',
  'client-trader-apply',
  // A trader's own desk (ADR 0020): Today on a desktop and a phone, its deals, one deal, prices, clients, team and page.
  'client-desk-today',
  'client-desk-today-mobile',
  'client-desk-deals',
  'client-desk-deal',
  'client-desk-prices',
  'client-desk-clients',
  'client-desk-team',
  'client-desk-page',
  // A client of the exchange dealing with that desk: its list of desks, and the desk's ticket in its workspace.
  'client-desks',
  'client-desk-ticket',
  'link-quote-mobile',
  'link-verification-mobile',
  // A desk's deal link (ADR 0020), as the person holding it sees it.
  'link-deal-mobile',
  // Phase 9: the public site, on the same phone the link is read on.
  'public-home-mobile',
  'public-usdt-to-inr-mobile',
  // A desk's own page (ADR 0020).
  'public-desk-mobile',
] as const;

export type CaptureName = (typeof CAPTURES)[number];

/** The baseline files those captures produce, which is what the reporter and the compare guard work in. */
export const CAPTURE_FILES: readonly string[] = CAPTURES.map((name) => `${name}.png`);

export const isCaptureName = (name: string): name is CaptureName => (CAPTURES as readonly string[]).includes(name);
