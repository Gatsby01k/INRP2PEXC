import { DomainError, type Money } from '@inrp2p/kernel';
import { Accounts } from '../accounts.ts';
import type { JournalInput } from '../posting.ts';

/**
 * `trader_reward:{order}:accrue` — the reward INRP2P pays a trader on a completed order, recognized when the order
 * completes: an expense for the exchange and a payable to the trader. The amount was frozen when the order started
 * (programme rate × the order's INR value, rounded down), so a later change to the programme never changes it.
 *
 * It carries no trade dimension on purpose: the trade's own accounts (client, route, margin) settle to zero on
 * their own, and a reward is the trader's business with the exchange, not the client's.
 */
export function traderRewardAccrualJournal(input: { orderId: string; traderId: string; amount: Money<'INR'> }): JournalInput {
  if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'a reward accrual must be positive');
  return {
    postingKey: `trader_reward:${input.orderId}:accrue`,
    eventType: 'trader_reward.accrued',
    tradeId: null,
    entries: [
      { account: Accounts.traderRewards(), direction: 'DR', amount: input.amount },
      { account: Accounts.traderRewardPayable(input.traderId), direction: 'CR', amount: input.amount },
    ],
  };
}
