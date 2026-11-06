import { sql } from 'kysely';
import { DomainError, Money } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { type ClientTradeView, getClientTradeView } from '@inrp2p/trades';
import { type ClientSettlementView, type P2pDeal, getClientSettlementView, p2pDeal } from '@inrp2p/settlement';
import { maskedDestination } from '@inrp2p/quotes';
import type { FieldProtector } from '@inrp2p/adapters';
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
  /** BUY: the client's own registered bank accounts, the only ones it may pay from (ADR 0018). Empty for a SELL. */
  readonly fromAccounts: readonly { readonly id: string; readonly holderName: string; readonly bankName: string; readonly last4: string }[];
  /**
   * ADR 0019: the deal — the rupees go straight between the client and its counterparty, the USDT through INRP2P's
   * escrow. Its step, whose move it is and until when, and the account to pay when the client pays.
   */
  readonly p2p: P2pDeal | null;
}

export async function portalTrade(ex: Executor, clientId: string, tradeRef: string, opts: { readonly protector?: FieldProtector | null } = {}): Promise<PortalTrade> {
  const row = await ex
    .selectFrom('trade')
    .select(['id', 'client_id', 'hold', 'opened_at', 'completed_at', 'cancelled_at', 'lifecycle_state'])
    .where('ref', '=', tradeRef)
    .executeTakeFirst();
  // A trade of another client is "not found", not "forbidden": a client learns nothing about what else exists.
  if (!row || row.client_id !== clientId) throw new DomainError('NOT_FOUND', 'trade not found');

  const [trade, settlement] = await Promise.all([getClientTradeView(ex, row.id, clientId), getClientSettlementView(ex, row.id, clientId)]);
  // Where the trade pays: what it agreed to, or a change the client confirmed and the desk approved (D1, TD-18) — never
  // simply whatever destination is active now.
  const now = await sql<{ bank_account_id: string | null; wallet_id: string | null }>`select bank_account_id, wallet_id from inrp2p_trade_payout_destination(${row.id}::uuid)`.execute(ex);
  const frozen = { bank_account_id: now.rows[0]?.bank_account_id ?? null, crypto_wallet_id: now.rows[0]?.wallet_id ?? null };

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
  // The client's leg is confirmed once the trade is past it. For a SELL that is the chain's finality, which the
  // transfer also shows; for a BUY it is the desk confirming the INR by its UTR, which no transfer row carries.
  const funded = FUNDED.has(row.lifecycle_state) || transfer?.state === 'CONFIRMED';
  // Issued by a worker after completion, so a trade can be complete for a moment before its receipt exists. The
  // page offers the download when there is one rather than promising a link that would 404.
  const receipt = completed ? await ex.selectFrom('receipt').select('id').where('trade_id', '=', row.id).executeTakeFirst() : undefined;
  const ended = row.completed_at ?? row.cancelled_at;
  const closedAt = ended ? ended.toISOString() : null;

  return clientSafe({
    trade,
    settlement,
    stages: stagesFor({
      direction: trade.direction,
      openedAt: row.opened_at.toISOString(),
      funded,
      detected: transfer !== undefined,
      paidSomething: paid.isPositive(),
      // A payment sent and not yet confirmed is already on its way: the stage must not still say it is being prepared.
      sending: settlement.payments.some((p) => p.status === 'SENT' || p.status === 'PROCESSING' || p.status === 'EVIDENCE_RECORDED'),
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
    fromAccounts: trade.direction === 'BUY_USDT'
      ? (await ex.selectFrom('bank_account').select(['id', 'holder_name', 'bank_name', 'account_last4']).where('client_id', '=', clientId).where('status', '=', 'ACTIVE').orderBy('created_at').execute())
          .map((a) => ({ id: a.id, holderName: a.holder_name, bankName: a.bank_name, last4: a.account_last4 }))
      : [],
    p2p: await p2pDeal(ex, opts.protector ?? null, { tradeId: row.id, viewer: 'CLIENT' }),
  });
}

/** Lifecycle states past the client's own leg. */
const FUNDED: ReadonlySet<string> = new Set(['FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED', 'COMPLETED']);

/**
 * The four stages the client product shows, in the order they happen. A stage is `current` when it is the one
 * being waited on — which is also the only place the screen offers the client something to do.
 */
function stagesFor(f: {
  direction: 'SELL_USDT' | 'BUY_USDT';
  openedAt: string;
  detected: boolean;
  funded: boolean;
  paidSomething: boolean;
  sending?: boolean;
  completed: boolean;
  closedAt: string | null;
  detectedAt: string | null;
}): TradeStage[] {
  const accepted: TradeStage = { key: 'accepted', status: 'done', at: f.openedAt, detail: null };
  const funded: TradeStage = f.funded
    ? { key: 'funded', status: 'done', at: f.detectedAt, detail: null }
    : {
        key: 'funded',
        status: 'current',
        at: f.detectedAt,
        detail: f.detected ? 'seen, waiting to be final' : f.direction === 'SELL_USDT' ? 'waiting for your USDT' : 'waiting for your INR',
      };
  const settling: TradeStage = f.completed
    ? { key: 'settling', status: 'done', at: f.closedAt, detail: null }
    : f.funded
      ? {
          key: 'settling',
          status: 'current',
          at: null,
          detail: f.paidSomething ? 'paying out' : f.sending ? 'a payment is on its way' : 'preparing your payment',
        }
      : { key: 'settling', status: 'pending', at: null, detail: null };
  const completed: TradeStage = f.completed
    ? { key: 'completed', status: 'done', at: f.closedAt, detail: null }
    : { key: 'completed', status: 'pending', at: null, detail: null };
  return [accepted, funded, settling, completed];
}
