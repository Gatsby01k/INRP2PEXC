import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Executor, FundingModel } from '@inrp2p/db';

/**
 * Whose money a trade runs on (DECISIONS.md D-16, migration 0025). Every trade has exactly one model, frozen when it
 * was opened: COUNTERPARTY_FUNDED for every trade accepted since 0025, LEGACY_EXCHANGE_FUNDED for the ones before.
 *
 * A trade without a row is a broken invariant, not a legacy trade: nothing falls back to the exchange's own money
 * because a fact is missing.
 */
export async function tradeFundingModel(ex: Executor, tradeId: string): Promise<FundingModel> {
  const row = await ex.selectFrom('trade_funding').select('model').where('trade_id', '=', requireUuid(tradeId, 'tradeId')).executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', `trade ${tradeId} has no funding model (FI-70)`);
  return row.model;
}

export async function isCounterpartyFunded(ex: Executor, tradeId: string): Promise<boolean> {
  return (await tradeFundingModel(ex, tradeId)) === 'COUNTERPARTY_FUNDED';
}
