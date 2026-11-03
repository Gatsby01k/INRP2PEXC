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
  { label: 'Request OTC quote', kind: 'secondary', appPath: '/exchange' },
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
  /** The deal card floating beside the robot: the escrow's moments, ticked off in the order a deal reaches them. */
  readonly deal: { readonly title: string; readonly status: string; readonly steps: readonly { readonly icon: HeroPointIcon; readonly text: string }[] };
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
  eyebrow: 'USDT and INR, with escrow',
  headline: { lead: 'Buy & Sell', accent: 'USDT', tail: 'in India.' },
  lede: 'One firm rate for the whole amount. Rupees go bank to bank, and the USDT waits in escrow until they arrive.',
  points: [
    { icon: 'destination', label: 'Escrow on every deal' },
    { icon: 'lock', label: 'Rate locked on accept' },
    { icon: 'rupee', label: 'UPI, IMPS, NEFT, RTGS' },
    { icon: 'dealer', label: 'Reviewed traders only' },
  ],
  deal: {
    title: 'Your deal',
    status: 'Completed',
    steps: [
      { icon: 'lock', text: 'USDT locked in escrow' },
      { icon: 'rupee', text: 'Rupees received' },
      { icon: 'destination', text: 'USDT released' },
    ],
  },
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
 * The home page's "how it works": the stations every deal passes, in the order it passes them (ADR 0019).
 *
 * Both directions run through the same five stations; the ends swap, and so does who funds the escrow and who pays
 * the rupees. Every station says what happens there and what the deal holds once it is past — a mechanism, never a
 * duration.
 * The ticket that travels the rail fills in as it goes; a rate or an expiry is drawn masked, because a real one
 * exists only inside a quote issued to a client.
 */
export const FLOW_STATIONS = ['source', 'quote', 'execution', 'settlement', 'destination'] as const;
export type FlowStation = (typeof FLOW_STATIONS)[number];

/** A figure that belongs to a real trade, shown only as its shape. */
export type MaskedValue = 'rate' | 'time' | 'amount';

export interface FlowStationCopy {
  readonly key: FlowStation;
  /** The station's name on the rail. At the ends it is the currency, which depends on the direction. */
  readonly name: Record<Direction, string>;
  readonly title: Record<Direction, string>;
  readonly body: Record<Direction, string>;
  /** What the trade holds once it has passed this station. */
  readonly record: Record<Direction, string>;
}

export interface FlowCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  /** The switch that shows the other direction. Its options are named for the accessible name; arrows are drawn. */
  readonly direction: { readonly label: string; readonly options: Record<Direction, string> };
  readonly stations: readonly FlowStationCopy[];
  readonly ticket: {
    /** The trade's status as the ticket leaves each station, in station order. */
    readonly status: Record<FlowStation, string>;
    readonly rows: readonly {
      readonly label: string;
      /** Written words, or the shape of a figure that only a real trade has. */
      readonly value: string | { readonly mask: MaskedValue };
      /** The station after which the row is filled in. */
      readonly at: FlowStation;
    }[];
  };
}

