/**
 * The public site's words, in one place.
 *
 * Everything the six public pages say is defined here rather than scattered through components, for three
 * reasons: the sitemap is generated from the same list that renders the pages, so a route cannot exist without
 * being listed or be listed without existing; the copy guard
 * (`apps/web/test/site-copy.unit.test.ts`) reads this file and fails on a regulatory claim or an invented
 * figure (D-07, PRODUCT §7.4); and a marketing sentence that needs changing is changed where it was written,
 * not in six components.
 *
 * The rule the copy is written under is narrow and absolute: **nothing here may be a number we made up, and
 * nothing here may be a claim about our regulatory standing.** No volumes, no rates, no settlement times, no
 * customer counts, no reviews, no "licensed", "registered", "regulated" or "compliant". Until counsel confirms
 * otherwise (D-07), the public site describes how the product works and nothing else. Describing a mechanism is
 * not a promise about speed: "each trade gets its own deposit address" is a fact about the software; "funds in
 * minutes" is a claim about the world, and the world includes banks.
 */

import type { Direction } from '@inrp2p/kernel';

export interface SiteSection {
  readonly heading: string;
  readonly body: readonly string[];
}

export interface SitePage {
  /** The path as served, and as written into the sitemap. */
  readonly path: string;
  /** `<title>`, which is also what a search result shows. */
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly lede: string;
  readonly sections: readonly SiteSection[];
  /** Relative importance for the sitemap; the home page leads. */
  readonly priority: number;
}

/** The product's own name, used in copy and in the structured data. Never abbreviated into a claim. */
export const SITE_NAME = 'INRP2P Exchange';

/** The one-line positioning from PRODUCT §7.4. Positioning, not measurement: no figure appears in it. */
export const TAGLINE = 'Large trades. Locked rates. INR settlement.';

/**
 * What the buttons do. There is no public request form in V1 — a trade needs a client the desk has onboarded,
 * with a bank account or wallet registered in advance — so every action leads to the client app's own screen,
 * and a person without an account is told plainly how to get one rather than shown a form that cannot work.
 */
export interface SiteAction {
  readonly label: string;
  readonly kind: 'primary' | 'secondary';
  /** A path on the client app's origin; the layout resolves the origin at request time. */
  readonly appPath: string;
}

export const ACTIONS: readonly SiteAction[] = [
  { label: 'Sell USDT', kind: 'primary', appPath: '/exchange?direction=sell' },
  { label: 'Buy USDT', kind: 'primary', appPath: '/exchange?direction=buy' },
  { label: 'Request OTC quote', kind: 'secondary', appPath: '/exchange' },
];

/** How a trade actually runs, in the order it happens. Mechanism only — no timing is claimed anywhere. */
export const STEPS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Ask for a price',
    body: 'Say which direction you want, how much, and where the money should end up. A dealer prices it for your trade rather than matching you against a book.',
  },
  {
    title: 'Accept while it is firm',
    body: 'A quote states its rate and the moment it expires. Accepting it before then locks that rate for the trade; after then it is gone and you can ask again.',
  },
  {
    title: 'Send your side',
    body: 'Selling USDT, you send TRC20 USDT to an address issued for that one trade. Buying USDT, you transfer INR to the settlement account named on the trade.',
  },
  {
    title: 'Receive the other side',
    body: 'INR arrives at a bank account you registered in advance, or USDT at your registered wallet. Every payment carries its own bank reference or transaction hash.',
  },
  {
    title: 'Keep the receipt',
    body: 'A completed trade produces a settlement receipt listing what was agreed and every payment that settled it, downloadable as a document, CSV or JSON.',
  },
];

/**
 * The home page's hero, word for word.
 *
 * Its quote module shows how a request becomes a quote and never shows a rate: a rate exists only inside a quote
 * issued to a client for a specific trade (FOOTER_NOTE), so the side of the trade the desk prices is described,
 * not estimated. The amount a visitor types is theirs; nothing the page prints is a figure of ours.
 */
