/**
 * The trader acquisition page's words: `inrp2p.com/traders`, the one page every trader campaign links to.
 *
 * Written for a stranger who has never heard of INRP2P and arrived from a Telegram post or a LinkedIn ad: what they get,
 * why it is safer than the P2P boards they know, and what it takes to start — in that order, in plain words. The same
 * rules as the rest of the public site hold here, and the same copy guard reads every string (`site-copy.unit.test.ts`):
 * no regulatory claim, no invented figure. The only figures are the programme's terms, named — `{margin}`, `{fee}` — and
 * filled in from `TRADER_TERMS` where the words are drawn. A figure the page shows beside these words (the market's rate,
 * a price at a margin) is computed from the market's own reference, never written here.
 *
 * The page speaks to three kinds of trader without becoming three pages: someone who holds USDT, someone with rupees to
 * put to work, and a professional OTC desk. Each has its own words where they differ — keyed by segment — and the rest is
 * said once.
 */

import { TELEGRAM, TRADER_ENTRY } from './site.ts';
import type { Segment } from '../server/acquisition.ts';

export interface TradersPageCopy {
  /** `card` is the line under the headline on the link preview's picture (`pnpm --filter @inrp2p/web og:card --only=traders`). */
  readonly meta: { readonly title: string; readonly description: string; readonly ogTitle: string; readonly card: string };
  readonly masthead: { readonly tag: string; readonly signIn: string; readonly signInLong: string; readonly cta: string; readonly nav: readonly { readonly label: string; readonly anchor: string }[] };
  readonly hero: {
    readonly eyebrow: string;
    readonly title: { readonly lead: string; readonly accent: string };
    readonly switchLabel: string;
    readonly segments: Record<Segment, { readonly tab: string; readonly lede: string }>;
    readonly cta: string;
    readonly ceo: string;
    readonly assurances: readonly string[];
    readonly terms: readonly { readonly figure: string; readonly label: string }[];
    readonly board: {
      readonly pair: string;
      readonly market: string;
      readonly yours: string;
      readonly keep: string;
      readonly waiting: string;
      readonly note: string;
    };
    readonly deal: { readonly title: string; readonly steps: Record<Segment, readonly string[]> };
  };
  readonly proof: readonly { readonly key: 'escrow' | 'bank' | 'refused' | 'ceo'; readonly title: string; readonly body: string }[];
  readonly money: {
    readonly eyebrow: string;
    readonly heading: string;
    readonly lede: string;
    readonly streams: readonly { readonly title: string; readonly body: string }[];
  };
  readonly compare: {
    readonly eyebrow: string;
    readonly heading: string;
    readonly lede: string;
    readonly them: string;
    readonly us: string;
    readonly rows: readonly { readonly topic: string; readonly them: string; readonly us: string }[];
  };
  readonly start: {
    readonly eyebrow: string;
    readonly heading: string;
    readonly lede: string;
    readonly steps: readonly { readonly title: string; readonly body: string }[];
    readonly ready: { readonly title: string; readonly items: readonly string[] };
    readonly cta: string;
  };
  readonly product: { readonly eyebrow: string; readonly heading: string; readonly lede: string; readonly closing: string };
  readonly faq: {
    readonly eyebrow: string;
    readonly heading: string;
    readonly lede: string;
    readonly items: readonly { readonly question: string; readonly answer: string }[];
    readonly ask: { readonly title: string; readonly body: string; readonly label: string };
  };
  readonly closing: {
    readonly heading: string;
    readonly body: string;
    readonly cta: string;
    readonly signIn: string;
    readonly robot: string;
  };
  readonly sticky: { readonly cta: string; readonly note: string };
  readonly footer: { readonly clients: string; readonly clientsLink: string; readonly channel: string };
}