export const FLOW: FlowCopy = {
  eyebrow: 'How it works',
  heading: 'The USDT waits in escrow until the rupees land.',
  lede: 'The same five steps whichever way you trade. Switch direction to follow your money.',
  direction: { label: 'Direction shown', options: { BUY_USDT: 'INR to USDT', SELL_USDT: 'USDT to INR' } },
  stations: [
    {
      key: 'source',
      name: { BUY_USDT: 'INR', SELL_USDT: 'USDT' },
      title: both('Name your amount'),
      body: {
        BUY_USDT: 'The USDT you want, or the rupees you will spend. Nothing moves yet.',
        SELL_USDT: 'The USDT you will sell, or the rupees you need. Nothing moves yet.',
      },
      record: both('Request'),
    },
    {
      key: 'quote',
      name: both('Price'),
      title: both('One firm rate'),
      body: both('For the whole amount, with its expiry on it. Accept it and it is locked.'),
      record: both('Firm rate · expiry'),
    },
    {
      key: 'execution',
      name: both('Escrow'),
      title: { BUY_USDT: 'USDT locked first', SELL_USDT: 'USDT into escrow' },
      body: {
        BUY_USDT: 'The trader puts the USDT into this deal’s own escrow address before you pay a rupee.',
        SELL_USDT: 'You send the USDT to this deal’s own escrow address. Only INRP2P can release it.',
      },
      record: both('USDT in escrow'),
    },
    {
      key: 'settlement',
      name: both('Rupees'),
      title: { BUY_USDT: 'You pay the trader', SELL_USDT: 'The trader pays you' },
      body: {
        BUY_USDT: 'Straight from your bank account to theirs, by UPI, IMPS, NEFT or RTGS.',
        SELL_USDT: 'Straight to your bank account. You check the money arrived, and who sent it.',
      },
      record: both('Bank reference'),
    },
    {
      key: 'destination',
      name: { BUY_USDT: 'USDT', SELL_USDT: 'INR' },
      title: { BUY_USDT: 'USDT in your wallet', SELL_USDT: 'Rupees in your bank' },
      body: {
        BUY_USDT: 'The trader confirms your rupees, and the escrow pays the USDT to your wallet.',
        SELL_USDT: 'You confirm they arrived. Only then is the USDT released to the trader.',
      },
      record: both('Receipt'),
    },
  ],
  ticket: {
    status: { source: 'Request', quote: 'Quoted', execution: 'In escrow', settlement: 'Paying', destination: 'Completed' },
    rows: [
      { label: 'Rate', value: { mask: 'rate' }, at: 'quote' },
      { label: 'Expires', value: { mask: 'time' }, at: 'quote' },
      { label: 'Escrow', value: 'Locked', at: 'execution' },
      { label: 'Rupees', value: 'Received', at: 'settlement' },
      { label: 'USDT', value: 'Released', at: 'destination' },
      { label: 'Receipt', value: 'Issued', at: 'destination' },
    ],
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
    readonly chat: { readonly title: string; readonly messages: readonly { readonly from: 'them' | 'you' | 'system'; readonly text: string }[] };
    readonly ours: { readonly title: string; readonly card: string; readonly status: string; readonly steps: readonly string[] };
  };
  /** The table's caption, for whoever reads it without seeing it. */
  readonly caption: string;
  readonly columns: { readonly topic: string; readonly direct: string; readonly ours: string };
  readonly rows: readonly { readonly topic: string; readonly direct: string; readonly ours: string }[];
}

export const WHY: WhyCopy = {
  eyebrow: 'Why INRP2P',
  heading: 'Everything that goes wrong in a P2P deal, handled.',
  lede: 'The same deal, done two ways: with someone you found in a chat, and on INRP2P.',
  scene: {
    chat: {
      title: 'Deal in a chat',
      messages: [
        { from: 'them', text: 'Send the USDT first, I pay right after' },
        { from: 'you', text: 'Sent. Waiting for the rupees' },
        { from: 'them', text: 'Rate moved. Send a bit more' },
        { from: 'you', text: 'Hello?' },
        { from: 'system', text: 'This person left the chat' },
      ],
    },
    ours: {
      title: 'Deal on INRP2P',
      card: 'Your deal',
      status: 'Completed',
      steps: ['Rate locked for the whole amount', 'USDT locked in escrow', 'Rupees received, sender checked', 'USDT released', 'Receipt issued'],
    },
  },
  caption: 'A deal in a chat compared with a deal on INRP2P',
  columns: { topic: 'In the deal', direct: 'Deal in a chat', ours: 'Deal on INRP2P' },
  rows: [
    {
      topic: 'Who sends first',
      direct: 'One of you, on trust.',
      ours: 'Nobody on trust. The USDT waits in escrow, and whoever’s money is at risk goes second.',
    },
    {
      topic: 'The price',
      direct: 'Agreed in chat, then changed at the last minute.',
      ours: 'One firm rate for the whole amount, locked the moment you accept.',
    },
    {
      topic: 'The other side',
      direct: 'Whoever answered first.',
      ours: 'A trader INRP2P reviewed before their first deal.',
    },
    {
      topic: 'Where the rupees come from',
      direct: 'Any account, in anyone’s name.',
      ours: 'Only the other side’s own bank account. Rupees from anyone else are refused and sent back.',
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
  lede: 'What people ask before they trade here, answered plainly.',
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
      answer: 'It is in the rate. The amount on your quote is the amount you get, with the network fee already inside it. If a sale is cancelled after you send USDT, it comes back less its own network fee, shown on the deal before you send.',
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
      question: 'Can I run my own exchange on INRP2P?',
      answer: 'Yes. Traders and brokers get their own page, deal links, prices, team and Telegram alerts, with INRP2P’s escrow on every deal.',
      more: { label: 'See the desk programme', anchor: 'own-desk' },
    },
  ],
  ask: { title: 'Something else?', body: 'Message our CEO on Telegram. A person answers.' },
};

