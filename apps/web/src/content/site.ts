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
  /** What the guide's robot says on its visor, in its LEDs. */
  readonly led?: string;
  /**
   * On the rate pages people search for: the direction whose market rate the guide prints into its HTML — in its first
   * screen and as a table of common amounts — and shows live beside the robot.
   */
  readonly rate?: Direction;
  /** Who the guide is for: a client (the default — buy, sell, a firm price) or a trader (open an exchange). */
  readonly audience?: 'client' | 'trader';
  /** The questions people search with before this deal, answered in the product's terms; marked up as an FAQ. */
  readonly faq?: readonly { readonly question: string; readonly answer: string }[];
}

/** The product's own name, used in copy and in the structured data. Never abbreviated into a claim. */
export const SITE_NAME = 'INRP2P Exchange';

/** The one-line positioning from PRODUCT §7.4. Positioning, not measurement: no figure appears in it. */
export const TAGLINE = 'Firm rates. Escrow on every deal. Rupees bank to bank.';

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
  { label: 'Get a firm price', kind: 'secondary', appPath: '/exchange' },
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
}

export type HeroPointIcon = 'rupee' | 'lock' | 'dealer' | 'destination';

/**
 * The way in for someone who is not a client yet (D-17): they open their own account in the workspace, with the same
 * email code a client signs in with — so the way in is the workspace gateway, offered wherever the question comes up.
 */
export const ONBOARDING = {
  prompt: 'New here?',
  label: 'Open an account',
  /** The workspace gateway: sign in, or open an account with the same email code. */
  appPath: '/sign-in',
  /** What an SEO page says under its actions, before the link. */
  requirement: 'Trading needs an account with your bank account and wallet added once. You open it yourself, with your email.',
} as const;

/** Words that change with the direction are keyed by it, so the module can never pair a label with the wrong side. */
export interface QuoteModuleCopy {
  readonly title: string;
  /** The USDT side: what the visitor types. */
  readonly amount: Record<Direction, string>;
  /** The rupee side: an estimate at the market's rate when there is one (ADR 0025), else what the price will be. */
  readonly counter: Record<Direction, string>;
  readonly counterValue: string;
  /** Under the estimate: whose rate it is, and that the firm price comes next. `{rate}` is the market's rate. */
  readonly market: string;
  /** The button between the two sides that turns the deal round. */
  readonly swap: string;
  /** One line under the two sides: what the escrow does for this direction. */
  readonly promise: Record<Direction, string>;
  readonly presets: string;
  readonly cta: string;
  /** Shown under the amount when the call to action is pressed without one; the visitor stays on the page. */
  readonly amountRequired: string;
  /** Under the call to action, followed by the way in for a visitor who is not a client yet (ONBOARDING). */
  readonly note: string;
}

export const HERO: HeroCopy = {
  eyebrow: 'P2P without trusting strangers',
  headline: { lead: 'Buy & Sell', accent: 'USDT', tail: 'in India.' },
  lede: 'One firm rate for the whole amount. Nobody sends first: the USDT sits in escrow until the rupees hit the seller’s bank, and it is released only then.',
  points: [
    { icon: 'destination', label: 'Nobody sends first' },
    { icon: 'lock', label: 'Rate locked when you accept' },
    { icon: 'rupee', label: 'Third-party rupees bounced' },
    { icon: 'dealer', label: 'Every trader reviewed' },
  ],
  quote: {
    title: 'Request a quote',
    amount: { SELL_USDT: 'You sell', BUY_USDT: 'You buy' },
    counter: { SELL_USDT: 'You receive', BUY_USDT: 'You pay' },
    counterValue: 'One firm price for the whole amount',
    market: 'At today’s market rate of ₹{rate} — your firm price is the next step',
    swap: 'Switch between selling and buying',
    promise: {
      SELL_USDT: 'Your USDT waits in escrow until the rupees are in your bank',
      BUY_USDT: 'The USDT is locked in escrow before you pay a rupee',
    },
    presets: 'Common amounts',
    cta: 'Get a firm price',
    amountRequired: 'Enter an amount to get a price.',
    note: 'You decide after you see the price.',
  },
};

/** Words that are the same in both directions, written once. */
const both = (text: string): Record<Direction, string> => ({ SELL_USDT: text, BUY_USDT: text });

/**
 * The home page's "how it works": one deal, told in the four moments every P2P deal on INRP2P passes (ADR 0019) — the
 * price, the escrow, the rupees, the release — and drawn as the picture the workspace shows on every deal page: the
 * seller on the left, INRP2P's escrow in the middle, the buyer on the right; the USDT along the top, the rupees back
 * along the bottom, bank to bank.
 *
 * Both directions run through the same four moments; who is "you" changes side, and so do the words. Every moment says
 * what happens there — a mechanism, never a duration.
 */
export const FLOW_STEPS = ['price', 'escrow', 'rupees', 'release'] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export interface FlowStepCopy {
  readonly key: FlowStep;
  readonly title: Record<Direction, string>;
  readonly body: Record<Direction, string>;
}

export interface FlowCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  /** The switch that shows the other direction. Its options are named for the accessible name. */
  readonly direction: { readonly label: string; readonly options: Record<Direction, string> };
  /** The three parties on the picture, by side; "you" is the seller when selling and the buyer when buying. */
  readonly parties: { readonly seller: Record<Direction, string>; readonly escrow: string; readonly buyer: Record<Direction, string> };
  /** The two lanes' names. */
  readonly lanes: { readonly usdt: string; readonly rupees: string };
  readonly steps: readonly FlowStepCopy[];
  /** Under the steps: what every deal ends with. */
  readonly done: string;
  /** Where the USDT travels, beside it. */
  readonly network: string;
}

export const FLOW: FlowCopy = {
  eyebrow: 'How it works',
  heading: 'Nobody sends first. The robot holds the USDT.',
  lede: 'The USDT goes into the robot’s chest and leaves only once the rupees have landed. Pick a side and follow the money.',
  direction: { label: 'Direction shown', options: { SELL_USDT: 'Sell USDT', BUY_USDT: 'Buy USDT' } },
  parties: {
    seller: { SELL_USDT: 'You', BUY_USDT: 'Trader' },
    escrow: 'INRP2P escrow',
    buyer: { SELL_USDT: 'Trader', BUY_USDT: 'You' },
  },
  lanes: { usdt: 'USDT', rupees: 'Rupees, bank to bank' },
  steps: [
    {
      key: 'price',
      title: both('Ask for a firm price'),
      body: both('Name the amount. One rate comes back for all of it, with its expiry on it. Accept, and it is locked: no “rate changed, send a bit more”.'),
    },
    {
      key: 'escrow',
      title: { SELL_USDT: 'Your USDT goes into escrow', BUY_USDT: 'The trader locks the USDT' },
      body: {
        SELL_USDT: 'You send it to an escrow address made for this deal alone. Only INRP2P can release it.',
        BUY_USDT: 'The USDT goes into this deal’s own escrow address before you pay a single rupee.',
      },
    },
    {
      key: 'rupees',
      title: { SELL_USDT: 'The trader pays you', BUY_USDT: 'You pay the trader' },
      body: {
        SELL_USDT: 'Straight to your bank account, by UPI, IMPS, NEFT or RTGS, from the trader’s own account.',
        BUY_USDT: 'From your own bank account to theirs, by UPI, IMPS, NEFT or RTGS. The rupees never pass through INRP2P.',
      },
    },
    {
      key: 'release',
      title: { SELL_USDT: 'You confirm, escrow releases', BUY_USDT: 'The USDT lands in your wallet' },
      body: {
        SELL_USDT: 'Check the rupees arrived. Only then does the USDT leave escrow for the trader.',
        BUY_USDT: 'The trader confirms your rupees, and the escrow pays the USDT to your wallet.',
      },
    },
  ],
  done: 'Every deal ends with a receipt, not a screenshot.',
  network: 'USDT on TRON · TRC20',
};

