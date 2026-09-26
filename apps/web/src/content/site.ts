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

/**
 * Everything the robot ever says: the visitor's first move, a request received, and a problem worth a second
 * look. Changing an amount or a direction is shown, never spoken — rarity is what keeps a voice worth hearing.
 */
export const VOICE_LINES = ['ready', 'received', 'check'] as const;
export type VoiceLine = (typeof VOICE_LINES)[number];

/**
 * The robot's voice: three short, recorded lines, each said only after something the visitor did.
 * `lines` are the words of the recordings (`voice/clips`), spoken, not shown; `control` names the button that
 * mutes them, `on` and `off` describe its state.
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
  /** Shown under the amount when "Request quote" is pressed without one; the visitor stays on the page. */
  readonly amountRequired: string;
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
    amountRequired: 'Enter an amount to request a quote.',
    note: 'Sent from your client account. New clients are onboarded by the desk first.',
  },
  voice: {
    control: 'Voice',
    on: 'Voice cues are on. Press to mute them.',
    off: 'Voice cues are off. Press to turn them on.',
    lines: {
      ready: 'Ready when you are.',
      received: 'Request received.',
      check: "Let's check that.",
    },
  },
};

/** Words that are the same in both directions, written once. */
const both = (text: string): Record<Direction, string> => ({ SELL_USDT: text, BUY_USDT: text });

/**
 * The home page's execution flow: the stations every trade passes, in the order it passes them.
 *
 * Both directions run through the same five stations; the ends swap and the settlement changes hands. Every
 * station says what happens there and what the trade holds once it is past — a mechanism, never a duration.
 * The ticket that travels the rail fills in as it goes; a rate or an expiry is drawn masked, because a real one
 * exists only inside a quote issued to a client.
 */
export const FLOW_STATIONS = ['source', 'quote', 'execution', 'settlement', 'destination'] as const;
export type FlowStation = (typeof FLOW_STATIONS)[number];

/** A figure that belongs to a real trade, shown only as its shape. */
export type MaskedValue = 'rate' | 'time' | 'amount' | 'account' | 'wallet' | 'hash' | 'reference';

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
  eyebrow: 'Execution flow',
  heading: 'The price is fixed before any money moves.',
  lede: 'Both directions run through the same stations. A dealer prices the whole trade, you accept while the price is firm, your side arrives and is confirmed — and only then is the other side paid, to a destination registered before the trade began.',
  direction: { label: 'Direction shown', options: { BUY_USDT: 'INR to USDT', SELL_USDT: 'USDT to INR' } },
  stations: [
    {
      key: 'source',
      name: { BUY_USDT: 'INR', SELL_USDT: 'USDT' },
      title: { BUY_USDT: 'Your rupees', SELL_USDT: 'Your USDT' },
      body: {
        BUY_USDT: 'Fix the rupees you will spend or the USDT you want to end with. Nothing is sent yet.',
        SELL_USDT: 'Fix the USDT you will sell or the rupees you need to receive. Nothing is sent yet.',
      },
      record: both('Request: direction, amount, destination'),
    },
    {
      key: 'quote',
      name: both('Quote'),
      title: both('Priced by a dealer'),
      body: both('One rate for the whole amount rather than fills from a book, with the moment it expires written on it.'),
      record: both('Firm rate · expiry'),
    },
    {
      key: 'execution',
      name: both('Execution'),
      title: both('Accepted while firm'),
      body: {
        BUY_USDT: 'A code sent to someone authorised to decide confirms it. Rate, amounts and destination are frozen, and the trade names the account to pay.',
        SELL_USDT: 'A code sent to someone authorised to decide confirms it. Rate, amounts and destination are frozen, and the trade gets a deposit address of its own.',
      },
      record: both('Frozen terms'),
    },
    {
      key: 'settlement',
      name: both('Settlement'),
      title: both('Your side, then ours'),
      body: {
        BUY_USDT: 'Your INR is matched to the trade by its reference and confirmed against the bank’s record. Only then is the USDT sent.',
        SELL_USDT: 'Your USDT counts once the TRON block that carries it is final. Only then is the INR paid.',
      },
      record: { BUY_USDT: 'Bank reference · transaction hash', SELL_USDT: 'Transaction hash · bank references' },
    },
    {
      key: 'destination',
      name: { BUY_USDT: 'USDT', SELL_USDT: 'INR' },
      title: { BUY_USDT: 'Your registered wallet', SELL_USDT: 'Your registered bank account' },
      body: {
        BUY_USDT: 'Delivered on TRC20 to the wallet registered before the trade, and to no other address.',
        SELL_USDT: 'Paid to the account registered before the trade, in one transfer or several, each with its own bank reference.',
      },
      record: both('Settlement receipt'),
    },
  ],
  ticket: {
    status: { source: 'Request', quote: 'Quoted', execution: 'Accepted', settlement: 'Settling', destination: 'Completed' },
    rows: [
      { label: 'Rate', value: { mask: 'rate' }, at: 'quote' },
      { label: 'Expires', value: { mask: 'time' }, at: 'quote' },
      { label: 'Terms', value: 'Frozen', at: 'execution' },
      { label: 'Your side', value: 'Confirmed', at: 'settlement' },
      { label: 'Paid to you', value: 'Confirmed', at: 'destination' },
      { label: 'Receipt', value: 'Issued', at: 'destination' },
    ],
  },
};