/**
 * A trader's own exchange on INRP2P (ADR 0020): the desk programme, told to the traders and brokers who would run
 * one. Every sentence describes something the workspace does today — the page, deal links, escrow, prices, the team,
 * Telegram alerts — and the mock-ups beside them draw their figures masked, like the rest of the site.
 */
export const OWN_DESK_FEATURES = ['page', 'link', 'escrow', 'prices', 'team', 'alerts'] as const;
export type OwnDeskFeature = (typeof OWN_DESK_FEATURES)[number];

export interface OwnDeskCopy {
  readonly nav: string;
  readonly announce: { readonly tag: string; readonly text: string };
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly features: readonly { readonly key: OwnDeskFeature; readonly title: string; readonly body: string }[];
  readonly mock: {
    readonly deskName: string;
    readonly handle: string;
    readonly taking: string;
    readonly sell: string;
    readonly buy: string;
    readonly perUsdt: string;
    readonly ask: string;
    readonly chat: string;
    readonly linkTitle: string;
    readonly linkMeta: string;
    readonly held: string;
    readonly take: string;
    readonly escrow: readonly string[];
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
  announce: { tag: 'New', text: 'Traders: open your own exchange on INRP2P' },
  eyebrow: 'For traders and brokers',
  heading: 'Your own exchange, on INRP2P.',
  lede: 'Your page, your prices, your clients, your team. Rupees go straight between you and your client, and INRP2P holds the USDT in escrow until they land.',
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
      key: 'escrow',
      title: 'Escrow on every deal.',
      body: 'Whoever sells puts the USDT into the deal’s own escrow address. It is released only after the rupees are confirmed, never before.',
    },
    {
      key: 'prices',
      title: 'Prices you control.',
      body: 'What you pay and what you ask, the smallest and largest deal, and how long they hold. They switch themselves off when their time runs out.',
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
    ask: 'Get a firm price',
    chat: 'Here is your deal — the price holds while you sign in.',
    linkTitle: 'A deal from Your desk',
    linkMeta: 'USDT at',
    held: 'Price held',
    take: 'Take this deal',
    escrow: ['USDT in escrow', 'Rupees confirmed', 'USDT released'],
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
  heading: 'Get a firm price on your next deal.',
  body: 'Add your bank account and wallet once. Every deal after that runs through escrow, at a rate you see before you agree.',
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
  title: 'Run an exchange or have liquidity?',
  body: 'Open your own exchange on INRP2P: your page, your prices, your clients, with escrow on every deal.',
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
  title: `Buy and sell USDT in India — ${SITE_NAME}`,
  description:
    'Buy and sell USDT for Indian rupees with escrow on every deal: one firm rate for the whole amount, rupees bank to bank, and USDT released only once they arrive.',
  h1: `${HERO.headline.lead} ${HERO.headline.accent} ${HERO.headline.tail}`,
  lede: TAGLINE,
  // The home page tells its story in its own sections (FLOW, OWN_DESK, WHY, FAQ, CLOSING), which say everything
  // the reading column once did: both directions, the escrow, and what happens when a deal goes wrong.
  sections: [],
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
        'An account, the people allowed to accept quotes on it, and at least one Indian bank account to be paid to. You open the account yourself, with your email.',
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
        'An account, the people allowed to accept quotes on it, and a wallet added before the trade. You open the account yourself, with your email.',
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