export const TRADERS_PAGE: TradersPageCopy = {
  meta: {
    title: 'Become a USDT trader in India — earn {margin} | INRP2P Exchange',
    description:
      'Run your own USDT exchange on INRP2P: buy and sell USDT at your margin, with escrow on every deal, rupees bank to bank and your own page for clients. INRP2P takes {fee} of a deal.',
    ogTitle: 'Your own USDT exchange. Your margin. Our escrow.',
    card: 'Sell at your margin over the market — traders here commonly work at {margin}. INRP2P takes {fee}.',
  },
  masthead: {
    tag: 'for traders',
    signIn: 'Sign in',
    signInLong: 'Trader sign in',
    cta: TRADER_ENTRY.label,
    nav: [
      { label: 'The money', anchor: 'money' },
      { label: 'Why INRP2P', anchor: 'why' },
      { label: 'How to start', anchor: 'start' },
      { label: 'Questions', anchor: 'questions' },
    ],
  },
  hero: {
    eyebrow: 'For USDT traders and OTC desks in India',
    title: { lead: 'Your own USDT exchange.', accent: 'Your margin. Our escrow.' },
    switchLabel: 'What do you trade with?',
    segments: {
      usdt: {
        tab: 'I hold USDT',
        lede: 'Sell to buyers in India at your margin over the market — traders here commonly work at {margin}. The rupees land in your bank before the robot releases a single USDT.',
      },
      inr: {
        tab: 'I have rupees',
        lede: 'Buy USDT with your rupees at the price you set. The seller’s USDT is locked in escrow before you pay a rupee, and you pay only their own verified account.',
      },
      otc: {
        tab: 'I run an OTC desk',
        lede: 'Put your desk online: a page at your own address, deal links for your clients, a team with roles and Telegram alerts. Escrow on every deal, and INRP2P takes {fee}.',
      },
    },
    cta: TRADER_ENTRY.label,
    ceo: 'Ask our CEO on Telegram',
    assurances: ['Applying costs nothing', 'Reviewed before your first deal', 'Rupees never pass through INRP2P'],
    terms: [
      { figure: '{margin}', label: 'over the market, what traders in India commonly work at' },
      { figure: '{fee}', label: 'INRP2P’s fee on a deal on your exchange' },
    ],
    board: {
      pair: 'USDT / INR',
      market: 'Market now',
      yours: 'Your price at',
      keep: 'You keep',
      waiting: 'Reading the market',
      note: 'An example at the market’s rate now. Your margin is the price you set over it.',
    },
    deal: {
      title: 'One deal on your exchange',
      steps: {
        usdt: ['Price set at your margin', 'Your USDT locked in escrow', 'Rupees land in your bank', 'You confirm, the robot releases'],
        inr: ['Price set by you', 'Seller’s USDT locked in escrow', 'You pay their own account', 'The USDT reaches your wallet'],
        otc: ['Your client opens your link', 'Your price holds for them', 'Their USDT locked in escrow', 'Rupees go bank to bank'],
      },
    },
  },
  proof: [
    { key: 'escrow', title: 'Escrow on every deal', body: 'Each deal’s USDT waits in its own TRON address until the deal says where it goes.' },
    { key: 'bank', title: 'Rupees bank to bank', body: 'Straight between your account and your client’s. They never pass through INRP2P.' },
    { key: 'refused', title: 'Strangers’ money refused', body: 'Only your client’s own registered account can pay you. Anyone else’s is sent back.' },
    { key: 'ceo', title: 'A real person in charge', body: 'Our CEO answers traders on Telegram, in person.' },
  ],
  money: {
    eyebrow: 'The money',
    heading: 'Buyers in India pay over the market. Keep the difference.',
    lede: 'Set your margin once and your prices follow the market by themselves. INRP2P takes {fee} of a deal on your exchange; everything above the market is yours.',
    streams: [
      {
        title: 'Your own clients',
        body: 'Share your page or a deal link on WhatsApp and Telegram. Your clients take your price, at your margin, and stay yours.',
      },
      {
        title: 'INRP2P’s clients',
        body: 'Go online, and INRP2P sends you its clients’ orders that match your prices — privately, one trader per order.',
      },
    ],
  },
  compare: {
    eyebrow: 'Why INRP2P',
    heading: 'P2P, without the part that loses you money.',
    lede: 'Everything a P2P board leaves to luck, the robot in the middle takes care of.',
    them: 'On a P2P board',
    us: 'On your INRP2P exchange',
    rows: [
      { topic: 'Payment proof', them: 'You release on a screenshot and hope it was real.', us: 'You release once the rupees are in your bank. Not a moment before.' },
      { topic: 'Your bank account', them: 'One stranger’s money, and it gets frozen.', us: 'Only your client’s own account can pay you. Anyone else’s is sent back.' },
      { topic: 'Buyers who go quiet', them: 'Your USDT sits in a deal nobody finishes.', us: 'Every step has a time limit. A deal nobody finishes unwinds by itself.' },
      { topic: 'Your prices', them: 'Repost your rate every time the market moves.', us: 'Set your margin once. Your prices follow the market.' },
      { topic: 'Your clients', them: 'They belong to the board, and so does their trust.', us: 'Your page, your links, your clients — for as long as you trade.' },
      { topic: 'When it goes wrong', them: 'Your word against theirs, in a support queue.', us: 'The USDT stays in escrow, and INRP2P decides on the bank’s evidence.' },
    ],
  },
  start: {
    eyebrow: 'How to start',
    heading: 'From your email to your first deal.',
    lede: 'Four steps, all in the app. Nobody has to set you up by hand.',
    steps: [
      { title: 'Apply with your email', body: 'A code to your email, then three short steps: who you are, what you trade, where you settle.' },
      { title: 'Get reviewed', body: 'INRP2P checks your bank account and your wallet before your first deal. Every trader here went through the same.' },
      {
        title: 'Send your Security Reserve',
        body: 'USDT from your own wallet that stands behind your deals and sets how large they can be. It stays yours: what your open deals don’t need can be withdrawn.',
      },
      { title: 'Go online', body: 'Set your margin, share your page and take deals. Complete more, and your limits grow on their own.' },
    ],
    ready: {
      title: 'Have these ready',
      items: ['A bank account in your own or your company’s name', 'A TRC20 wallet you control', 'USDT for your Security Reserve', 'Telegram, for your deal alerts'],
    },
    cta: TRADER_ENTRY.label,
  },
  product: {
    eyebrow: 'Your exchange',
    heading: 'Everything an exchange needs, already built.',
    lede: 'Your page, your prices, deal links, a team and Telegram alerts. Ready the day INRP2P approves you.',
    closing: 'Your clients. Your prices. Our escrow on every deal.',
  },
  faq: {
    eyebrow: 'Questions',
    heading: 'What traders ask first.',
    lede: 'Straight answers, before you give anyone your email.',
    items: [
      {
        question: 'Who are my clients?',
        answer: 'Two kinds. The ones you bring, through your page and your deal links — they are yours. And INRP2P’s own clients, whose orders come to you privately while you are online and your price matches.',
      },
      {
        question: 'What does it cost me?',
        answer: 'INRP2P takes {fee} of a deal on your exchange, and your deals carry the TRON network’s own charge for moving their USDT. Applying costs nothing.',
      },
      {
        question: 'What is the Security Reserve?',
        answer: 'USDT you send from your own registered wallet. It stands behind your deals, so clients can trust them, and it sets how large your deals can be. It stays yours: what your open deals don’t need can be withdrawn to your wallet.',
      },
      {
        question: 'Can someone pay me with a stranger’s money?',
        answer: 'No. Rupees count only from your client’s own registered account. A payment from anyone else is refused and sent back, so it never becomes a problem with your bank.',
      },
      {
        question: 'A buyer says they paid, and I see nothing. Now what?',
        answer: 'Don’t release. The USDT stays in escrow. If their time limit runs out, the deal unwinds; if they insist they paid, INRP2P decides on the bank’s evidence.',
      },
      {
        question: 'Do I need a company?',
        answer: 'No. Individuals and companies both apply. The bank account and the wallet you register must be your own, or your company’s.',
      },
      {
        question: 'Which banks and networks?',
        answer: 'Any Indian bank account that sends and receives by UPI, IMPS, NEFT or RTGS. The USDT side runs on TRON (TRC20).',
      },
      {
        question: 'How will I know where my application stands?',
        answer: 'It is on your Traders screen from the moment you apply, and on Telegram once you connect it. Anything else, ask our CEO directly.',
      },
    ],
    ask: { title: 'Rather talk to a person?', body: 'Our CEO answers traders on Telegram, in person.', label: 'Message the CEO' },
  },
  closing: {
    heading: 'Your exchange is one email away.',
    body: 'Apply in the app with your email. INRP2P reviews you, you send your reserve, and your exchange opens.',
    cta: TRADER_ENTRY.label,
    signIn: 'Already trading on INRP2P? Sign in',
    robot: 'Your move',
  },
  sticky: { cta: TRADER_ENTRY.label, note: 'Applying costs nothing' },
  footer: { clients: 'Buying or selling USDT for yourself?', clientsLink: 'Go to INRP2P Exchange', channel: 'Join the traders’ channel' },
};

/** The Telegram addresses the page offers, from the one list the site keeps. */
export const TRADERS_TELEGRAM = { ceo: TELEGRAM.ceo, traders: TELEGRAM.channels.find((c) => c.handle === 'INR_P2P_USDT') ?? TELEGRAM.channels[0]! };