/**
 * The workspace, shown rather than described: the screen a client asks for a price on, and the deal on a phone. The
 * features beside it are what the client app does today (ADR 0023 chat, ADR 0026 sign-in, ADR 0029 UPI IDs, the team,
 * the history); the drawing's figures are the visitor's example amount at the market's own rate, or words without one.
 */
export type ShowcaseIcon = 'rate' | 'chat' | 'bank' | 'key' | 'team' | 'history';

export interface ShowcaseCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly features: readonly { readonly icon: ShowcaseIcon; readonly title: string; readonly body: string }[];
  readonly mock: {
    readonly nav: readonly string[];
    readonly request: string;
    readonly youSell: string;
    readonly paidTo: string;
    readonly bank: string;
    readonly lock: string;
    readonly held: string;
    readonly youReceive: string;
    readonly market: string;
    readonly words: string;
    readonly accept: string;
    readonly decline: string;
    readonly perUsdt: string;
    readonly network: string;
    readonly trade: string;
    readonly yourMove: string;
    readonly confirmTitle: string;
    readonly chat: readonly { readonly from: 'them' | 'you'; readonly text: string }[];
    readonly release: string;
    readonly toast: { readonly title: string; readonly body: string };
  };
}

export const SHOWCASE: ShowcaseCopy = {
  eyebrow: 'The workspace',
  heading: 'Looks like an app. Works like a vault.',
  lede: 'Your price, your escrow, your chat with the trader and every deal you have made. On the web and on your phone.',
  features: [
    { icon: 'rate', title: 'One price for all of it', body: 'Ask with an amount and see a single rate for the whole of it. It holds while you decide.' },
    { icon: 'chat', title: 'A chat in every deal', body: 'Talk to the trader inside the deal, attach the payment reference, and bring INRP2P in when you need to.' },
    { icon: 'bank', title: 'Saved once, used every time', body: 'Your bank account, UPI ID and TRON wallet. Every deal pays to them and nowhere else.' },
    { icon: 'key', title: 'No password to forget', body: 'Sign in with a code to your email, or with Telegram once you link it.' },
    { icon: 'team', title: 'Your team on one account', body: 'Invite the people you trade with, and choose who may accept a price.' },
    { icon: 'history', title: 'Every deal on record', body: 'Your history, with the rate, the payments and the receipt of every deal.' },
  ],
  mock: {
    nav: ['Exchange', 'History', 'Bank & wallets'],
    request: 'Your request',
    youSell: 'You sell',
    paidTo: 'Rupees paid to',
    bank: 'Your bank account',
    lock: 'Your USDT waits in escrow until the rupees are in your bank',
    held: 'Firm quote · held for you',
    youReceive: 'You receive',
    market: 'At today’s market rate',
    words: 'One firm price for the whole amount',
    accept: 'Accept this quote',
    decline: 'Decline, your request stays open',
    perUsdt: 'per USDT',
    network: 'Network fee on its own line',
    trade: 'Your deal',
    yourMove: 'Your move',
    confirmTitle: 'Did the rupees arrive?',
    chat: [
      { from: 'them', text: 'Paid by IMPS, the reference is attached.' },
      { from: 'you', text: 'Checking my bank now.' },
    ],
    release: 'Release the USDT',
    toast: { title: 'Rupees received', body: 'From the trader’s own account' },
  },
};

/**
 * Why INRP2P: the same deal done two ways — with someone found in a chat, and here — row by row.
 *
 * Every line on INRP2P's side is something the software does on every P2P deal (ADR 0019, ADR 0020 §2.15): escrow,
 * the firm rate, reviewed traders, the sender check, time limits that unwind a deal, disputes decided on the bank's
 * evidence, the receipt. The other side names no one: it is the deal people do without an escrow.
 */
export interface WhyCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  /**
   * The scene above the table: the same deal twice — as a chat that goes wrong, and as a deal here, step by step.
   * Drawn for the eye; the table under it says the same in full.
   */
  readonly scene: {
    readonly chat: { readonly title: string; readonly messages: readonly { readonly from: 'them' | 'you' | 'system'; readonly text: string; readonly kind?: 'screenshot' }[] };
    readonly ours: { readonly title: string; readonly line: string; readonly note: string };
  };
  /** The table's caption, for whoever reads it without seeing it. */
  readonly caption: string;
  readonly columns: { readonly topic: string; readonly direct: string; readonly ours: string };
  readonly rows: readonly { readonly topic: string; readonly direct: string; readonly ours: string }[];
}

export const WHY: WhyCopy = {
  eyebrow: 'Why INRP2P',
  heading: '“Bhai, send first”? Not here.',
  lede: 'Every P2P horror story starts in a chat. Here is the same deal, done both ways.',
  scene: {
    chat: {
      title: 'Deal in a chat',
      messages: [
        { from: 'them', text: 'Bhai, send the USDT first, I pay right after' },
        { from: 'you', text: 'Sent. Waiting for the rupees' },
        { from: 'them', text: 'Paid. Here is the screenshot', kind: 'screenshot' },
        { from: 'you', text: 'Nothing in my bank. Hello?' },
        { from: 'system', text: 'This person left the chat' },
      ],
    },
    ours: {
      title: 'Deal on INRP2P',
      line: 'Nobody sent first. Everybody got paid.',
      note: 'The USDT waited in escrow. The rupees went bank to bank, from the buyer’s own account. Then the escrow let go.',
    },
  },
  caption: 'A deal in a chat compared with a deal on INRP2P',
  columns: { topic: 'In the deal', direct: 'Deal in a chat', ours: 'Deal on INRP2P' },
  rows: [
    {
      topic: 'Who sends first',
      direct: 'You, on trust.',
      ours: 'Nobody on trust. The USDT waits in escrow, and whoever’s money is at risk goes second.',
    },
    {
      topic: 'The price',
      direct: '“Rate changed, send a bit more.”',
      ours: 'One firm rate for the whole amount, locked the moment you accept.',
    },
    {
      topic: 'Proof of payment',
      direct: 'A screenshot. Easy to fake.',
      ours: 'The rupees in the seller’s own bank account. A screenshot is not money.',
    },
    {
      topic: 'Whose rupees',
      direct: 'Any account, in anyone’s name.',
      ours: 'Only the other side’s own account. Third-party rupees are refused and sent back.',
    },
    {
      topic: 'If they go quiet',
      direct: 'Your money goes quiet with them.',
      ours: 'Every step has a time limit. Miss it and the deal unwinds: the USDT goes back where it came from.',
    },
    {
      topic: 'If something is wrong',
      direct: 'Nobody to call.',
      ours: 'Open a dispute on the deal. INRP2P decides it on the bank’s evidence.',
    },
    {
      topic: 'Afterwards',
      direct: 'A chat history and a few screenshots.',
      ours: 'A receipt for every deal, as a document, CSV and JSON.',
    },
  ],
};