export interface HeroCopy {
  readonly eyebrow: string;
  /** Rendered on two lines with the asset in brand orange; read as one sentence. */
  readonly headline: { readonly lead: string; readonly accent: string; readonly tail: string };
  readonly lede: string;
  readonly points: readonly { readonly icon: HeroPointIcon; readonly label: string }[];
  readonly quote: QuoteModuleCopy;
  readonly voice: HeroVoiceCopy;
}

export type HeroPointIcon = 'rupee' | 'lock' | 'dealer' | 'destination';

/** The robot's spoken confirmations, one per meaningful action. */
export type VoiceLine = 'ready' | 'direction' | 'amount' | 'request' | 'received';

/**
 * The robot's voice: a handful of short confirmations spoken after something the visitor did, never on its own.
 * `lines` are spoken, not shown; `control` names the button that mutes them, `on` and `off` describe its state.
 */
export interface HeroVoiceCopy {
  readonly control: string;
  readonly on: string;
  readonly off: string;
  readonly lines: Record<VoiceLine, string>;
}

/** Words that change with the direction are keyed by it, so the module can never pair a label with the wrong side. */
export interface QuoteModuleCopy {
  readonly title: string;
  readonly amount: Record<Direction, string>;
  readonly counter: Record<Direction, string>;
  readonly counterValue: string;
  readonly destination: Record<Direction, string>;
  readonly destinationValue: Record<Direction, string>;
  readonly rate: string;
  readonly rateValue: string;
  readonly presets: string;
  readonly cta: string;
  readonly note: string;
}

export const HERO: HeroCopy = {
  eyebrow: 'OTC desk for USDT and INR',
  headline: { lead: 'Buy & Sell', accent: 'USDT', tail: 'in India.' },
  lede: 'Large trades at one firm rate for the whole amount, settled only to the bank account or wallet you registered in advance.',
  points: [
    { icon: 'rupee', label: 'INR settlement' },
    { icon: 'lock', label: 'Locked rates' },
    { icon: 'dealer', label: 'A dealer on every trade' },
    { icon: 'destination', label: 'Registered destinations' },
  ],
  quote: {
    title: 'Request a quote',
    amount: { SELL_USDT: 'You sell', BUY_USDT: 'You buy' },
    counter: { SELL_USDT: 'You receive', BUY_USDT: 'You pay' },
    counterValue: 'INR, priced by the desk',
    destination: { SELL_USDT: 'Paid to', BUY_USDT: 'Delivered to' },
    destinationValue: { SELL_USDT: 'Your registered bank account', BUY_USDT: 'Your registered TRC20 wallet' },
    rate: 'Rate',
    rateValue: 'Firm, locked when you accept',
    presets: 'Common amounts',
    cta: 'Request quote',
    note: 'Sent from your client account. New clients are onboarded by the desk first.',
  },
  voice: {
    control: 'Voice',
    on: 'Voice cues are on. Press to mute them.',
    off: 'Voice cues are off. Press to turn them on.',
    lines: {
      ready: 'Ready when you are.',
      direction: 'Direction updated.',
      amount: 'Got it.',
      request: "I'll send this to the desk.",
      received: 'Request received.',
    },
  },
};

/** The masthead's links: pages that explain the desk. Buying and selling are chosen in one place — the hero. */
export const NAV: readonly { readonly label: string; readonly path: string }[] = [
  { label: 'OTC desk', path: '/usdt-otc-india' },
  { label: 'USDT to INR', path: '/usdt-to-inr' },
  { label: 'INR to USDT', path: '/inr-to-usdt' },
];

const HOME: SitePage = {
  path: '/',
  title: `Buy and sell USDT in India — ${SITE_NAME}`,
  description:
    'An OTC desk for USDT and Indian rupees. Ask for a price on your trade, accept it while it is firm, and settle to a bank account or wallet you registered in advance.',
  h1: `${HERO.headline.lead} ${HERO.headline.accent} ${HERO.headline.tail}`,
  lede: TAGLINE,
  sections: [
    {
      heading: 'A desk, not an order book',
      body: [
        'Every trade here is priced by a dealer for that trade. You say the direction, the amount and which side is fixed; you get one firm price with an expiry on it, and you decide.',
        'That is the right shape for a large trade. A book fills you in pieces at prices you find out afterwards. A quote tells you the rate before you commit to it, and the rate you accepted is the rate the trade is written with.',
      ],
    },
    {
      heading: 'Both directions',
      body: [
        'Sell USDT and receive INR to a registered Indian bank account. Buy USDT with INR and receive it at a registered TRC20 wallet.',
        'Destinations are registered before a trade, not typed during one. A trade pays where it agreed to pay, and changing that is a separate, deliberate act.',
      ],
    },
    {
      heading: 'What you get at the end',
      body: [
        'A settlement receipt for every completed trade: what was agreed, what arrived, and each payment that settled it with its own bank reference.',
        'The receipt is written once, when the trade completes, and regenerates identically afterwards. It is the record of the trade, not a view of a screen that may have moved on.',
      ],
    },
  ],
  priority: 1,
};

