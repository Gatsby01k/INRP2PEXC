import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCE, PLAYBOOKS, type PersonFacts, type RobotPolicy, type RobotWorld, attemptDue, briefFrom, channelFor, decide, exchangeStage, figuresGrounded,
  inQuietHours, intentOf, istTime, journeyOf, mayContact, rateWords, recommend, sideTakes, traderStage, usdtWords,
} from '../src/index.ts';

const NOW = new Date('2026-11-28T08:00:00Z'); // 13:30 IST
const H = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);
const micro = (rupees: string) => BigInt(rupees.replace('.', '').padEnd(rupees.split('.')[0]!.length + 6, '0'));

const policy = (p: Partial<RobotPolicy> = {}): RobotPolicy => ({
  id: 'p', outreach: 'ON', answers: 'RULES', quietFrom: 22, quietTo: 9, aiDailyLimit: 100, playbooksOff: [], reason: null, setBy: 'test', setAt: NOW.toISOString(), ...p,
});

const world = (w: Partial<RobotWorld> = {}): RobotWorld => ({
  now: NOW,
  market: { SELL_USDT: micro('96.40'), BUY_USDT: micro('97.10') },
  autoQuote: true,
  autoReview: true,
  peer: { enabled: false, feeBps: 25, minDealUsdtMinor: 50_000_000n },
  sides: [],
  demand: { SELL_USDT: { requests: 0, usdtMinor: 0n }, BUY_USDT: { requests: 0, usdtMinor: 0n } },
  ...w,
});

function person(p: Partial<PersonFacts> = {}): PersonFacts {
  return {
    userId: 'u1', createdAt: ago(5), email: 'asha@example.in', telegramChat: null, telegramLinked: false, push: false, lastSeenAt: null, activeNow: false,
    traderLead: false, member: null, trader: null, lastNotifiedAt: null, touches: [], preference: DEFAULT_PREFERENCE, ...p,
  };
}

type Member = NonNullable<PersonFacts['member']>;
const member = (m: Partial<Member> = {}): Member => ({
  clientId: 'c1', clientName: 'Asha', role: 'CLIENT_ADMIN', canAcceptQuotes: true, exchangeAccess: true, createdAt: ago(5), banksActive: 1, walletsActive: 1, pendingReview: 0,
  requests: 0, lastRequest: null, liveQuote: null, openTrades: [], completed: 0, lastTrade: null, ...m,
});

type Trader = NonNullable<PersonFacts['trader']>;
const trader = (t: Partial<Trader> = {}): Trader => ({
  id: 't1', ref: 'TR-261128-0001', status: 'UNDER_REVIEW', appliedAt: ago(3), approvedAt: null, flags: [], offersBuy: true, offersSell: false, available: false,
  sides: [], reserve: { required: '500', shortfall: '500', funded: false }, ...t,
});