/**
 * The home page's operational controls, and the trade record they are drawn against.
 *
 * Each control is something the software does on every trade — not a policy, not a promise — and each one
 * governs particular lines of the record: `regions` on a line names the controls that put it there. The record
 * is a specimen of the record's shape, with every figure masked; its words are the product's own.
 */
export const TRUST_CONTROLS = ['destinations', 'evidence', 'settlement', 'reconciliation', 'desk'] as const;
export type TrustControl = (typeof TRUST_CONTROLS)[number];

export interface TrustControlCopy {
  readonly key: TrustControl;
  readonly label: string;
  readonly title: string;
  readonly body: string;
}

export interface RecordLine {
  readonly label: string;
  readonly value: string | { readonly mask: MaskedValue; readonly unit?: string };
  /** A state the line has reached, shown as a status mark. */
  readonly state?: string;
  readonly regions: readonly TrustControl[];
}

/** A group of lines under a heading, or the rule between the client's side and the payout. */
export type RecordBlock =
  | { readonly kind: 'lines'; readonly heading: string; readonly lines: readonly RecordLine[] }
  | { readonly kind: 'gate'; readonly text: string; readonly regions: readonly TrustControl[] };

export interface TrustCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly controls: readonly TrustControlCopy[];
  readonly record: {
    readonly title: string;
    readonly status: string;
    readonly summary: Record<Direction, string>;
    readonly blocks: Record<Direction, readonly RecordBlock[]>;
    /** The record's last line: open cases and the receipt, side by side. */
    readonly footer: readonly RecordLine[];
  };
}

const TERMS_HEADING = 'Terms · frozen at acceptance';
const DESTINATION_HEADING = 'Destination · registered before the trade';
const GATE: RecordBlock = { kind: 'gate', text: 'Payout released only after your side is confirmed', regions: ['settlement'] };
const PRICED_BY: RecordLine = { label: 'Priced by', value: 'A dealer, for this trade', regions: ['desk'] };
const RATE: RecordLine = { label: 'Rate', value: { mask: 'rate', unit: 'INR per USDT' }, regions: [] };
const CONFIRMED_BY: RecordLine = { label: 'Confirmed by', value: 'The desk, with a second factor', regions: ['desk', 'settlement'] };
const TOTAL: RecordLine = { label: 'Total paid', value: 'Equals the agreed amount', state: 'Matched', regions: ['reconciliation'] };