const USDT_TO_INR: SitePage = {
  path: '/usdt-to-inr',
  title: `USDT to INR — convert Tether to Indian rupees | ${SITE_NAME}`,
  description:
    'Convert USDT to INR through an OTC desk: a firm quoted rate with an expiry, TRC20 USDT in, and INR out to a bank account registered in advance.',
  h1: 'USDT to INR',
  lede: 'A quoted rate for your trade, and INR to a bank account you registered before it started.',
  sections: [
    {
      heading: 'How the conversion is priced',
      body: [
        'You name the USDT amount, or the INR you need to receive — one side is fixed and the other follows from the rate. The dealer answers with a single rate for the whole trade.',
        'The quote carries its expiry in it. Until it expires the rate is firm; once accepted it is frozen into the trade and nothing later changes it.',
      ],
    },
    {
      heading: 'How the USDT moves',
      body: [
        'Each sell trade is issued its own TRC20 deposit address. Nothing is attributed by amount or by which wallet it came from — the address is what ties your transfer to your trade.',
        'The transfer is recognised once the chain has made it final, not when it first appears.',
      ],
    },
    {
      heading: 'How the INR is paid',
      body: [
        'INR is paid to an Indian bank account registered against your client record. A payout may arrive as more than one transfer; each one carries its own bank reference and is recorded against the trade.',
        'The trade completes when the payments add up to what was agreed, and the receipt lists every one of them.',
      ],
    },
  ],
  priority: 0.9,
};

const INR_TO_USDT: SitePage = {
  path: '/inr-to-usdt',
  title: `INR to USDT — buy Tether with Indian rupees | ${SITE_NAME}`,
  description:
    'Convert INR to USDT through an OTC desk: a firm quoted rate with an expiry, INR to a named settlement account, and USDT to a wallet registered in advance.',
  h1: 'INR to USDT',
  lede: 'A quoted rate for your trade, and USDT to a TRC20 wallet you registered before it started.',
  sections: [
    {
      heading: 'How the conversion is priced',
      body: [
        'Fix the INR you want to spend or the USDT you want to end up with; the dealer prices the trade and the other side follows from that one rate.',
        'The rate holds until the quote expires. Accepting it writes it into the trade, where it stays for good.',
      ],
    },
    {
      heading: 'How the INR moves',
      body: [
        'Your trade names the settlement account to transfer to and the reference to use. The transfer is matched to your trade by that reference, and confirmed against the bank’s own record of it.',
      ],
    },
    {
      heading: 'How the USDT is delivered',
      body: [
        'USDT is sent on TRON (TRC20) to a wallet address registered against your client record. The trade records the transaction hash of the transfer that settled it.',
        'Registering the wallet in advance is deliberate: an address typed under time pressure is the most expensive mistake available in this market.',
      ],
    },
  ],
  priority: 0.9,
};