describe('where a person is', () => {
  it('names the step on the way in from facts alone', () => {
    expect(exchangeStage(person(), NOW)?.stage).toBe('NEW_ACCOUNT');
    expect(exchangeStage(person({ traderLead: true }), NOW)?.stage).toBe('TRADER_LEAD');
    expect(exchangeStage(person({ member: member({ banksActive: 0, walletsActive: 0 }) }), NOW)?.stage).toBe('NEEDS_DESTINATION');
    expect(exchangeStage(person({ member: member({ banksActive: 0, walletsActive: 0, pendingReview: 1 }) }), NOW)?.stage).toBe('DESTINATION_IN_REVIEW');
    expect(exchangeStage(person({ member: member() }), NOW)?.stage).toBe('READY');
    // A client of the trader programme only has no Exchange track.
    expect(exchangeStage(person({ member: member({ exchangeAccess: false }) }), NOW)).toBeNull();
  });

  it('a deal and a price outrank everything; a waiting request is the robot searching', () => {
    const req = { id: 'r', ref: 'RQ-261128-0001', status: 'OPEN', direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '2000', currency: 'USDT' as const, createdAt: ago(1), closedAt: null, waitingUntil: new Date(NOW.getTime() + 20 * H), noPriceReason: 'NO_OFFER', peerPaused: false, createdBy: 'u1' };
    expect(exchangeStage(person({ member: member({ requests: 1, lastRequest: req }) }), NOW)?.stage).toBe('WAITING');
    expect(exchangeStage(person({ member: member({ requests: 1, lastRequest: req, liveQuote: { ref: 'QT-261128-0001', expiresAt: new Date(NOW.getTime() + 600_000), held: true } }) }), NOW)?.stage).toBe('PRICE_READY');
    expect(exchangeStage(person({ member: member({ requests: 1, lastRequest: req, openTrades: [{ ref: 'IX-261128-0001', direction: 'SELL_USDT', state: 'AWAITING_FIRST_LEG', hold: false, dispute: false }] }) }), NOW)?.stage).toBe('IN_DEAL');
  });

  it('a request the system closed unpriced is worth recovering for a week; one the client withdrew is not', () => {
    const closed = (status: string, hours: number) => ({ id: 'r', ref: 'RQ-261127-0004', status, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '300', currency: 'USDT' as const, createdAt: ago(hours + 24), closedAt: ago(hours), waitingUntil: null, noPriceReason: 'NO_OFFER', peerPaused: false, createdBy: 'u1' });
    expect(exchangeStage(person({ member: member({ requests: 1, lastRequest: closed('DECLINED', 2) }) }), NOW)).toMatchObject({ stage: 'UNMATCHED', subject: 'RQ-261127-0004' });
    expect(exchangeStage(person({ member: member({ requests: 1, lastRequest: closed('WITHDRAWN', 2) }) }), NOW)?.stage).toBe('IDLE');
    expect(exchangeStage(person({ member: member({ requests: 1, lastRequest: closed('DECLINED', 24 * 8) }) }), NOW)?.stage).toBe('IDLE');
  });

  it('a client who traded and has not been back for two weeks is away', () => {
    const lastTrade = { ref: 'IX-261101-0002', direction: 'SELL_USDT' as const, base: '1000', inr: '96400', rateMicro: micro('96.40'), completedAt: ago(24 * 20) };
    expect(exchangeStage(person({ member: member({ requests: 1, completed: 1, lastTrade }) }), NOW)?.stage).toBe('DORMANT');
    expect(exchangeStage(person({ lastSeenAt: ago(24), member: member({ requests: 1, completed: 1, lastTrade }) }), NOW)?.stage).toBe('ACTIVE');
  });

  it('a trader applicant: the bank name first, then the reserve, then a person', () => {
    expect(traderStage(person({ member: member(), trader: trader({ flags: ['BANK_NAME_MISMATCH', 'RESERVE_SHORT'] }) }))?.stage).toBe('FIX_BANK_NAME');
    expect(traderStage(person({ member: member(), trader: trader() }))?.stage).toBe('RESERVE_DUE');
    // No amount set by the programme: the desk decides it first; nothing to ask of the applicant.
    expect(traderStage(person({ member: member(), trader: trader({ reserve: { required: null, shortfall: null, funded: false } }) }))?.stage).toBe('IN_REVIEW');
    expect(traderStage(person({ member: member(), trader: trader({ status: 'APPROVED', approvedAt: ago(2), reserve: { required: '500', shortfall: null, funded: true } }) }))?.stage).toBe('NO_PRICE');
    expect(traderStage(person({ member: member(), trader: trader({ status: 'APPROVED', approvedAt: ago(2), sides: [{ side: 'BUY_USDT', priced: true, active: true }] }) }))?.stage).toBe('OFFLINE');
  });
});

describe('when a playbook is due', () => {
  const p = PLAYBOOKS.find((x) => x.key === 'open_account')!;
  const s = { stage: 'NEW_ACCOUNT', since: ago(3), subject: 'account' };
  const touch = (attempt: number, hours: number, mode: 'LIVE' | 'DRY_RUN' = 'LIVE', mine = true) => ({ id: `t${attempt}`, playbook: 'open_account', subject: 'account', attempt, mode, title: 'x', createdAt: ago(hours), actedAt: null, mine });

  it('on its schedule from the stage, never before, at most its attempts', () => {
    expect(attemptDue(p, { ...s, since: ago(1) }, [], 'LIVE', NOW)).toBeNull();
    expect(attemptDue(p, s, [], 'LIVE', NOW)).toBe(1);
    expect(attemptDue(p, { ...s, since: ago(80) }, [touch(1, 70)], 'LIVE', NOW)).toBe(2);
    expect(attemptDue(p, { ...s, since: ago(200) }, [touch(1, 190), touch(2, 100)], 'LIVE', NOW)).toBeNull();
  });

  it('never starts on a stage older than its freshness, and keeps two messages apart', () => {
    expect(attemptDue(p, { ...s, since: ago(24 * 40) }, [], 'LIVE', NOW)).toBeNull();
    expect(attemptDue(p, { ...s, since: ago(80) }, [touch(1, 2)], 'LIVE', NOW)).toBeNull();
  });

  it('a dry run rehearses without using up the real messages; a colleague’s message counts for the client', () => {
    expect(attemptDue(p, s, [touch(1, 2, 'DRY_RUN')], 'LIVE', NOW)).toBe(1);
    expect(attemptDue(p, { ...s, since: ago(80) }, [touch(1, 70, 'LIVE', false)], 'LIVE', NOW)).toBe(2);
  });
});