export const TRUST: TrustCopy = {
  eyebrow: 'Operational controls',
  heading: 'Built to be checked, not taken on trust.',
  lede: 'A large trade should not rest on anyone’s word. Each control below is part of how every trade settles, and each one leaves a line in the trade’s record.',
  controls: [
    {
      key: 'destinations',
      label: 'Destinations',
      title: 'Money goes only where you registered it.',
      body: 'Bank accounts and wallets are added before a trade, never typed during one. Each addition needs a second factor and is announced to you. Nothing is edited in place: a change is a new registration, so the destination a trade agreed to cannot quietly move.',
    },
    {
      key: 'evidence',
      label: 'Evidence',
      title: 'Every payment carries its own reference.',
      body: 'A bank transfer is recorded with its UTR, a USDT transfer with its transaction hash. USDT is attributed only by the deposit address issued for that one trade — never by amount or sender — and one real transfer is recorded once.',
    },
    {
      key: 'settlement',
      label: 'Controlled settlement',
      title: 'Your side is final before ours is sent.',
      body: 'USDT counts once the TRON block that carries it is final, and larger transfers must be confirmed by independent sources. INR counts once it matches the bank’s record. Only then can a payout go out, and the desk confirms each one with a second factor.',
    },
    {
      key: 'reconciliation',
      label: 'Reconciliation',
      title: 'A trade closes only when the payments add up.',
      body: 'Every movement is posted once to a double-entry ledger that is added to and never edited. A trade completes only when confirmed payments equal what was agreed. A correction is written as a correction, and needs a second person’s approval.',
    },
    {
      key: 'desk',
      label: 'The desk',
      title: 'A person on every trade, and on every exception.',
      body: 'A dealer prices each trade and an operator confirms each payout. Anything that does not match — a different amount, an unexpected sender, a failed transfer — opens a case and holds the trade until a person resolves it, with the decision recorded.',
    },
  ],
  record: {
    title: 'Trade record',
    status: 'Completed',
    summary: { SELL_USDT: 'Sell USDT · paid to a registered bank account', BUY_USDT: 'Buy USDT · delivered to a registered wallet' },
    blocks: {
      SELL_USDT: [
        {
          kind: 'lines',
          heading: TERMS_HEADING,
          lines: [PRICED_BY, RATE, { label: 'You sell', value: { mask: 'amount', unit: 'USDT' }, regions: [] }],
        },
        {
          kind: 'lines',
          heading: DESTINATION_HEADING,
          lines: [{ label: 'Bank account', value: { mask: 'account' }, state: 'Registered', regions: ['destinations'] }],
        },
        {
          kind: 'lines',
          heading: 'Your side · USDT on TRC20',
          lines: [
            { label: 'Sent to', value: 'The deposit address issued for this trade', regions: ['evidence'] },
            { label: 'Transaction', value: { mask: 'hash' }, state: 'Final on chain', regions: ['evidence', 'settlement'] },
          ],
        },
        GATE,
        {
          kind: 'lines',
          heading: 'Payout · INR',
          lines: [
            { label: 'Bank reference', value: { mask: 'reference' }, state: 'Confirmed', regions: ['evidence'] },
            { label: 'Bank reference', value: { mask: 'reference' }, state: 'Confirmed', regions: ['evidence'] },
            CONFIRMED_BY,
            TOTAL,
          ],
        },
      ],
      BUY_USDT: [
        {
          kind: 'lines',
          heading: TERMS_HEADING,
          lines: [PRICED_BY, RATE, { label: 'You buy', value: { mask: 'amount', unit: 'USDT' }, regions: [] }],
        },
        {
          kind: 'lines',
          heading: DESTINATION_HEADING,
          lines: [{ label: 'TRC20 wallet', value: { mask: 'wallet' }, state: 'Registered', regions: ['destinations'] }],
        },
        {
          kind: 'lines',
          heading: 'Your side · INR',
          lines: [
            { label: 'Paid to', value: 'The settlement account named on the trade', regions: ['evidence'] },
            { label: 'Bank reference', value: { mask: 'reference' }, state: 'Confirmed', regions: ['evidence', 'settlement'] },
          ],
        },
        GATE,
        {
          kind: 'lines',
          heading: 'Payout · USDT on TRC20',
          lines: [
            { label: 'Transaction', value: { mask: 'hash' }, state: 'Final on chain', regions: ['evidence'] },
            CONFIRMED_BY,
            TOTAL,
          ],
        },
      ],
    },
    footer: [
      { label: 'Open cases', value: 'None', regions: ['desk'] },
      { label: 'Receipt', value: 'Document · CSV · JSON', regions: ['reconciliation'] },
    ],
  },
};

/**
 * Who the desk is for: three kinds of counterparty, and the part of the product that answers to each.
 *
 * A description of fit, never of customers — nothing here says that anyone already trades here, or how many.
 */
export const AUDIENCE_GROUPS = ['traders', 'business', 'partners'] as const;
export type AudienceGroup = (typeof AUDIENCE_GROUPS)[number];

export interface AudienceCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly groups: readonly {
    readonly key: AudienceGroup;
    readonly name: string;
    /** Who they are, in their own terms. */
    readonly situation: string;
    /** What in the product fits them. Mechanism only. */
    readonly fit: string;
  }[];
}

