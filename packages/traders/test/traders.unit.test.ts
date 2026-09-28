import { describe, expect, it } from 'vitest';
import { parseRewardBps, rewardFor } from '@inrp2p/trader-core';
import { type BlockFacts, type TraderStanding, blockIssues, effectiveMaxOrder, freeCapacity, orderFit, standingIssues, switchOnIssues } from '../src/eligibility.ts';
import { type Candidate, directionForSide, rankCandidates, sideForDirection, sizeOrder } from '../src/routing.ts';
import { type StageFacts, TRADER_ACTION_STAGES, orderStage, orderSteps } from '../src/progress.ts';
import { assertTraderSafe } from '../src/views.ts';

/**
 * The pure rules the Traders feature routes, prices and reports with. Each is asked by more than one caller (routing,
 * switching on, the trader's screen, the desk), so each is held to its answer here, without a database.
 */

const good: TraderStanding = { status: 'APPROVED', available: true, assignmentsEnabled: true, reserveSet: true, reserveFunded: true, destinationsActive: true };

const block = (over: Partial<BlockFacts> = {}): BlockFacts => ({
  side: 'BUY_USDT',
  status: 'ACTIVE',
  rateMicro: 104_700_000n,
  capacityMinor: 50_000_000n, // ₹500,000
  reservedMinor: 0n,
  offeredMinor: 0n,
  minOrderMinor: 5_000_000n, // ₹50,000
  maxOrderMinor: 30_000_000n, // ₹300,000
  operatorMaxOrderMinor: null,
  operatorMaxCapacityMinor: null,
  ...over,
});

describe('standing', () => {
  it('a trader in good standing has no issues', () => {
    expect(standingIssues(good)).toEqual([]);
  });

  it('lists every reason, most fundamental first', () => {
    expect(standingIssues({ status: 'UNDER_REVIEW', available: false, assignmentsEnabled: false, reserveSet: false, reserveFunded: false, destinationsActive: false }))
      .toEqual(['NOT_APPROVED', 'RESERVE_NOT_SET', 'DESTINATIONS_INACTIVE', 'ASSIGNMENTS_DISABLED', 'OFFLINE']);
    expect(standingIssues({ ...good, status: 'PAUSED' })).toEqual(['PAUSED']);
    expect(standingIssues({ ...good, reserveFunded: false })).toEqual(['RESERVE_SHORT']);
  });

  it('switching on ignores being off and the desk’s assignment switch, and nothing else', () => {
    expect(switchOnIssues({ ...good, available: false, assignmentsEnabled: false })).toEqual([]);
    expect(switchOnIssues({ ...good, available: false, reserveFunded: false })).toEqual(['RESERVE_SHORT']);
    expect(switchOnIssues({ ...good, status: 'REJECTED' })).toEqual(['NOT_APPROVED']);
  });
});

describe('capacity and limits', () => {
  it('free capacity is capacity less holds and unanswered offers, never negative', () => {
    expect(freeCapacity(block({ reservedMinor: 10_000_000n, offeredMinor: 5_000_000n }))).toBe(35_000_000n);
    expect(freeCapacity(block({ reservedMinor: 50_000_000n, offeredMinor: 1n }))).toBe(0n);
  });

  it('the desk’s capacity ceiling applies when it is lower than the trader’s own', () => {
    expect(freeCapacity(block({ operatorMaxCapacityMinor: 20_000_000n, reservedMinor: 5_000_000n }))).toBe(15_000_000n);
    expect(freeCapacity(block({ operatorMaxCapacityMinor: 90_000_000n }))).toBe(50_000_000n);
  });

  it('the largest order is the lower of the trader’s maximum and the desk’s', () => {
    expect(effectiveMaxOrder(block())).toBe(30_000_000n);
    expect(effectiveMaxOrder(block({ operatorMaxOrderMinor: 10_000_000n }))).toBe(10_000_000n);
    expect(effectiveMaxOrder(block({ operatorMaxOrderMinor: 40_000_000n }))).toBe(30_000_000n);
    expect(effectiveMaxOrder(block({ maxOrderMinor: null, operatorMaxOrderMinor: 7n }))).toBe(7n);
    expect(effectiveMaxOrder(block({ maxOrderMinor: null }))).toBeNull();
  });

  it('a block without a rate, limits or capacity receives nothing, and says why', () => {
    expect(blockIssues(block())).toEqual([]);
    expect(blockIssues(block({ status: 'PAUSED', rateMicro: null, minOrderMinor: null, reservedMinor: 50_000_000n })))
      .toEqual(['BLOCK_PAUSED', 'NO_RATE', 'NO_LIMITS', 'NO_CAPACITY']);
  });

  it('one order fits only inside the minimum, the maximum and what is free', () => {
    expect(orderFit(block(), 10_470_000n)).toBeNull();
    expect(orderFit(block(), 4_999_999n)).toBe('BELOW_MINIMUM');
    expect(orderFit(block(), 30_000_001n)).toBe('ABOVE_MAXIMUM');
    expect(orderFit(block({ operatorMaxOrderMinor: 10_000_000n }), 10_470_000n)).toBe('ABOVE_MAXIMUM');
    expect(orderFit(block({ reservedMinor: 45_000_000n }), 10_470_000n)).toBe('NOT_ENOUGH_CAPACITY');
    expect(orderFit(block({ status: 'PAUSED' }), 10_470_000n)).toBe('BLOCK_PAUSED');
    expect(orderFit(block({ rateMicro: null }), 10_470_000n)).toBe('NO_RATE');
  });
});