describe('whether the robot may write', () => {
  const service = { key: 'add_destination', kind: 'SERVICE' as const };
  const opportunity = { key: 'come_back', kind: 'OPPORTUNITY' as const };

  it('only with consent: service by default, opportunities only when asked for', () => {
    expect(mayContact(person(), service, policy(), NOW)).toEqual({ ok: true, channel: 'EMAIL' });
    expect(mayContact(person(), opportunity, policy(), NOW)).toEqual({ ok: false, why: 'CONSENT' });
    expect(mayContact(person({ preference: { ...DEFAULT_PREFERENCE, outreach: 'ALL' } }), opportunity, policy(), NOW).ok).toBe(true);
    expect(mayContact(person({ preference: { ...DEFAULT_PREFERENCE, outreach: 'NONE' } }), service, policy(), NOW)).toEqual({ ok: false, why: 'CONSENT' });
  });

  it('not while they are in the app, not twice a day, not right after other news, not at night', () => {
    expect(mayContact(person({ activeNow: true }), service, policy(), NOW)).toEqual({ ok: false, why: 'IN_APP' });
    const touches = [{ id: 't', playbook: 'open_account', subject: 'account', attempt: 1, mode: 'LIVE' as const, title: 'x', createdAt: ago(5), actedAt: null, mine: true }];
    expect(mayContact(person({ touches }), service, policy(), NOW)).toEqual({ ok: false, why: 'DAILY_CAP' });
    expect(mayContact(person({ touches: [{ ...touches[0]!, mine: false }] }), service, policy(), NOW).ok).toBe(true);
    expect(mayContact(person({ lastNotifiedAt: ago(1) }), service, policy(), NOW)).toEqual({ ok: false, why: 'RECENTLY_TOLD' });
    expect(mayContact(person(), service, policy({ quietFrom: 13, quietTo: 14 }), NOW)).toEqual({ ok: false, why: 'QUIET_HOURS' });
    expect(mayContact(person({ preference: { ...DEFAULT_PREFERENCE, snoozed: { add_destination: new Date(NOW.getTime() + H).toISOString() } } }), service, policy(), NOW)).toEqual({ ok: false, why: 'SNOOZED' });
    expect(mayContact(person(), service, policy({ outreach: 'OFF' }), NOW)).toEqual({ ok: false, why: 'OFF' });
    expect(mayContact(person(), service, policy({ playbooksOff: ['add_destination'] }), NOW)).toEqual({ ok: false, why: 'PLAYBOOK_OFF' });
  });

  it('Telegram first, then the browser, then email; someone with no account and no channel is not reached', () => {
    expect(channelFor({ telegramChat: '42', push: true, email: 'a@b.in', member: member() })).toBe('TELEGRAM');
    expect(channelFor({ telegramChat: null, push: true, email: 'a@b.in', member: member() })).toBe('PUSH');
    expect(channelFor({ telegramChat: null, push: true, email: 'a@b.in', member: null })).toBe('EMAIL');
    expect(mayContact(person({ email: null }), { key: 'open_account', kind: 'SERVICE' }, policy(), NOW)).toEqual({ ok: false, why: 'NO_CHANNEL' });
    // A member always has the inbox.
    expect(mayContact(person({ email: null, member: member() }), service, policy(), NOW)).toEqual({ ok: true, channel: null });
  });

  it('quiet hours wrap midnight in India and equal hours mean none', () => {
    expect(inQuietHours({ quietFrom: 22, quietTo: 9 }, new Date('2026-11-28T17:00:00Z'))).toBe(true); // 22:30 IST
    expect(inQuietHours({ quietFrom: 22, quietTo: 9 }, new Date('2026-11-28T02:00:00Z'))).toBe(true); // 07:30 IST
    expect(inQuietHours({ quietFrom: 22, quietTo: 9 }, new Date('2026-11-28T04:00:00Z'))).toBe(false); // 09:30 IST
    expect(inQuietHours({ quietFrom: 0, quietTo: 0 }, NOW)).toBe(false);
  });
});

