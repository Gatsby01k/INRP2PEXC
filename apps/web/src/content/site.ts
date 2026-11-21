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
 * The board under the hero: the robot's LEDs running what every deal here does, after the market's rate. Each line is
 * a mechanism the product has (ADR 0019, ADR 0028, ADR 0030), said the way the people it protects would say it.
 */
export const BOARD = {
  tag: 'Live',
  lines: [
    'Nobody sends first',
    'Your USDT never sits with a stranger',
    'A screenshot is not money',
    'Third-party rupees go back',
    'Rupees never touch INRP2P',
    'Rate locked when you accept',
    'UPI · IMPS · NEFT · RTGS',
    'Every trader reviewed',
  ],
} as const;

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
      question: 'Can I run my own exchange on INRP2P?',
      answer: 'Yes. Traders and brokers get their own page, deal links, prices, team and Telegram alerts, with INRP2P’s escrow on every deal.',
      more: { label: 'See the desk programme', anchor: 'own-desk' },
    },
  ],
  ask: { title: 'Something else?', body: 'Ask the robot’s boss. Our CEO answers on Telegram, in person.' },
};

/**
 * A trader's own exchange on INRP2P (ADR 0020): the desk programme, told to the traders and brokers who would run
 * one. Every sentence describes something the workspace does today — the page, deal links, escrow, prices, the team,
 * Telegram alerts — and the mock-ups beside them draw their figures masked, like the rest of the site.
 */
export const OWN_DESK_FEATURES = ['page', 'link', 'prices', 'team', 'alerts'] as const;
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
  announce: { tag: 'New', text: 'Traders: open your own exchange on INRP2P' },
  eyebrow: 'For traders and brokers',
  heading: 'Run your own exchange. Skip building one.',
  lede: 'Stop posting rates in Telegram groups. Get your own page, prices that follow the market, a deal link for every client and a team, with INRP2P’s escrow on every deal.',
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
  title: `USDT to INR — sell Tether for Indian rupees | ${SITE_NAME}`,
  description:
    'Sell USDT for INR with escrow on every deal: one firm rate for the whole amount, your USDT held in escrow, and rupees paid straight to your own bank account.',
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
};

const INR_TO_USDT: SitePage = {
  path: '/inr-to-usdt',
  title: `INR to USDT — buy Tether with Indian rupees | ${SITE_NAME}`,
  description:
    'Buy USDT with INR with escrow on every deal: one firm rate, the USDT locked in escrow before you pay, and USDT delivered to your own TRON wallet.',
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
};

const SELL_IN_INDIA: SitePage = {
  path: '/sell-usdt-in-india',
  title: `Sell USDT in India — escrow on every deal | ${SITE_NAME}`,
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
};

const BUY_IN_INDIA: SitePage = {
  path: '/buy-usdt-in-india',
  title: `Buy USDT in India — escrow on every deal | ${SITE_NAME}`,
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
};

const OTC_INDIA: SitePage = {
  path: '/usdt-otc-india',
  title: `USDT OTC in India — large deals with escrow | ${SITE_NAME}`,
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
};

/** The six routes of PRODUCT §7.4, in sitemap order. Nothing else is published on the public host. */
export const SITE_PAGES: readonly SitePage[] = [HOME, USDT_TO_INR, INR_TO_USDT, SELL_IN_INDIA, BUY_IN_INDIA, OTC_INDIA];

export const SITE_PATHS: readonly string[] = SITE_PAGES.map((p) => p.path);

export const pageForPath = (path: string): SitePage | undefined => SITE_PAGES.find((p) => p.path === path);

/** The footer's one honest sentence about what this site is and is not. */
export const FOOTER_NOTE =
  'INRP2P Exchange holds the USDT in escrow on every deal between its clients and reviewed traders. Nothing on this site is an offer, a price or advice: the rates shown here are the market’s, and a price exists only in a quote issued for a specific deal.';