export const AUDIENCE: AudienceCopy = {
  eyebrow: 'Who it’s for',
  heading: 'For trades too large to leave to a screen.',
  lede: 'Three kinds of counterparty come to a desk rather than a book. What they have in common is size: amounts where a price that moves while an order fills is expensive, and where the record has to hold up afterwards.',
  groups: [
    {
      key: 'traders',
      name: 'Active traders',
      situation: 'You trade size often, and decide on the move.',
      fit: 'A firm price reaches your phone as a private link, and the bank accounts and wallets you registered once are there to choose on every trade after.',
    },
    {
      key: 'business',
      name: 'Businesses & treasury teams',
      situation: 'Several people share one account, and the books have to close.',
      fit: 'One client record for the whole team, with each person holding only the permissions you give them.',
    },
    {
      key: 'partners',
      name: 'OTC & liquidity partners',
      situation: 'You fill other people’s size, or you supply it.',
      fit: 'Each trade is settled on its own, against its own agreed terms, and every movement between us is evidenced the same way as a client’s.',
    },
  ],
};

/**
 * The execution desk: the timeline one trade leaves behind, from the request to the receipt.
 *
 * Each entry is something that happens on every trade, told by who does it — the client, a dealer, an operator,
 * or the system's own checks — with the status the client sees once it has happened. An entry marked `branch` is
 * the way off the main path at that step, and where the trade goes instead. Times are drawn masked, like every
 * other figure on the page.
 */
export const DESK_STAGES = ['request', 'review', 'quote', 'settlement', 'complete'] as const;
export type DeskStage = (typeof DESK_STAGES)[number];

/** Who acted. `you` is the client; the other three are the desk. */
export type DeskActor = 'you' | 'dealer' | 'operator' | 'system';

export interface DeskEntry {
  readonly actor: DeskActor | Record<Direction, DeskActor>;
  readonly event: string | Record<Direction, string>;
  /** The status the client sees once this has happened. */
  readonly status?: string | Record<Direction, string>;
  readonly branch?: true;
}

export interface DeskCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  /** The timeline's accessible name, and the key to how its entries are drawn. */
  readonly timeline: string;
  readonly legend: { readonly you: string; readonly desk: string; readonly branch: string };
  /** Read before a status by assistive technology; drawn as a mark. */
  readonly statusLabel: string;
  readonly actors: Record<DeskActor, string>;
  readonly stages: readonly { readonly key: DeskStage; readonly name: string; readonly entries: readonly DeskEntry[] }[];
}

export const DESK: DeskCopy = {
  eyebrow: 'Execution desk',
  heading: 'From request to receipt, every step has an owner.',
  lede: 'This is the timeline a trade leaves behind: who acted at each step, and the status you saw once they had. The ways off the main path are on it too, and where each one leads.',
  timeline: 'The timeline of one trade',
  legend: { you: 'Your move', desk: 'The desk’s move', branch: 'Off the main path' },
  statusLabel: 'Status:',
  actors: { you: 'You', dealer: 'Dealer', operator: 'Operator', system: 'System' },
  stages: [
    {
      key: 'request',
      name: 'Request',
      entries: [
        { actor: 'you', event: 'Request sent: direction, amount, the side that is fixed, and a registered destination', status: 'Open' },
        { actor: 'system', event: 'Checked on arrival — your client record is active, the destination is yours, the amount is within the desk’s limit' },
      ],
    },
    {
      key: 'review',
      name: 'Desk review',
      entries: [
        { actor: 'dealer', event: 'Reviewed, and priced for this trade alone' },
        { actor: 'dealer', event: 'Or declined, with the reason written on it', status: 'Declined', branch: true },
      ],
    },
    {
      key: 'quote',
      name: 'Quote',
      entries: [
        { actor: 'dealer', event: 'Quote sent: one firm rate, and the moment it expires', status: 'Quoted' },
        { actor: 'you', event: 'Accepted with a code sent to your verified email; rate, amounts and destination are frozen', status: 'Accepted' },
        { actor: 'system', event: 'Expired or rejected instead: the request goes back to the desk to be priced again', branch: true },
      ],
    },
    {
      key: 'settlement',
      name: 'Settlement',
      entries: [
        {
          actor: 'you',
          event: { BUY_USDT: 'INR sent to the account the trade names, with its reference', SELL_USDT: 'USDT sent to the deposit address issued for this trade' },
          status: { BUY_USDT: 'Waiting for your INR', SELL_USDT: 'Waiting for your USDT' },
        },
        {
          actor: { BUY_USDT: 'operator', SELL_USDT: 'system' },
          event: { BUY_USDT: 'Your INR matched against the bank’s own record', SELL_USDT: 'Your USDT final on chain' },
          status: 'Funds confirmed',
        },
        {
          actor: 'operator',
          event: {
            BUY_USDT: 'USDT sent to your registered wallet, and confirmed with a second factor',
            SELL_USDT: 'INR paid to your registered account, each transfer confirmed with a second factor',
          },
          status: 'Paying out',
        },
        { actor: 'operator', event: 'Anything that does not match opens a case, and the trade holds until a person resolves it', status: 'On hold', branch: true },
      ],
    },
    {
      key: 'complete',
      name: 'Complete',
      entries: [{ actor: 'system', event: 'Confirmed payments equal the agreed amount, and the receipt is written', status: 'Completed' }],
    },
  ],
};