describe('what the robot decides and says', () => {
  it('one playbook, the trader programme first, only to someone who can act on it', () => {
    const f = person({ member: member({ banksActive: 0, walletsActive: 0, createdAt: ago(3) }), trader: trader() });
    const d = decide(f, journeyOf(f, NOW), world(), policy());
    expect(d).toMatchObject({ kind: 'TOUCH', playbook: { key: 'send_reserve' }, attempt: 1, channel: 'EMAIL' });
    if (d.kind === 'TOUCH') expect(d.draft.title).toBe('Send your 500 USDT reserve to go live');
    // The client's trader without authority to commit is not the one asked to send its reserve or add a bank account.
    const g = person({ member: member({ role: 'CLIENT_TRADER', banksActive: 0, walletsActive: 0, createdAt: ago(3) }), trader: trader() });
    expect(decide(g, journeyOf(g, NOW), world(), policy())).toEqual({ kind: 'NOTHING' });
  });

  it('“a trader is online” only when a side online takes that amount, and only to who asked', () => {
    const last = { id: 'r', ref: 'RQ-261127-0004', status: 'DECLINED', direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '300', currency: 'USDT' as const, createdAt: ago(30), closedAt: ago(2), waitingUntil: null, noPriceReason: 'NO_OFFER', peerPaused: false, createdBy: 'u1' };
    const f = person({ member: member({ requests: 1, lastRequest: last }) });
    expect(decide(f, journeyOf(f, NOW), world(), policy())).toEqual({ kind: 'NOTHING' });
    // A side buying USDT holds rupees: ₹10,000 to ₹50,000 an order — 300 USDT at ₹96.40 is ₹28,920.
    const sides = [{ traderClientId: 'c9', side: 'BUY_USDT' as const, currency: 'INR' as const, minMinor: 1_000_000n, maxMinor: 5_000_000n, freeMinor: 100_000_000n }];
    const d = decide(f, journeyOf(f, NOW), world({ sides }), policy());
    expect(d).toMatchObject({ kind: 'TOUCH', playbook: { key: 'supply_back' }, subject: 'RQ-261127-0004' });
    if (d.kind === 'TOUCH') expect(d.draft.href).toBe('/exchange?again=RQ-261127-0004');
    // Too big for it, or the client's own side, or a colleague's request: nothing to say.
    expect(sideTakes(world({ sides }), { direction: 'SELL_USDT', amount: '600', currency: 'USDT' })).toBe(false);
    expect(sideTakes(world({ sides }), { direction: 'SELL_USDT', amount: '300', currency: 'USDT', excludeClientId: 'c9' })).toBe(false);
    const colleague = person({ member: member({ requests: 1, lastRequest: { ...last, createdBy: 'u2' } }) });
    expect(decide(colleague, journeyOf(colleague, NOW), world({ sides }), policy())).toEqual({ kind: 'NOTHING' });
  });

  it('says nothing about the market when the reading is stale, and never welcomes back without a fresh rate', () => {
    const f = person({ preference: { ...DEFAULT_PREFERENCE, outreach: 'ALL' }, member: member({ requests: 1, completed: 1, lastTrade: { ref: 'IX-261101-0002', direction: 'SELL_USDT', base: '1000', inr: '96400', rateMicro: micro('96.40'), completedAt: ago(24 * 20) } }) });
    const stale = world({ market: { SELL_USDT: null, BUY_USDT: null } });
    expect(decide(f, journeyOf(f, NOW), stale, policy())).toEqual({ kind: 'NOTHING' });
    const d = decide(f, journeyOf(f, NOW), world(), policy());
    expect(d).toMatchObject({ kind: 'TOUCH', playbook: { key: 'come_back' } });
    if (d.kind === 'TOUCH') {
      expect(d.draft.title).toBe("Today's market: ₹96.40 per USDT");
      expect(d.draft.body).toContain('Last time you sold 1,000 USDT at ₹96.40');
      expect(d.draft.href).toBe('/exchange?direction=sell&amount=1000');
    }
  });

  it('a refusal is reported when nothing went', () => {
    const f = person({ activeNow: true });
    expect(decide(f, journeyOf(f, NOW), world(), policy())).toEqual({ kind: 'REFUSED', playbook: 'open_account', why: 'IN_APP' });
  });

  it('every message fits the inbox', () => {
    const many = world({ demand: { SELL_USDT: { requests: 12, usdtMinor: 48_250_000_000n }, BUY_USDT: { requests: 7, usdtMinor: 9_000_000_000n } } });
    const f = person({ member: member(), trader: trader({ status: 'APPROVED', approvedAt: ago(30), offersSell: true, reserve: { required: '500', shortfall: null, funded: true } }) });
    for (const p of PLAYBOOKS) {
      const draft = p.compose(f, { stage: p.stage, since: ago(30), subject: 'x' }, many, 1);
      if (!draft) continue;
      expect(draft.title.length, p.key).toBeLessThanOrEqual(120);
      expect(draft.body.length, p.key).toBeLessThanOrEqual(400);
      expect(draft.href, p.key).toMatch(/^\/[A-Za-z0-9/_-]{0,120}(\?[A-Za-z0-9=&._%-]{1,160})?$/);
    }
  });
});