/**
 * The questions a first-time client asks before a first deal, answered in the product's own terms. Each answer is
 * a mechanism, never a speed or a figure; the last one points to the desk programme further up the page.
 */
export interface FaqCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly items: readonly {
    readonly question: string;
    readonly answer: string;
    /** A section of this page that answers it at length. */
    readonly more?: { readonly label: string; readonly anchor: string };
  }[];
  /** Beside the questions, as the robot's speech bubble: the way to ask one that is not answered here — the CEO. */
  readonly ask: { readonly title: string; readonly body: string };
}

export const FAQ: FaqCopy = {
  eyebrow: 'Questions',
  heading: 'Before your first deal.',
  lede: 'What people ask before they trust a robot with their USDT.',
  items: [
    {
      question: 'Who is on the other side of my deal?',
      answer: 'A trader INRP2P reviewed before their first deal. INRP2P sets your price and holds the USDT; the trader pays you, or is paid by you, bank to bank.',
    },
    {
      question: 'Where is my USDT while the deal runs?',
      answer: 'In an escrow address made for that one deal. Only INRP2P can move it, and only where the deal says: to you, to the trader, or back where it came from.',
    },
    {
      question: 'What if the rupees don’t arrive?',
      answer: 'Say so on the deal, and the USDT stays in escrow. If the other side misses their time limit, the deal unwinds; if they say they paid, INRP2P decides on the bank’s evidence.',
    },
    {
      question: 'How do I pay and get paid in rupees?',
      answer: 'From and to your own bank account, by UPI, IMPS, NEFT or RTGS. You add the account once, before your first deal. The rupees never pass through INRP2P.',
    },
    {
      question: 'What does it cost?',
      answer: 'The market’s rate, and one line more: the network fee, what TRON charges for this deal’s escrow and its transfers. Both are on your quote before you accept. If a sale is cancelled after you send USDT, it comes back less its own network fee, shown on the deal before you send.',
    },
    {
      question: 'Which network is the USDT on?',
      answer: 'TRON (TRC20). Send only to the escrow address shown on your deal: a TRON transfer cannot be recalled once it is final.',
    },
    {
      question: 'How do I start?',
      answer: 'Open an account with your email, add your bank account and your wallet, and ask for your first price. You decide after you see it.',
    },
    {
      question: 'Can I earn on INRP2P as a trader?',
      answer: 'Yes: open your own exchange. You set your margin over the market — traders in India commonly work at {margin} — and INRP2P takes {fee} of each deal, with its escrow on every one. You also get your own page, deal links, a team and Telegram alerts.',
      more: { label: 'See what your USDT earns', anchor: 'own-desk' },
    },
  ],
  ask: { title: 'Something else?', body: 'Ask the robot’s boss. Our CEO answers on Telegram, in person.' },
};

/**
 * The trader programme's terms: the only figures the public site states, each taken from where it is decided. The fee is
 * the fee policy's own-deal basis points (migration 0040, `fee_policy.own_deal_bps`; a change of it is two people's
 * decision, and this constant moves with it — the copy guard holds the two together). The margin band is the owner's
 * (2026-11-21): the margin over the market that traders in India commonly work at, and the band the earnings example on
 * the home page lets a trader pick from.
 *
 * Copy never writes these figures out. It names them — `{margin}`, `{fee}` — and `withTerms` fills them in where the
 * words are drawn, so the copy guard still reads every sentence for a figure somebody typed.
 */
export const TRADER_TERMS = {
  /** INRP2P's fee on a deal a trader's own exchange fills itself, in basis points of the deal's USDT. */
  feeBps: 25,
  /** The margin band, in whole per cent of the deal: low, the one an example starts from, high. */
  margin: { low: 5, typical: 6, high: 7 },
} as const;

/** The fee as a person reads it: `0.25%`. */
export const feeText = (): string => `${TRADER_TERMS.feeBps / 100}%`;

/** The margin band as a person reads it: `5–7%`. */
export const marginText = (): string => `${TRADER_TERMS.margin.low}–${TRADER_TERMS.margin.high}%`;

/** A sentence with the programme's terms filled in. */
export const withTerms = (text: string): string => text.replaceAll('{margin}', marginText()).replaceAll('{fee}', feeText());

/**
 * A trader's own exchange on INRP2P (ADR 0020): the desk programme, told to the traders who would run one — and told
 * with money first. The section opens on what a trader earns (the margin is theirs, INRP2P's fee is the policy's) and an
 * example they set themselves at the market's own rate, then what stops costing them, then the exchange itself: the
 * page, deal links, escrow, prices, the team, Telegram alerts — every one something the workspace does today.
 */
export const OWN_DESK_FEATURES = ['page', 'link', 'prices', 'team', 'alerts'] as const;
export type OwnDeskFeature = (typeof OWN_DESK_FEATURES)[number];

export interface OwnDeskCopy {
  readonly nav: string;
  /** Beside the masthead's link to this section, in a chip: the margin, as a hook. */
  readonly navTag: string;
  readonly announce: { readonly tag: string; readonly text: string };
  readonly eyebrow: string;
  /** Read as one sentence; drawn as a lead, the margin as a monument, and a tail. `{margin}` is the band. */
  readonly heading: string;
  readonly headline: { readonly lead: string; readonly figure: string; readonly tail: string };
  /** Under the monument: what INRP2P takes. */
  readonly fee: string;
  readonly lede: string;
  /** The example a trader sets: their USDT, how often it turns over, their margin — and what they keep. */
  readonly earnings: {
    readonly title: string;
    readonly live: string;
    readonly liquidity: string;
    /** Example amounts of USDT, as a trader would hold them. Figures of the example, not of anybody's business. */
    readonly amounts: readonly number[];
    readonly turns: string;
    readonly turnOptions: readonly { readonly label: string; readonly perMonth: number }[];
    readonly margin: string;
    readonly result: string;
    readonly inUsdt: string;
    readonly turnover: string;
    readonly yours: string;
    readonly ours: string;
    readonly note: string;
  };
  /** What a trader stops losing to: the cost, struck out, and what does it here instead. */
  readonly stops: { readonly title: string; readonly items: readonly { readonly cost: string; readonly fix: string }[] };
  readonly tools: { readonly title: string; readonly lede: string };
  readonly features: readonly { readonly key: OwnDeskFeature; readonly title: string; readonly body: string }[];
  readonly mock: {
    readonly deskName: string;
    readonly handle: string;
    readonly taking: string;
    readonly sell: string;
    readonly buy: string;
    readonly perUsdt: string;
    readonly market: string;
    readonly followMarket: string;
    readonly ask: string;
    readonly chat: string;
    readonly linkTitle: string;
    readonly linkMeta: string;
    readonly held: string;
    readonly take: string;
    readonly youBuy: string;
    readonly youSell: string;
    readonly live: string;
    readonly holdFor: string;
    readonly holds: readonly string[];
    readonly team: readonly { readonly name: string; readonly role: string }[];
    readonly bot: string;
    readonly alerts: readonly { readonly title: string; readonly body: string }[];
    readonly flow: readonly string[];
  };
  readonly steps: readonly { readonly title: string; readonly body: string }[];
  readonly cta: { readonly title: string; readonly label: string; readonly appPath: string; readonly signedIn: string; readonly signedInPath: string };
}

