import { DomainError, Money } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { type ClientTradeView, getClientTradeView } from '@inrp2p/trades';
import { type ClientSettlementView, getClientSettlementView } from '@inrp2p/settlement';
import { maskedDestination } from '@inrp2p/quotes';
import { clientSafe } from './access.ts';

/**
 * One trade, as its client sees it (UX_FLOWS F1 step 6).
 *
 * Both halves come from the domain's own client projections — the trade from `@inrp2p/trades`, the payments from
 * `@inrp2p/settlement` — so what this screen shows is what those modules already decided a client may know. The
 * only thing added here is the shape the page needs: the four progress stages, and the incoming transfer, which
 * a client can check on a block explorer once it is final.
 */
export type StageStatus = 'done' | 'current' | 'pending';

export interface TradeStage {
  readonly key: 'accepted' | 'funded' | 'settling' | 'completed';
  readonly status: StageStatus;
  readonly at: string | null;
  readonly detail: string | null;
}

export interface IncomingTransfer {
  readonly txHash: string;
  readonly amount: string;
  readonly state: 'DETECTED' | 'CONFIRMED';
  readonly detectedAt: string;
}

export interface PortalTrade {
  readonly trade: ClientTradeView;
  readonly settlement: ClientSettlementView;
  readonly stages: readonly TradeStage[];
  /** SELL: the USDT the client sent. Null until the chain has shown it to the scanner. */
  readonly incoming: IncomingTransfer | null;
  readonly onHold: boolean;
  readonly completedAt: string | null;
  /** True once a settlement receipt has been issued for this trade and can be downloaded. */
  readonly receipt: boolean;
  /** Where this trade pays out, as the client recognises it: a bank's name and last four, or a wallet address. */
  readonly destination: string;
}

export async function portalTrade(ex: Executor, clientId: string, tradeRef: string): Promise<PortalTrade> {
  const row = await ex
    .selectFrom('trade')
    .select(['id', 'client_id', 'hold', 'opened_at', 'completed_at', 'cancelled_at', 'lifecycle_state'])
    .where('ref', '=', tradeRef)
    .executeTakeFirst();
  // A trade of another client is "not found", not "forbidden": a client learns nothing about what else exists.
  if (!row || row.client_id !== clientId) throw new DomainError('NOT_FOUND', 'trade not found');

  const [trade, settlement] = await Promise.all([getClientTradeView(ex, row.id, clientId), getClientSettlementView(ex, row.id, clientId)]);
  // The destination the trade was frozen with, not whatever is active now: a trade pays where it agreed to pay.
  const frozen = await ex.selectFrom('trade_economics').select(['bank_account_id', 'crypto_wallet_id']).where('trade_id', '=', row.id).executeTakeFirstOrThrow();

  const transfer = await ex
    .selectFrom('crypto_transfer as c')
    .innerJoin('transfer_allocation as a', 'a.crypto_transfer_id', 'c.id')
    .innerJoin('settlement_leg as l', 'l.id', 'a.settlement_leg_id')
    .select(['c.tx_hash', 'c.amount_minor', 'c.state', 'c.detected_at'])
    .where('l.trade_id', '=', row.id)
    .where('l.side', '=', 'CLIENT_TO_EXCHANGE')
    .where('a.voided_at', 'is', null)
    .orderBy('c.detected_at', 'desc')
    .executeTakeFirst();

  const paid = Money.parse(settlement.paid.amount, settlement.paid.currency);
  const completed = row.lifecycle_state === 'COMPLETED';
  // Issued by a worker after completion, so a trade can be complete for a moment before its receipt exists. The
  // page offers the download when there is one rather than promising a link that would 404.
  const receipt = completed ? await ex.selectFrom('receipt').select('id').where('trade_id', '=', row.id).executeTakeFirst() : undefined;
  const ended = row.completed_at ?? row.cancelled_at;
  const closedAt = ended ? ended.toISOString() : null;

  return clientSafe({
    trade,
    settlement,
    stages: stagesFor({
      openedAt: row.opened_at.toISOString(),
      funded: transfer?.state === 'CONFIRMED',
      detected: transfer !== undefined,
      paidSomething: paid.isPositive(),
      completed,
      closedAt: closedAt,
      detectedAt: transfer ? transfer.detected_at.toISOString() : null,
    }),
    incoming:
      transfer && (transfer.state === 'DETECTED' || transfer.state === 'CONFIRMED')
        ? {
            txHash: transfer.tx_hash,
            amount: Money.ofMinor(transfer.amount_minor, 'USDT').toDecimalString(),
            state: transfer.state,
            detectedAt: transfer.detected_at.toISOString(),
          }
        : null,
    onHold: row.hold,
    completedAt: completed ? closedAt : null,
    receipt: receipt !== undefined,
    destination: await maskedDestination(ex, frozen),
  });
}

/**
 * The four stages the client product shows, in the order they happen. A stage is `current` when it is the one
 * being waited on — which is also the only place the screen offers the client something to do.
 */
function stagesFor(f: {
  openedAt: string;
  detected: boolean;
  funded: boolean;
  paidSomething: boolean;
  completed: boolean;
  closedAt: string | null;
  detectedAt: string | null;
}): TradeStage[] {
  const accepted: TradeStage = { key: 'accepted', status: 'done', at: f.openedAt, detail: null };
  const funded: TradeStage = f.funded
    ? { key: 'funded', status: 'done', at: f.detectedAt, detail: null }
    : { key: 'funded', status: 'current', at: f.detectedAt, detail: f.detected ? 'seen, waiting to be final' : 'waiting for your USDT' };
  const settling: TradeStage = f.completed
    ? { key: 'settling', status: 'done', at: f.closedAt, detail: null }
    : f.funded
      ? { key: 'settling', status: 'current', at: null, detail: f.paidSomething ? 'paying out' : 'preparing your payment' }
      : { key: 'settling', status: 'pending', at: null, detail: null };
  const completed: TradeStage = f.completed
    ? { key: 'completed', status: 'done', at: f.closedAt, detail: null }
    : { key: 'completed', status: 'pending', at: null, detail: null };
  return [accepted, funded, settling, completed];
}