describe('the robot in the workspace', () => {
  const extra = { deal: null, tradersOnline: null, question: null };

  it('a deal waiting on them comes first, then a price, then its search', () => {
    const f = person({ member: member() });
    const deal = { ref: 'IX-261128-0003', href: '/trades/IX-261128-0003', move: 'pay INR', dueBy: new Date(NOW.getTime() + 10 * 60_000).toISOString(), more: 1 };
    expect(briefFrom(f, journeyOf(f, NOW), world(), { ...extra, deal })).toMatchObject({ kind: 'MOVE', mood: 'focused', title: 'Your move: pay INR', action: { href: '/trades/IX-261128-0003' } });
    const req = { id: 'r', ref: 'RQ-261128-0001', status: 'OPEN', direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '2000', currency: 'USDT' as const, createdAt: ago(1), closedAt: null, waitingUntil: new Date('2026-11-29T08:00:00Z'), noPriceReason: 'NO_OFFER', peerPaused: false, createdBy: 'u1' };
    const g = person({ telegramLinked: true, telegramChat: '42', member: member({ requests: 1, lastRequest: req }) });
    const search = briefFrom(g, journeyOf(g, NOW), world(), { ...extra, tradersOnline: 0 });
    expect(search).toMatchObject({ kind: 'SEARCH', mood: 'waiting', face: 'dots', title: 'Finding a trader for 2,000 USDT', working: 'Looking for a trader for 2,000 USDT until tomorrow, 13:30 IST.' });
    expect(search.body).toContain('No trader with that side is online right now.');
    expect(search.body).toContain('tell you on Telegram');
  });

  it('remembers what matters, and knows what the person has already seen', () => {
    const touches = [{ id: 't', playbook: 'first_request', subject: 'first_request', attempt: 1, mode: 'LIVE' as const, title: 'Ready when you are', createdAt: ago(30), actedAt: null, mine: true }];
    const lastTrade = { ref: 'IX-261120-0002', direction: 'BUY_USDT' as const, base: '250', inr: '24275', rateMicro: micro('97.10'), completedAt: ago(24 * 3) };
    const f = person({ lastSeenAt: ago(2), touches, member: member({ requests: 1, completed: 1, lastTrade }) });
    const b = briefFrom(f, journeyOf(f, NOW), world(), extra);
    expect(b.kind).toBe('REST');
    expect(b.remembers).toEqual(['I wrote to you yesterday: “Ready when you are”.', 'Your last deal: bought 250 USDT at ₹97.10 on 25 Nov.']);
    expect(b.isNew).toBe(true);
    const seen = person({ ...f, preference: { ...DEFAULT_PREFERENCE, seenKey: b.key } });
    expect(briefFrom(seen, journeyOf(seen, NOW), world(), extra).isNew).toBe(false);
  });

  it('a step the person said "not now" to rests', () => {
    const f = person({ member: member({ banksActive: 0, walletsActive: 0 }) });
    expect(briefFrom(f, journeyOf(f, NOW), world(), extra)).toMatchObject({ kind: 'STEP', playbook: 'add_destination', action: { href: '/destinations' } });
    const g = person({ ...f, preference: { ...DEFAULT_PREFERENCE, snoozed: { add_destination: new Date(NOW.getTime() + 24 * H).toISOString() } } });
    expect(briefFrom(g, journeyOf(g, NOW), world(), extra).kind).toBe('REST');
  });
});