export const OWN_DESK: OwnDeskCopy = {
  nav: 'For traders',
  navTag: '{margin}',
  announce: { tag: 'Traders', text: 'Earn {margin} on your USDT' },
  eyebrow: 'For traders',
  heading: 'Earn {margin} on every USDT you sell.',
  headline: { lead: 'Earn', figure: '{margin}', tail: 'on every USDT you sell.' },
  fee: 'INRP2P takes {fee} of a deal. The rest is yours.',
  lede: 'Buyers in India pay a premium for USDT. Sell to them from your own exchange, at the margin you set, with INRP2P’s escrow on every deal.',
  earnings: {
    title: 'What your USDT earns',
    live: 'At today’s market rate',
    liquidity: 'Your USDT',
    amounts: [5_000, 10_000, 25_000, 100_000],
    turns: 'It turns over',
    turnOptions: [
      { label: 'Once a week', perMonth: 4 },
      { label: 'Twice a week', perMonth: 8 },
      { label: 'Every day', perMonth: 30 },
    ],
    margin: 'Your margin',
    result: 'You keep, a month',
    inUsdt: 'USDT a month',
    turnover: 'on a month’s deals of',
    yours: 'Yours',
    ours: 'INRP2P',
    note: 'An example at your figures. Your margin is the price you set over the market.',
  },
  stops: {
    title: 'What you stop paying for',
    items: [
      { cost: 'Frozen bank accounts', fix: 'Rupees reach you only from your client’s own account. Anyone else’s are refused and sent back.' },
      { cost: 'Fake payment screenshots', fix: 'You release the USDT once the rupees are in your bank, and not a moment before.' },
      { cost: 'Posting rates all day', fix: 'Set your margin once. Your prices follow the market by themselves.' },
      { cost: 'Clients who go quiet', fix: 'Every step has a time limit. A deal nobody finishes unwinds, and the USDT goes back.' },
    ],
  },
  tools: {
    title: 'Your exchange, already built.',
    lede: 'Your page, your prices, deal links, a team and Telegram alerts. Ready once INRP2P approves you.',
  },
  features: [
    {
      key: 'page',
      title: 'Your page, at your own address.',
      body: 'Clients open your page, see your rates and ask for a firm price under your name. Every client who comes through it is yours.',
    },
    {
      key: 'link',
      title: 'A deal link for one client.',
      body: 'Price a deal for one client and send it on WhatsApp or Telegram. They open it, sign in with their email and take it while the price holds.',
    },
    {
      key: 'prices',
      title: 'Prices you control.',
      body: 'Follow the market or set your own rate, your smallest and largest deal, and how long a price holds. It switches itself off when its time runs out.',
    },
    {
      key: 'team',
      title: 'A team, with roles.',
      body: 'Invite operators to work deals and administrators to run the desk. Every step is recorded against the person who took it.',
    },
    {
      key: 'alerts',
      title: 'Alerts where you already are.',
      body: 'A new deal, your move, a client who has paid: Telegram tells you, and reminds you before a step runs out of time.',
    },
  ],
  mock: {
    deskName: 'Your desk',
    handle: 'your-desk',
    taking: 'Taking deals',
    sell: 'Sell USDT',
    buy: 'Buy USDT',
    perUsdt: 'INR per USDT',
    market: 'At market',
    followMarket: 'Follows the market',
    ask: 'Get a firm price',
    chat: 'Here is your deal — the price holds while you sign in.',
    linkTitle: 'A deal from Your desk',
    linkMeta: 'USDT at',
    held: 'Price held',
    take: 'Take this deal',
    youBuy: 'You buy USDT',
    youSell: 'You sell USDT',
    live: 'Live',
    holdFor: 'Hold for',
    holds: ['Half a day', 'A day', 'A week'],
    team: [
      { name: 'Meera', role: 'Administrator' },
      { name: 'Ravi', role: 'Operator' },
      { name: 'Asha', role: 'Operator' },
    ],
    bot: 'INRP2P alerts',
    alerts: [
      { title: 'New deal on your desk', body: 'A client asked for a firm price.' },
      { title: 'Your move', body: 'Send the rupees before the step runs out.' },
      { title: 'Client has paid', body: 'Check your bank, then confirm.' },
    ],
    flow: ['Your client', 'Escrow by INRP2P', 'Your desk'],
  },
  steps: [
    { title: 'Apply with your email', body: 'Who you are and what you can provide. INRP2P reviews every trader before a first deal.' },
    { title: 'Set your prices', body: 'Your rates, your limits, and how long they hold.' },
    { title: 'Share your page', body: 'Send your address or a deal link. Clients sign in with their email and deal.' },
  ],
  cta: {
    title: 'Open your exchange in three steps.',
    label: 'Open your exchange',
    appPath: '/become-a-trader',
    signedIn: 'Already approved? Go to your desk',
    signedInPath: '/desk',
  },
};

/**
 * The page's last word: the call to action for a client, and the way in for someone who is not one yet.
 *
 * A trade is requested from a client account, so the action leads there. A visitor without one is told what the
 * desk sets up before a first trade, and offered the way in (ONBOARDING) when an address to write to is set.
 */
export const CLOSING = {
  heading: 'Put a robot in the middle of your next deal.',
  /** On the waving robot's visor, in its LEDs. */
  robot: 'Your move',
  body: 'Add your bank account and wallet once. Every deal after that: a firm rate before you agree, the USDT in escrow, the rupees bank to bank.',
  cta: { label: 'Get a firm price', appPath: '/exchange' },
  newClient: {
    title: ONBOARDING.prompt,
    body: 'Open an account with your email and a code, add the bank account and wallet you settle to, and ask for your first price.',
  },
} as const;

/**
 * The second door, for a trader or broker: an exchange of their own on INRP2P. It is the client app's trader entry,
 * where an email and a code start the application; INRP2P reviews every trader before a first deal, and the exchange
 * opens once it approves them. One name for the whole way — "Open your exchange" — wherever it is offered.
 */