const SELL_IN_INDIA: SitePage = {
  path: '/sell-usdt-in-india',
  title: `Sell USDT in India — OTC desk for large trades | ${SITE_NAME}`,
  description:
    'Sell USDT for INR through an OTC desk. A dealer quotes your trade, the rate is locked when you accept, and INR settles to a registered Indian bank account.',
  h1: 'Sell USDT in India',
  lede: 'For trades big enough that the price you are shown should be the price you get.',
  sections: [
    {
      heading: 'Who this is for',
      body: [
        'Businesses and individuals moving amounts where slippage matters more than convenience: the whole trade at one agreed rate, settled to a bank account that already belongs to you on our records.',
        'If you are selling a small amount and want it now, an exchange app will serve you better than a desk will. This is built for the other case.',
      ],
    },
    {
      heading: 'What we need before the first trade',
      body: [
        'A client record, the people authorised to accept quotes on it, and at least one Indian bank account to pay to. Onboarding is done by the desk, not by a form on this page.',
        'Every one of those is checked again when a trade settles, which is why they are set up once rather than asked for each time.',
      ],
    },
    {
      heading: 'What happens if something goes wrong',
      body: [
        'Anything that does not match — a different amount than expected, a transfer from somewhere unexpected, a payment that fails — opens a case against the trade and pauses it rather than guessing.',
        'A paused trade is worked by a person and then either continued or corrected in a way that is recorded. Nothing is quietly adjusted.',
      ],
    },
  ],
  priority: 0.8,
};

const BUY_IN_INDIA: SitePage = {
  path: '/buy-usdt-in-india',
  title: `Buy USDT in India — OTC desk for large trades | ${SITE_NAME}`,
  description:
    'Buy USDT with INR through an OTC desk. A dealer quotes your trade, the rate is locked when you accept, and USDT is delivered to a registered TRC20 wallet.',
  h1: 'Buy USDT in India',
  lede: 'One rate for the whole trade, agreed before you send anything.',
  sections: [
    {
      heading: 'Who this is for',
      body: [
        'Buyers who would rather agree a rate with a person than watch one move while an order fills. You are quoted for the size you actually want.',
        'The quote is firm until it expires, so the decision is yours to make rather than a race against the screen.',
      ],
    },
    {
      heading: 'Where the USDT goes',
      body: [
        'To a TRC20 wallet registered against your client record before the trade, and to no other address. The trade records the transaction that delivered it.',
      ],
    },
    {
      heading: 'What we need before the first trade',
      body: [
        'A client record, the people authorised to accept quotes on it, and a registered wallet. Onboarding is done by the desk.',
      ],
    },
  ],
  priority: 0.8,
};

const OTC_INDIA: SitePage = {
  path: '/usdt-otc-india',
  title: `USDT OTC desk in India | ${SITE_NAME}`,
  description:
    'An over-the-counter desk for USDT and INR in India: quoted trades, locked rates, registered settlement destinations and a receipt for every completed trade.',
  h1: 'USDT OTC in India',
  lede: 'Quoted trades, locked rates, and a written record of how each one settled.',
  sections: [
    {
      heading: 'What "OTC" means here',
      body: [
        'Over-the-counter means the trade is agreed between you and a desk rather than matched on a public book. You ask, a dealer prices it, you accept or you do not.',
        'It also means the terms are written down: the rate, the amounts, the destination and the expiry are fixed at acceptance and become the trade.',
      ],
    },
    {
      heading: 'How a quote is delivered',
      body: [
        'In the client app, or as a private link you can open on a phone. Opening a link shows the price and nothing else — accepting it needs a code sent to a verified address of someone authorised to decide.',
        'Holding the link is not authority to trade. That is deliberate: links get forwarded.',
      ],
    },
    {
      heading: 'What is recorded',
      body: [
        'Every trade keeps the terms it was written with, every payment that settled it, and the receipt generated when it completed. Corrections are recorded as corrections rather than edits.',
      ],
    },
  ],
  priority: 0.7,
};

/** The six routes of PRODUCT §7.4, in sitemap order. Nothing else is published on the public host. */
export const SITE_PAGES: readonly SitePage[] = [HOME, USDT_TO_INR, INR_TO_USDT, SELL_IN_INDIA, BUY_IN_INDIA, OTC_INDIA];

export const SITE_PATHS: readonly string[] = SITE_PAGES.map((p) => p.path);

export const pageForPath = (path: string): SitePage | undefined => SITE_PAGES.find((p) => p.path === path);

/** The footer's one honest sentence about what this page is and is not. */
export const FOOTER_NOTE =
  'INRP2P Exchange is an over-the-counter desk. Nothing on this site is an offer, a price, or advice; a price exists only in a quote issued to a client for a specific trade.';