describe('answers', () => {
  it('recognises the dozen questions people ask, in English and Hinglish', () => {
    expect(intentOf('where is my USDT??')).toBe('STATUS');
    expect(intentOf('paise nahi aaye abhi tak')).toBe('PAYMENT_ISSUE');
    expect(intentOf('I paid but the seller says not received')).toBe('PAYMENT_ISSUE');
    expect(intentOf('aaj ka rate kya hai')).toBe('RATE');
    expect(intentOf('How do I sell USDT?')).toBe('HOW_SELL');
    expect(intentOf('usdt kharidna hai')).toBe('HOW_BUY');
    expect(intentOf('any hidden fees?')).toBe('FEES');
    expect(intentOf('is this safe or a scam')).toBe('PAYMENT_ISSUE');
    expect(intentOf('is it safe')).toBe('SAFETY');
    expect(intentOf('KYC required?')).toBe('DOCUMENTS');
    expect(intentOf('I want to talk to a real person')).toBe('HUMAN');
    expect(intentOf('how can I become a merchant')).toBe('TRADER');
    expect(intentOf('namaste')).toBe('GREETING');
    expect(intentOf('what is the meaning of life')).toBe('UNKNOWN');
  });

  it('a model’s answer is heard only when every figure in it was given to it', () => {
    const facts = "Today's market: sell at ₹96.40, buy at ₹97.10 per USDT.\nLatest request RQ-261128-0001: sell 2,000 USDT, status OPEN.";
    expect(figuresGrounded('You asked to sell 2,000 USDT; the market is at ₹96.40.', facts)).toBe(true);
    expect(figuresGrounded('You will get ₹98.20 per USDT.', facts)).toBe(false);
    expect(figuresGrounded('It usually takes 15 minutes.', facts)).toBe(false);
    expect(figuresGrounded('Step 1: add a bank account.', facts)).toBe(true);
  });
});

describe('the desk’s recommendations', () => {
  it('say what to do about demand nobody serves', () => {
    const w = world({ autoQuote: false, market: { SELL_USDT: null, BUY_USDT: micro('97.10') } });
    const out = recommend({
      policy: policy({ outreach: 'DRY_RUN' }), w,
      steps: [{ key: 'TRADER_FLAGGED', label: '', people: 2, oldestHours: 30 }, { key: 'NEW_ACCOUNT', label: '', people: 5, oldestHours: 40 }],
      waiting: { SELL_USDT: { requests: 3, usdtMinor: 6_000_000_000n }, BUY_USDT: { requests: 1, usdtMinor: 200_000_000n } },
      liquidity: { SELL_USDT: { sidesOnline: 0, tradersWithSide: 2 }, BUY_USDT: { sidesOnline: 0, tradersWithSide: 0 } },
      unpricedTotal: 0, byReason: {}, openCases: 1, aiConfigured: false,
    });
    expect(out.map((r) => r.key)).toEqual(['market_stale', 'auto_off', 'none_online_SELL_USDT', 'no_side_BUY_USDT', 'peer_off', 'applications_waiting', 'cases', 'outreach_off']);
    expect(out.find((r) => r.key === 'no_side_BUY_USDT')!.title).toBe('1 waiting to buy — no trader sells USDT at all');
  });
});

describe('figures as the robot says them', () => {
  it('groups the international way and never pads a rate past what it is', () => {
    expect(usdtWords('1250.500000')).toBe('1,250.5 USDT');
    expect(rateWords(micro('96.4'))).toBe('₹96.40');
    expect(rateWords(micro('96.4125'))).toBe('₹96.4125');
    expect(istTime(new Date('2026-11-28T09:02:00Z'))).toBe('14:32 IST');
  });
});