export const TRADER_ENTRY = {
  label: 'Open your exchange',
  appPath: '/become-a-trader',
  title: 'Have USDT? Earn {margin} on it.',
  body: 'Open your own exchange on INRP2P: your page, your prices, your clients. INRP2P holds the escrow and takes {fee} of a deal.',
} as const;

/**
 * The footer's links, by what they are for. Every one leads somewhere that exists: a page, a section of the home
 * page, the client app, or an address that is configured. Nothing is linked that has not been written — there
 * is no privacy notice, no terms and no operating entity to name until they exist, so none is linked or named.
 */
export const FOOTER = {
  groups: { product: 'Product', pages: 'Guides', security: 'Safety', telegram: 'Telegram', contact: 'Contact' },
  links: {
    request: 'Get a firm price',
    signIn: 'Client sign in',
    trader: TRADER_ENTRY.label,
    flow: 'How it works',
    ownDesk: OWN_DESK.nav,
    why: 'Escrow and disputes',
    faq: 'Questions',
    securityReport: 'Report a security issue',
    onboarding: ONBOARDING.label,
    deskContact: 'Contact the desk',
  },
  /** The one risk that is the visitor's to manage and cannot be undone: where USDT is sent. */
  risk: 'A USDT transfer on TRON cannot be recalled once it is final. Send USDT only to the escrow address shown on your deal.',
  /** Whose names these are. */
  marks: 'USDT is a token issued by Tether; TRON and TRC20 are names of the network it is sent on. Neither is affiliated with INRP2P.',
} as const;

/**
 * INRP2P on Telegram: the two public channels and the CEO's own account. Each is a real public Telegram handle; a
 * handle is a name, not copy, so the copy guard skips it (it is read as `handle`).
 */
export interface TelegramContact {
  readonly handle: string;
  readonly label: string;
  readonly note: string;
}

export const TELEGRAM: {
  readonly title: string;
  readonly channels: readonly TelegramContact[];
  readonly ceo: TelegramContact;
} = {
  title: 'INRP2P on Telegram',
  channels: [
    { handle: 'INRP2P_Exchange', label: 'Official channel', note: 'News and updates from INRP2P' },
    { handle: 'INR_P2P_USDT', label: 'Traders and liquidity', note: 'Buy, sell, OTC and liquidity partners' },
  ],
  ceo: { handle: 'INRP2P_CEO', label: 'Message the CEO', note: 'Straight to the person in charge' },
};

/** A Telegram handle's public address. */
export const telegramUrl = (handle: string): string => `https://t.me/${handle}`;

/**
 * The masthead's way into the product. It opens the workspace itself — the client app's Exchange screen — and the
 * app decides what that takes: a client with a session is in at once, one without is asked for a code first. The
 * public host never holds a session, so it cannot tell which and names neither.
 */
export const WORKSPACE_ENTRY = { label: 'Open workspace', appPath: '/exchange' } as const;

/**
 * The masthead's links: the home page's sections, reached from any page. The guides are in the footer; buying and
 * selling are chosen in one place — the hero. The desk programme is drawn after these, marked as new.
 */
export const NAV: readonly { readonly label: string; readonly path: string }[] = [
  { label: 'How it works', path: '/#how-it-works' },
  { label: 'Why INRP2P', path: '/#why' },
  { label: 'Questions', path: '/#faq' },
];

const HOME: SitePage = {
  path: '/',
  title: `Buy & Sell USDT in India — P2P with escrow | ${SITE_NAME}`,
  description:
    'Buy and sell USDT for rupees in India with escrow on every deal. One firm rate for the whole amount, nobody sends first, and rupees bank to bank by UPI, IMPS, NEFT or RTGS.',
  h1: `${HERO.headline.lead} ${HERO.headline.accent} ${HERO.headline.tail}`,
  lede: TAGLINE,
  // The home page tells its story in its own sections (FLOW, OWN_DESK, WHY, FAQ, CLOSING), which say everything
  // the reading column once did: both directions, the escrow, and what happens when a deal goes wrong.
  sections: [],
  priority: 1,
};

const USDT_TO_INR: SitePage = {
  path: '/usdt-to-inr',
  title: `USDT to INR rate today — sell USDT with escrow | ${SITE_NAME}`,
  description:
    'Today’s USDT to INR market rate, and one firm rate for your whole amount. Sell USDT for rupees with your USDT in escrow until the rupees reach your bank.',
  h1: 'USDT to INR',
  lede: 'Sell USDT for rupees at one firm rate. Your USDT waits in escrow until the rupees are in your bank.',
  sections: [
    {
      heading: 'How the rate works',
      body: [
        'Name the USDT you sell, or the rupees you need. One firm rate comes back for the whole amount, at the market’s rate, with its expiry on it.',
        'The network fee is its own line on the quote, so you see what you get before you accept. Accept, and the rate is locked into the deal.',
      ],
    },
    {
      heading: 'Where your USDT waits',
      body: [
        'You send the USDT on TRON (TRC20) to an escrow address made for this deal alone. Only INRP2P can move it, and only where the deal says.',
        'A transfer counts once the chain has made it final, not when it first appears.',
      ],
    },
    {
      heading: 'How the rupees reach you',
      body: [
        'A reviewed trader pays you from their own bank account, by UPI, IMPS, NEFT or RTGS. Rupees from anyone else are refused and sent back.',
        'You check your bank and confirm. Only then is the USDT released to the trader, and the deal gets its receipt.',
      ],
    },
  ],
  priority: 0.9,
  led: 'USDT → ₹',
  rate: 'SELL_USDT',
  faq: [
    {
      question: 'What is the USDT to INR rate today?',
      answer: 'The market’s rate is at the top of this page and moves through the day. Your firm rate comes with your quote, for the whole amount, with the network fee on its own line.',
    },
    {
      question: 'Where does my USDT go while I wait for the rupees?',
      answer: 'To an escrow address made for your deal alone, on TRON. Only INRP2P can release it, and only after you confirm the rupees are in your bank.',
    },
    {
      question: 'Can I get paid by UPI?',
      answer: 'Yes. Add your UPI ID or bank account once, and the trader pays you from their own account by UPI, IMPS, NEFT or RTGS.',
    },
  ],
};