describe('routing order', () => {
  const c = (over: Partial<Candidate> & Pick<Candidate, 'traderRef'>): Candidate => ({
    traderId: over.traderRef, blockId: `b-${over.traderRef}`, routeId: `r-${over.traderRef}`, rateMicro: 104_700_000n, freeMinor: 100n, openOrders: 0, completedOrders: 0, ...over,
  });

  it('a client selling USDT goes to the trader paying the most INR; a client buying USDT to the one asking the least', () => {
    const low = c({ traderRef: 'TR-0001', rateMicro: 104_500_000n });
    const high = c({ traderRef: 'TR-0002', rateMicro: 104_900_000n });
    expect(rankCandidates('SELL_USDT', [low, high]).map((x) => x.traderRef)).toEqual(['TR-0002', 'TR-0001']);
    expect(rankCandidates('BUY_USDT', [high, low]).map((x) => x.traderRef)).toEqual(['TR-0001', 'TR-0002']);
  });

  it('breaks a rate tie by capacity left, then by fewer open orders, then by longer history, then by reference', () => {
    const base = { rateMicro: 104_700_000n };
    expect(rankCandidates('SELL_USDT', [c({ traderRef: 'TR-A', ...base, freeMinor: 10n }), c({ traderRef: 'TR-B', ...base, freeMinor: 20n })])[0]!.traderRef).toBe('TR-B');
    expect(rankCandidates('SELL_USDT', [c({ traderRef: 'TR-A', ...base, openOrders: 2 }), c({ traderRef: 'TR-B', ...base, openOrders: 1 })])[0]!.traderRef).toBe('TR-B');
    expect(rankCandidates('SELL_USDT', [c({ traderRef: 'TR-A', ...base, completedOrders: 1 }), c({ traderRef: 'TR-B', ...base, completedOrders: 9 })])[0]!.traderRef).toBe('TR-B');
    expect(rankCandidates('SELL_USDT', [c({ traderRef: 'TR-0009', ...base }), c({ traderRef: 'TR-0003', ...base })])[0]!.traderRef).toBe('TR-0003');
  });

  it('is deterministic whatever order the candidates arrive in, and leaves the input alone', () => {
    const list = [
      c({ traderRef: 'TR-0004', rateMicro: 104_600_000n }),
      c({ traderRef: 'TR-0002', rateMicro: 104_800_000n, freeMinor: 5n }),
      c({ traderRef: 'TR-0001', rateMicro: 104_800_000n, freeMinor: 5n }),
      c({ traderRef: 'TR-0003', rateMicro: 104_800_000n, freeMinor: 9n }),
    ];
    const before = list.map((x) => x.traderRef);
    const once = rankCandidates('SELL_USDT', list).map((x) => x.traderRef);
    expect(once).toEqual(['TR-0003', 'TR-0001', 'TR-0002', 'TR-0004']);
    expect(rankCandidates('SELL_USDT', [...list].reverse()).map((x) => x.traderRef)).toEqual(once);
    expect(list.map((x) => x.traderRef)).toEqual(before);
  });

  it('a client selling USDT is served by a Buy USDT block, and the other way round', () => {
    expect(sideForDirection('SELL_USDT')).toBe('BUY_USDT');
    expect(sideForDirection('BUY_USDT')).toBe('SELL_USDT');
    expect(directionForSide(sideForDirection('SELL_USDT'))).toBe('SELL_USDT');
  });
});