/**
 * Large-volume execution: what changes when the amount is large, for a business or a desk of its own.
 *
 * Four terms, each one a rule the software enforces on every trade rather than a service level.
 */
export interface BusinessCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly terms: readonly { readonly label: string; readonly title: string; readonly body: string }[];
}

export const BUSINESS: BusinessCopy = {
  eyebrow: 'Large-volume execution',
  heading: 'Large amounts, agreed as one trade.',
  lede: 'At size the questions change: whether the price holds for the whole amount, who is allowed to say yes, how a large payout arrives, and what you can show for it afterwards.',
  terms: [
    {
      label: 'Pricing',
      title: 'Name the rate you want.',
      body: 'Put a target rate on the request. The dealer quotes at it, counters at another, or declines and says why — for the full size, whichever it is.',
    },
    {
      label: 'Authority',
      title: 'Only the people you name can say yes.',
      body: 'Accepting a quote commits your organisation, so it takes a person your administrator has allowed to accept. Granting or removing that permission takes the administrator’s second factor, and is recorded.',
    },
    {
      label: 'Payout',
      title: 'A large payout, in parts you can follow.',
      body: 'INR may arrive as several transfers to your registered account. Each one appears on your trade as it is confirmed, with its own bank reference, so a large payout can be followed as it lands.',
    },
    {
      label: 'Records',
      title: 'A receipt your books can use.',
      body: 'Every completed trade leaves a receipt as a document, CSV and JSON. It is written once, when the trade completes, and is the same every time it is downloaded.',
    },
  ],
};

/**
 * The page's last word: one call to action, and the honest answer for someone who is not a client yet.
 *
 * A trade is requested from a client account, so the action leads there. A visitor without one is told what the
 * desk sets up before a first trade; the address to write to is configuration (server/site.ts `siteContacts`),
 * published only when it is set, never a placeholder.
 */
export const CLOSING = {
  heading: 'Ask for a firm price on your trade.',
  body: 'Requested from your client account, priced by a dealer, and firm until it expires.',
  cta: { label: 'Request a quote', appPath: '/exchange' },
  newClient: {
    title: 'New to the desk?',
    body: 'Before a first trade, the desk sets up your client record, the people who may accept quotes, and the bank accounts and wallets you settle to.',
    contact: 'Write to the desk',
  },
} as const;

/**
 * The footer's links, by what they are for. Every one leads somewhere that exists: a page, a section of the home
 * page, the client app, or an address that is configured. Nothing is linked that has not been written.
 */
export const FOOTER = {
  groups: { product: 'Product', pages: 'Guides', security: 'Security', contact: 'Contact' },
  links: {
    request: 'Request a quote',
    signIn: 'Client sign in',
    flow: 'How a trade runs',
    desk: 'Execution desk',
    controls: 'Operational controls',
    securityReport: 'Report a security issue',
    deskContact: 'Write to the desk',
  },
  /** Whose names these are. */
  marks: 'USDT is a token issued by Tether; TRON and TRC20 are names of the network it is sent on. Neither is affiliated with this desk.',
} as const;

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
  // The home page tells its story in its own sections (FLOW, TRUST, AUDIENCE, DESK, BUSINESS, CLOSING), which
  // say everything the reading column once did: a desk rather than a book, both directions, and the receipt.
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