const INR_TO_USDT: SitePage = {
  path: '/inr-to-usdt',
  title: `INR to USDT rate today — buy USDT, escrow first | ${SITE_NAME}`,
  description:
    'Today’s INR to USDT market rate, and one firm rate for your whole amount. Buy USDT with rupees, with the USDT locked in escrow before you pay.',
  h1: 'INR to USDT',
  lede: 'Buy USDT with rupees at one firm rate. The USDT is locked in escrow before you pay a single rupee.',
  sections: [
    {
      heading: 'How the rate works',
      body: [
        'Name the USDT you want, or the rupees you will spend. One firm rate comes back for the whole amount, at the market’s rate, with its expiry on it.',
        'The network fee is its own line on the quote. Accept, and the rate is locked into the deal.',
      ],
    },
    {
      heading: 'Escrow before you pay',
      body: [
        'A reviewed trader puts the USDT into this deal’s own escrow address first. You are asked to pay only once it is there.',
        'You pay from your own bank account to theirs, by UPI, IMPS, NEFT or RTGS. The rupees never pass through INRP2P.',
      ],
    },
    {
      heading: 'Where the USDT goes',
      body: [
        'To the TRON (TRC20) wallet you added to your account, and nowhere else. The trader confirms your rupees and the escrow pays the USDT out.',
        'Adding the wallet once, before your first deal, is deliberate: an address typed in a hurry is the most expensive mistake in this market.',
      ],
    },
  ],
  priority: 0.9,
  led: '₹ → USDT',
  rate: 'BUY_USDT',
  faq: [
    {
      question: 'What is the INR to USDT rate today?',
      answer: 'The market’s rate is at the top of this page and moves through the day. Your firm rate comes with your quote, for the whole amount, with the network fee on its own line.',
    },
    {
      question: 'Do I pay before I get the USDT?',
      answer: 'You pay only after the trader has locked the USDT in your deal’s escrow. Once they confirm your rupees, the escrow sends the USDT to your wallet.',
    },
    {
      question: 'Which wallet can I use?',
      answer: 'Any TRON (TRC20) wallet you control. You add it once, and the USDT goes there and nowhere else.',
    },
  ],
};

const SELL_IN_INDIA: SitePage = {
  path: '/sell-usdt-in-india',
  title: `Sell USDT in India safely — P2P with escrow | ${SITE_NAME}`,
  description:
    'Sell USDT in India without sending first to a stranger: one firm rate, your USDT in escrow, and rupees to your own bank from the buyer’s own account.',
  h1: 'Sell USDT in India',
  lede: 'Without sending your USDT to a stranger first.',
  sections: [
    {
      heading: 'The trouble with selling in a chat',
      body: [
        'In a chat someone has to send first, and it is usually you. Then comes a screenshot instead of money, a rate that changed, or silence.',
        'On INRP2P nobody sends on trust. Your USDT waits in an escrow address only INRP2P can release, and only after you confirm the rupees.',
      ],
    },
    {
      heading: 'What you need',
      body: [
        'An account opened with your email, and the bank account or UPI ID you are paid to, added once before your first deal.',
        'Every trader on the other side was reviewed by INRP2P before their first deal.',
      ],
    },
    {
      heading: 'If something goes wrong',
      body: [
        'Every step has a time limit. If the buyer misses theirs, the deal unwinds and your USDT goes back where it came from.',
        'If they say they paid and you see nothing, say so on the deal: the USDT stays in escrow, and INRP2P decides on the bank’s evidence.',
      ],
    },
  ],
  priority: 0.8,
  led: 'SELL',
  faq: [
    {
      question: 'How do I sell USDT in India without sending first?',
      answer: 'Sell through escrow. On INRP2P your USDT waits in an escrow address, the rupees must come from the buyer’s own account, and the USDT is released only when you confirm them.',
    },
    {
      question: 'What if the buyer sends a fake payment screenshot?',
      answer: 'A screenshot changes nothing here. The USDT is released only when you confirm the rupees in your own bank account; until then it stays in escrow.',
    },
  ],
};

const BUY_IN_INDIA: SitePage = {
  path: '/buy-usdt-in-india',
  title: `Buy USDT in India safely — escrow before you pay | ${SITE_NAME}`,
  description:
    'Buy USDT in India with the USDT locked in escrow before you pay: one firm rate for the whole amount, rupees bank to bank, USDT to your own wallet.',
  h1: 'Buy USDT in India',
  lede: 'The USDT is locked before you pay a rupee.',
  sections: [
    {
      heading: 'Why escrow comes first',
      body: [
        'Buying in a chat means paying a stranger and hoping. Here the trader’s USDT is locked in this deal’s escrow address before you are asked to pay.',
        'Then you pay from your own bank account, and the escrow releases the USDT to your wallet once the trader confirms your rupees.',
      ],
    },
    {
      heading: 'What you need',
      body: [
        'An account opened with your email, the bank account you pay from, and the TRON wallet the USDT goes to, added once before your first deal.',
      ],
    },
    {
      heading: 'If something goes wrong',
      body: [
        'Every step has a time limit. If the trader never locks the USDT, you never pay.',
        'If you paid and they say nothing arrived, open a dispute on the deal: INRP2P decides it on the bank’s evidence.',
      ],
    },
  ],
  priority: 0.8,
  led: 'BUY',
  faq: [
    {
      question: 'How do I buy USDT in India without paying a stranger first?',
      answer: 'Buy through escrow. On INRP2P the trader’s USDT is locked in escrow before you pay, and every trader was reviewed before their first deal.',
    },
    {
      question: 'What if the trader does not release the USDT?',
      answer: 'The trader does not hold it: the escrow does. Once they confirm your rupees it goes to your wallet; if they say nothing arrived, open a dispute and INRP2P decides on the bank’s evidence.',
    },
  ],
};

const OTC_INDIA: SitePage = {
  path: '/usdt-otc-india',
  title: `USDT OTC in India — large P2P deals with escrow | ${SITE_NAME}`,
  description:
    'Large USDT deals in India: one firm rate for the whole amount, the USDT in escrow, rupees bank to bank, and a receipt for every deal.',
  h1: 'USDT OTC in India',
  lede: 'One firm rate for the whole amount, however large, and escrow on every deal.',
  sections: [
    {
      heading: 'One price for the whole deal',
      body: [
        'Ask with the whole amount and get one firm rate for all of it, not a book that fills piece by piece. It holds until its expiry; accept, and it is locked.',
      ],
    },
    {
      heading: 'Traders who run their own desk',
      body: [
        'Traders and brokers on INRP2P run their own exchange: a page, prices and deal links for their clients. Every deal through them carries the same escrow.',
        'A deal link opens the price on your phone. Taking it needs you to sign in: holding a link is not authority to trade.',
      ],
    },
    {
      heading: 'What is recorded',
      body: [
        'Every deal keeps its rate, its payments and its receipt, as a document, CSV and JSON. Your team can share one account, and you choose who may accept a price.',
      ],
    },
  ],
  priority: 0.7,
  led: 'OTC',
  faq: [
    {
      question: 'Can I get one price for a large amount?',
      answer: 'Ask with the whole amount. One firm rate comes back for all of it when a trader can fill it; when none can, you are told plainly rather than given part of a price.',
    },
    {
      question: 'Can my team trade on one account?',
      answer: 'Yes. Invite the people you trade with, and choose who may accept a price.',
    },
  ],
};

/**
 * The fear behind most first deals in India: a bank account frozen after a P2P sale. Told as the mechanism that causes it
 * (rupees that are someone else's money) and the rule that shuts it out here (ADR 0019 own-account payments, ADR 0030 the
 * payer check), with no promise about what a bank does.
 */