describe('sizing one order at the trader’s rate', () => {
  it('a USDT-fixed request is priced at the trader’s rate', () => {
    expect(sizeOrder({ direction: 'SELL_USDT', fixedSide: 'BASE', requestedMinor: 1_000_000_000n, traderRateMicro: 104_700_000n, plannedClientRateMicro: null }))
      .toEqual({ baseMinor: 1_000_000_000n, inrMinor: 10_470_000n });
  });

  it('an INR-fixed request takes its USDT from the client rate the desk will quote, and its INR from the trader’s rate', () => {
    expect(sizeOrder({ direction: 'BUY_USDT', fixedSide: 'QUOTE', requestedMinor: 10_520_000n, traderRateMicro: 104_000_000n, plannedClientRateMicro: 105_200_000n }))
      .toEqual({ baseMinor: 1_000_000_000n, inrMinor: 10_400_000n });
  });

  it('an INR-fixed request without the planned client rate is refused rather than guessed', () => {
    expect(() => sizeOrder({ direction: 'BUY_USDT', fixedSide: 'QUOTE', requestedMinor: 10_520_000n, traderRateMicro: 104_000_000n, plannedClientRateMicro: null }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('rewards', () => {
  it('is basis points of the order’s INR, rounded down to the paisa', () => {
    expect(rewardFor(10_470_000n, 10)).toBe(10_470n); // ₹104,700 at 10 bps = ₹104.70
    expect(rewardFor(999n, 10)).toBe(0n);
    expect(rewardFor(10_470_000n, 0)).toBe(0n);
  });

  it('refuses a rate that is not a whole, non-negative number', () => {
    expect(() => rewardFor(1n, -1)).toThrow();
    expect(() => rewardFor(1n, 1.5)).toThrow();
  });

  it('the programme’s reward is none, or a whole number of basis points up to 500', () => {
    expect(parseRewardBps(null)).toBeNull();
    expect(parseRewardBps(undefined)).toBeNull();
    expect(parseRewardBps(10)).toBe(10);
    expect(() => parseRewardBps(501)).toThrow();
    expect(() => parseRewardBps(-1)).toThrow();
  });
});

describe('where an order stands', () => {
  const started: StageFacts = {
    status: 'IN_PROGRESS', counterpartyFunded: true, traderOwedMinor: 10_470_000n, traderPaymentPending: false, inrp2pOwedMinor: 1_000_000_000n, inrp2pPaymentPending: false, needsReview: false,
  };

  it('follows the money, one move at a time', () => {
    expect(orderStage({ ...started, status: 'OFFERED' })).toBe('OFFER');
    expect(orderStage({ ...started, status: 'ACCEPTED' })).toBe('HELD');
    expect(orderStage({ ...started, counterpartyFunded: false })).toBe('AWAITING_FUNDING');
    expect(orderStage(started)).toBe('YOUR_TURN');
    expect(orderStage({ ...started, traderPaymentPending: true })).toBe('CHECKING_YOURS');
    expect(orderStage({ ...started, traderOwedMinor: 0n })).toBe('INRP2P_SENDING');
    expect(orderStage({ ...started, traderOwedMinor: 0n, inrp2pPaymentPending: true })).toBe('CHECKING_INRP2P');
    expect(orderStage({ ...started, traderOwedMinor: 0n, inrp2pOwedMinor: 0n })).toBe('CHECKING_INRP2P');
    expect(orderStage({ ...started, status: 'COMPLETED' })).toBe('COMPLETED');
  });

  it('a transfer the desk has to look at outranks everything else on a started order', () => {
    expect(orderStage({ ...started, needsReview: true })).toBe('REVIEW');
    expect(orderStage({ ...started, needsReview: true, counterpartyFunded: false })).toBe('REVIEW');
  });

  it('every way an order ends without completing reads as closed', () => {
    for (const status of ['DECLINED', 'EXPIRED', 'WITHDRAWN', 'RELEASED', 'CANCELLED'] as const) expect(orderStage({ ...started, status })).toBe('CLOSED');
  });

  it('only an offer and the trader’s own turn ask something of the trader', () => {
    expect([...TRADER_ACTION_STAGES].sort()).toEqual(['OFFER', 'YOUR_TURN']);
  });

  it('labels the five steps for the trader’s side and marks the current one', () => {
    const buy = orderSteps('BUY_USDT', 'YOUR_TURN');
    expect(buy.map((s) => s.label)).toEqual(['Order accepted', 'Other side funded', 'You pay INR', 'You receive USDT', 'Completed']);
    expect(buy.map((s) => s.status)).toEqual(['done', 'done', 'current', 'pending', 'pending']);
    expect(buy[2]!.detail).toBe('your turn');
    expect(orderSteps('SELL_USDT', 'INRP2P_SENDING').map((s) => s.label)).toEqual(['Order accepted', 'Other side funded', 'You send USDT', 'You receive INR', 'Completed']);
    expect(orderSteps('SELL_USDT', 'INRP2P_SENDING')[3]!.detail).toBe('INRP2P is paying your INR');
  });

  it('a review is an exception on the trader’s step; a completed order is done throughout; a closed one moves no step', () => {
    expect(orderSteps('SELL_USDT', 'REVIEW')[2]!.status).toBe('exception');
    expect(orderSteps('BUY_USDT', 'COMPLETED').every((s) => s.status === 'done')).toBe(true);
    expect(orderSteps('BUY_USDT', 'CLOSED').every((s) => s.status === 'pending')).toBe(true);
  });
});

describe('what a trader may be shown', () => {
  it('passes the trader’s own figures', () => {
    expect(() => assertTraderSafe({ ref: 'TO-260927-0001', side: 'BUY_USDT', usdt: '1000.000000', inr: '104700.00', rate: '104.700000', reward: '104.70', payTo: { beneficiary: 'INRP2P', accountNumber: '1' } })).not.toThrow();
  });

  it('refuses anything about the client, the desk’s pricing or its internals, however deep', () => {
    for (const key of ['clientName', 'clientRate', 'margin', 'quoteRef', 'requestId', 'routeId', 'plannedClientRate', 'obligationId', 'snapshotId', 'createdBy', 'closedBy', 'account_number_enc', 'kycStatus']) {
      expect(() => assertTraderSafe({ order: { items: [{ [key]: 'x' }] } }), key).toThrow(/leaks key/);
    }
  });
});