const BANK_FREEZE: SitePage = {
  path: '/p2p-bank-account-freeze',
  title: `Bank account frozen after P2P? How to avoid it | ${SITE_NAME}`,
  description:
    'Why bank accounts in India get frozen after P2P USDT deals, and how INRP2P refuses third-party rupees so the money you receive comes only from the buyer’s own account.',
  h1: 'Bank account frozen after a P2P deal?',
  lede: 'Most freezes start with rupees from someone you never dealt with. On INRP2P those rupees are refused and sent back.',
  sections: [
    {
      heading: 'Why P2P sellers get frozen',
      body: [
        'In a chat deal the rupees can come from anyone. Sometimes they are someone else’s money: a person who was cheated, paying through an account rented for the purpose.',
        'When that person complains, the complaint follows the money to every account it reached, and yours is frozen with it. Often the seller’s only mistake was taking rupees from an account that was not the buyer’s own.',
      ],
    },
    {
      heading: 'Only the buyer’s own account can pay you',
      body: [
        'On INRP2P the rupees must come from the bank account the buyer added before the deal, in their own name. Rupees from any other account or name are refused and sent back.',
        'Your USDT stays in escrow meanwhile. The deal goes on only with rupees from the right account, or unwinds when its time runs out.',
      ],
    },
    {
      heading: 'Traders checked before their first deal',
      body: ['Every trader on INRP2P is reviewed before their first deal and pays only from accounts registered in advance. Nobody turns up halfway with a new account.'],
    },
    {
      heading: 'A record of every deal, ready to show',
      body: [
        'Every deal keeps its rate, both sides’ accounts, the payment references and a receipt, as a document, CSV and JSON.',
        'If your bank ever asks where a payment came from, you show the deal’s whole record, not a chat and a few screenshots.',
      ],
    },
    {
      heading: 'Habits that keep your account clean',
      body: [
        'Take rupees only from the account named on the deal. Never accept a friend’s or a company’s account in its place, whatever the story.',
        'Keep your trading to one bank account, keep every receipt, and never move a deal to a private chat to save time.',
      ],
    },
  ],
  priority: 0.8,
  led: 'CLEAN ₹',
  faq: [
    {
      question: 'Why do banks freeze accounts after P2P crypto deals?',
      answer: 'Usually because the rupees received were traced to a fraud complaint: someone else’s money, passed on through the buyer. The account it landed in is frozen with it, even when its owner knew nothing.',
    },
    {
      question: 'Can INRP2P promise my account will never be frozen?',
      answer: 'Nobody can promise what a bank will do. INRP2P shuts the most common way in: rupees from anyone but the buyer’s own account are refused and sent back, and every deal leaves a full record.',
    },
    {
      question: 'What happens if a buyer pays from someone else’s account?',
      answer: 'The payment is refused and sent back, and your USDT stays in escrow. The deal waits for rupees from the buyer’s own account, or unwinds when its time runs out.',
    },
    {
      question: 'Is selling USDT through escrow safer than in a chat?',
      answer: 'On both sides of the risk. Your USDT is never sent to a person on trust, and the rupees can come only from the buyer’s own registered account.',
    },
  ],
};

/** The scams people search for by name before a first P2P deal, each answered by the step of the deal that stops it. */
const SCAMS: SitePage = {
  path: '/usdt-p2p-scams',
  title: `USDT P2P scams in India and how to avoid them | ${SITE_NAME}`,
  description:
    'The USDT P2P scams people in India meet most — “send first”, fake payment screenshots, third-party rupees, a rate that changes, silence — and how escrow takes each one apart.',
  h1: 'USDT P2P scams in India',
  lede: 'Every one of them needs you to trust a stranger for a moment. Escrow takes that moment away.',
  sections: [
    {
      heading: '“Send first, I pay right after”',
      body: [
        'The oldest one. Once your USDT has left your wallet, nothing makes the other side pay.',
        'On INRP2P nobody sends to a person. The USDT goes into an escrow address made for the deal, and only INRP2P can release it.',
      ],
    },
    {
      heading: 'The fake payment screenshot',
      body: [
        'An edited screenshot, a fake bank message, a “pending” transfer that never lands.',
        'Here the USDT is released only when the seller sees the rupees in their own bank account. A screenshot changes nothing.',
      ],
    },
    {
      heading: 'Rupees from someone else',
      body: [
        'The buyer pays with another person’s money: the victim of a different fraud, or an account rented for the job. Weeks later the complaint reaches your bank.',
        'On INRP2P rupees from anyone but the buyer’s own account are refused and sent back.',
      ],
    },
    {
      heading: '“Rate changed, send a bit more”',
      body: ['The price moves in the middle of the deal, and so does the ask. Here one firm rate is fixed for the whole amount the moment you accept, and nobody can change it after.'],
    },
    {
      heading: 'A new address, just this once',
      body: [
        'A message asking you to send to a different address, or on a different network. A TRON transfer cannot be recalled once it is final.',
        'Here you send only to the escrow address shown on your deal, and the USDT you buy goes only to the wallet you added before your first deal.',
      ],
    },
    {
      heading: 'The one who goes quiet',
      body: ['Halfway through, the other side stops answering and your money waits with them. Here every step has a time limit: miss it and the deal unwinds, and the USDT goes back where it came from.'],
    },
  ],
  priority: 0.7,
  led: 'NO SCAMS',
  faq: [
    {
      question: 'What is the most common USDT P2P scam in India?',
      answer: 'Being asked to send first, then paid with a fake screenshot or not at all. Escrow removes it: nobody sends to a person, and nothing is released before the rupees are in the seller’s own bank account.',
    },
    {
      question: 'Is P2P crypto trading safe in India?',
      answer: 'As safe as the deal’s weakest step. Trade with escrow, take rupees only from the other side’s own account, release only on money in your bank, and keep every deal’s record.',
    },
    {
      question: 'Someone wants to finish the deal on WhatsApp. Should I?',
      answer: 'No. Outside the deal there is no escrow, no time limit and no record. On INRP2P the chat, the payments and the release all happen inside the deal.',
    },
  ],
};

/** The question a person asks before a first deal with a name they have just heard of — answered with the mechanism. */
const IS_IT_SAFE: SitePage = {
  path: '/is-inrp2p-safe',
  title: `Is INRP2P safe? How your USDT is protected | ${SITE_NAME}`,
  description:
    'What INRP2P does with your USDT and rupees on every deal: an escrow address per deal, rupees bank to bank between own accounts, reviewed traders, time limits and disputes.',
  h1: 'Is INRP2P safe?',
  lede: 'Judge it by what happens to your money on a deal. Here is all of it, step by step.',
  sections: [
    {
      heading: 'Your USDT waits in escrow, not with a person',
      body: [
        'Each deal gets its own escrow address on TRON. Only INRP2P can move what is in it, and only where the deal says: to the buyer once the seller confirms the rupees, or back where it came from if the deal unwinds.',
        'An escrow is an address on the chain, so what is in it can be looked up on any TRON explorer.',
      ],
    },
    {
      heading: 'Your rupees never pass through INRP2P',
      body: ['They go bank to bank, by UPI, IMPS, NEFT or RTGS, between your own account and the other side’s own account. Rupees from anyone else are refused and sent back.'],
    },
    {
      heading: 'Every trader is reviewed',
      body: ['A trader is reviewed by INRP2P before their first deal and pays only from accounts registered in advance.'],
    },
    {
      heading: 'When something goes wrong',
      body: [
        'Every step has a time limit, and a deal nobody finishes unwinds. The price cannot change once you accept it.',
        'If the two sides disagree, open a dispute on the deal: INRP2P decides it on the bank’s evidence.',
      ],
    },
    {
      heading: 'People you can reach',
      body: ['INRP2P posts its news on its official Telegram channel, and its CEO answers on Telegram in person. Both are at the foot of every page.'],
    },
  ],
  priority: 0.6,
  led: 'SAFE',
  faq: [
    {
      question: 'Is INRP2P legit?',
      answer: 'Judge it by the mechanism. You never send USDT to a person, you never pay a stranger before the USDT is locked, and every deal ends with a receipt. Start with a small deal and watch each step yourself.',
    },
    {
      question: 'Who holds my USDT during a deal?',
      answer: 'The deal’s own escrow address. It releases only where the deal says: to the buyer once the seller confirms the rupees, or back where it came from.',
    },
    {
      question: 'Who do I talk to if something goes wrong?',
      answer: 'Open a dispute on the deal itself. For anything else, the CEO answers on Telegram.',
    },
  ],
};

/**
 * The trader's door from search: people looking to earn on USDT as a P2P merchant. Money first (TRADER_TERMS, filled in
 * by `withTerms`), then what stops costing them and the exchange they get; its actions open an exchange, not a deal.
 */
const MERCHANT: SitePage = {
  path: '/p2p-merchant-india',
  title: `Become a USDT P2P merchant in India — earn {margin} | ${SITE_NAME}`,
  description:
    'Run your own USDT exchange in India on INRP2P: your page, your clients and prices that follow the market, at the margin you set. INRP2P takes {fee} of a deal.',
  h1: 'Become a USDT P2P merchant in India',
  lede: 'Your own exchange, ready once INRP2P approves you. Keep your margin; INRP2P takes {fee} of a deal and holds the escrow on every one.',
  sections: [
    {
      heading: 'Where the margin comes from',
      body: [
        'Buyers in India pay over the market for USDT, and sellers want rupees without the risk. A merchant with good prices stands in the middle and keeps the difference.',
        'Traders in India commonly work at {margin} over the market. You set yours, and your prices can follow the market by themselves.',
      ],
    },
    {
      heading: 'What INRP2P takes, and what it does',
      body: [
        '{fee} of each deal your own exchange fills. The rest of your margin is yours.',
        'For that, every deal runs through INRP2P’s escrow, every client pays from their own account, and every deal is recorded with its receipt.',
      ],
    },
    {
      heading: 'What you stop paying for',
      body: [
        'Frozen accounts from third-party rupees: here they are refused and sent back. Fake screenshots: you release only on rupees in your bank.',
        'Posting rates all day: set your margin once. Clients who go quiet: every step has a time limit, and an unfinished deal unwinds.',
      ],
    },
    {
      heading: 'Your exchange, already built',
      body: ['Your page at your own address on INRP2P, deal links you send on WhatsApp or Telegram, prices with your limits, a team with roles, and Telegram alerts when it is your move.'],
    },
    {
      heading: 'Three steps to start',
      body: ['Apply with your email: who you are and what you can provide. Set your prices. Then share your page or a deal link with your clients.'],
    },
  ],
  priority: 0.8,
  led: 'EARN',
  audience: 'trader',
  faq: [
    {
      question: 'How much can a USDT P2P merchant earn in India?',
      answer: 'It depends on your USDT, how often it turns over and your margin. Traders in India commonly work at {margin} over the market; the home page has an example you can set to your own figures.',
    },
    {
      question: 'What does INRP2P charge a merchant?',
      answer: '{fee} of each deal your own exchange fills, with the escrow on every one. Your margin over the market is yours.',
    },
    {
      question: 'Do I need my own website or app?',
      answer: 'No. Your page, your prices, deal links, a team and Telegram alerts come with your exchange on INRP2P.',
    },
    {
      question: 'Who can become a merchant?',
      answer: 'A trader or broker with USDT to sell and a bank account in their own name. INRP2P reviews every trader before a first deal.',
    },
  ],
};

/** The guides' own section words. */
export const GUIDES = {
  rate: { title: 'USDT/INR market rate now', sell: 'You sell', buy: 'You buy', note: 'The market’s rate. Your firm price comes with your quote.' },
  /** The line under a rate guide's lede: the market's rate as the page was opened, in its HTML. */
  now: { label: 'Market rate now', SELL_USDT: 'per USDT when you sell', BUY_USDT: 'per USDT when you buy', at: 'Read at' },
  /** A rate guide's table of common amounts at the market's rate. */
  table: {
    SELL_USDT: { title: 'USDT to INR at the market rate now', from: 'You sell', to: 'You receive about' },
    BUY_USDT: { title: 'INR to USDT at the market rate now', from: 'You pay', to: 'You receive about' },
    note: 'At the market’s rate when this page was opened. Your firm price, for your whole amount, comes with your quote, with the network fee on its own line.',
  },
  /** A trader's guide: the way to the earnings example on the home page, and what applying takes. */
  trader: { earn: 'See what your USDT earns', note: 'Apply with your email. INRP2P reviews every trader before a first deal.' },
  faq: 'Questions people ask',
  more: 'More guides',
} as const;

/**
 * The amounts a rate guide's table converts at the market's rate: USDT when selling, rupees when buying — the amounts
 * people search for ("100 USDT to INR"). Amounts of the example, not of anybody's deals; the rupees beside them are the
 * market's reference at the moment the page was opened.
 */
export const RATE_TABLE: Readonly<Record<Direction, readonly number[]>> = {
  SELL_USDT: [1, 10, 50, 100, 500, 1_000, 5_000, 10_000],
  BUY_USDT: [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 500_000, 1_000_000],
};

/**
 * The public site's routes, in sitemap order: PRODUCT §7.4's six, then the guides written for what people in India search
 * before a deal — a frozen account, the scams, whether INRP2P is safe — and the trader's way in. Nothing else is published
 * on the public host.
 */
export const SITE_PAGES: readonly SitePage[] = [
  HOME,
  USDT_TO_INR,
  INR_TO_USDT,
  SELL_IN_INDIA,
  BUY_IN_INDIA,
  BANK_FREEZE,
  SCAMS,
  IS_IT_SAFE,
  OTC_INDIA,
  MERCHANT,
];

export const SITE_PATHS: readonly string[] = SITE_PAGES.map((p) => p.path);

export const pageForPath = (path: string): SitePage | undefined => SITE_PAGES.find((p) => p.path === path);

/** The footer's one honest sentence about what this site is and is not. */
export const FOOTER_NOTE =
  'INRP2P Exchange holds the USDT in escrow on every deal between its clients and reviewed traders. Nothing on this site is an offer, a price or advice: the rates shown here are the market’s, and a price exists only in a quote issued for a specific deal.';
