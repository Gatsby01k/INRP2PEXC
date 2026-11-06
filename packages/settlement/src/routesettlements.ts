import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { ObligationSide, RouteSettlementFlow, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { locateTransferLog, lockMovement, postMovement, recordCryptoTransfer, verifyCryptoTransfer } from './movements.ts';
import { allocateToObligation, lockObligation, obligationRemaining } from './obligations.ts';
import type { SettlementDeps } from './policy.ts';
import { assertCounterpartyDelivered, settleFunding } from './funding.ts';
import { requireSourceDepositAddress } from './legs.ts';
import { isCounterpartyFunded, lockTrade } from '@inrp2p/trades';

export interface RecordRouteSettlementPayload {
  /** V1 obligations are PER_TRADE, so a settlement is always recorded against one obligation side (D-03). */
  readonly routeObligationId: string;
  readonly amount: string;
  readonly txHash: string;
  readonly logIndex?: number;
  /** The trader's USDT address; the route's registered one unless it is named. */
  readonly toAddress?: string;
  /** Where it left from: the deal's escrow, where the client's USDT arrived (D-16). */
  readonly sourceDepositAddressId: string;
  /** The exchange's signer made this payment (ADR 0017): the movement is that send's confirmed transaction. */
  readonly chainSendId: string;
}

/**
 * The USDT the signer paid a trader out of a deal's escrow (ADR 0017), recorded against the exchange's side of the
 * obligation. The earmark on the client's funds was taken when the send was planned; a recorded settlement is a claim
 * until `confirmRouteSettlementInTx` holds it to the chain.
 */
export async function recordRouteSettlementInTx(ctx: TxContext, deps: SettlementDeps, p: RecordRouteSettlementPayload): Promise<{ routeSettlementId: string; ref: string; side: ObligationSide; obligationId: string }> {
  // A payment to the route draws on the client's funds of the trade, which refunds also draw on: both happen under
  // the trade lock, taken first (lock order: trade → route obligation).
  const peek = await ctx.tx.selectFrom('route_obligation').select('trade_id').where('id', '=', requireUuid(p.routeObligationId, 'routeObligationId')).executeTakeFirst();
  const fundedTrade = peek?.trade_id && (await isCounterpartyFunded(ctx.tx, peek.trade_id)) ? peek.trade_id : null;
  if (fundedTrade) await lockTrade(ctx.tx, fundedTrade);
  const obligation = await lockObligation(ctx, p.routeObligationId);
  if (fundedTrade) await assertCounterpartyDelivered(ctx.tx, obligation.id);
  if (obligation.status === 'CANCELLED' || obligation.status === 'SETTLED') throw new DomainError('INVALID_TRANSITION', `obligation is ${obligation.status}`);
  const route = await ctx.tx.selectFrom('liquidity_route').select(['id', 'status', 'registered_route_address']).where('id', '=', obligation.route_id).forShare().executeTakeFirstOrThrow();
  if (route.status !== 'ACTIVE') throw new DomainError('ROUTE_NOT_USABLE', `route is ${route.status}`);

  if (obligation.exchange_delivers_asset !== 'USDT') throw new DomainError('INVALID_ARGUMENT', 'only USDT is paid to a trader out of an escrow');
  const amount = Money.parse(p.amount, 'USDT');
  if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'a route settlement must be positive');
  const remaining = await obligationRemaining(ctx.tx, obligation.id);
  if (amount.minor > remaining.exchangeDelivers.minor) {
    throw new DomainError('ROUTE_OVER_ALLOCATION', `only ${remaining.exchangeDelivers.toDecimalString()} ${remaining.exchangeDelivers.currency} remains on the EXCHANGE_DELIVERS side`);
  }

  const source = await requireSourceDepositAddress(ctx, p.sourceDepositAddressId);
  const toAddress = requireText(p.toAddress ?? route.registered_route_address ?? '', 'toAddress', 64);
  const located = await locateTransferLog(deps, { txHash: p.txHash, logIndex: p.logIndex ?? null, from: source.address, to: [toAddress], amountMinor: amount.minor });
  const movement = await recordCryptoTransfer(ctx, {
    txHash: p.txHash,
    logIndex: located.logIndex,
    tokenContract: deps.chain.tokenContract,
    fromAddress: source.address,
    toAddress,
    amount,
    payerType: 'EXCHANGE_TREASURY',
    payerId: source.treasuryWalletId,
    payeeType: 'ROUTE',
    payeeId: route.id,
    source: 'CUSTODY_SIGNER',
  });
  const transferId = movement.transferId;
  const chainSendId = requireUuid(p.chainSendId, 'chainSendId');
  // The send records its own transaction before the route settlement that is it (IX110, IX112).
  await ctx.tx.updateTable('chain_send').set({ crypto_transfer_id: transferId, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', chainSendId).execute();

  const row = await ctx.tx
    .insertInto('route_settlement')
    .values({
      route_id: route.id,
      route_obligation_id: obligation.id,
      obligation_side: 'EXCHANGE_DELIVERS',
      flow: 'TO_ROUTE',
      asset: 'USDT',
      amount_minor: amount.minor,
      transfer_kind: 'CRYPTO',
      fiat_transfer_id: null,
      crypto_transfer_id: transferId,
      chain_send_id: chainSendId,
      created_by: ctx.actor.id ?? 'SYSTEM',
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  await ctx.tx
    .insertInto('transfer_allocation')
    .values({ transfer_kind: 'CRYPTO', crypto_transfer_id: transferId, dimension: 'ROUTE', route_settlement_id: row.id, amount_minor: amount.minor, allocated_by: ctx.actor.id ?? 'SYSTEM' })
    .execute();
  await appendAudit(ctx, {
    action: 'route_settlement.recorded', entityType: 'route_settlement', entityId: row.id,
    after: { ref: row.ref, flow: 'TO_ROUTE', asset: 'USDT', amount, route_obligation_id: obligation.id, side: 'EXCHANGE_DELIVERS', evidence: 'CRYPTO' },
  });
  return { routeSettlementId: row.id, ref: row.ref, side: 'EXCHANGE_DELIVERS', obligationId: obligation.id };
}

/**
 * The confirmation itself, with no actor policy of its own: the scanner reaches it for USDT a trader delivered to its
 * order's own escrow, once the chain has made the transfer final, and the signer for USDT it paid a trader — for USDT,
 * the chain decides (S6). The movement posts its single journal with the obligation dimension (FI-64) and the obligation
 * side is allocated in the same transaction.
 */
export async function confirmRouteSettlementInTx(ctx: TxContext, deps: SettlementDeps, routeSettlementId: string): Promise<{ status: 'CONFIRMED'; obligationStatus: string }> {
  const s = await ctx.tx.selectFrom('route_settlement').selectAll().where('id', '=', requireUuid(routeSettlementId, 'routeSettlementId')).executeTakeFirst();
  if (!s) throw new DomainError('NOT_FOUND', 'route settlement not found');
  if (s.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `route settlement is ${s.status}`);
  const obligation = await lockObligation(ctx, s.route_obligation_id);
  const side = s.obligation_side;
  const amount = Money.ofMinor(s.amount_minor, s.asset);
  const movementId = (s.fiat_transfer_id ?? s.crypto_transfer_id)!;
  await lockMovement(ctx, s.transfer_kind, movementId);

  const verified = await verifyCryptoTransfer(ctx, deps, movementId);
  if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason ?? 'the transfer is not final on chain');

  const routeParty = { kind: 'ROUTE' as const, routeId: s.route_id, routeObligationId: obligation.id };
  const exchangeParty = { kind: 'EXCHANGE_TREASURY' as const, walletId: await counterpartyWallet(ctx, movementId, s.flow) };
  await postMovement(ctx, {
    kind: s.transfer_kind,
    movementId,
    amount,
    from: s.flow === 'TO_ROUTE' ? exchangeParty : routeParty,
    to: s.flow === 'TO_ROUTE' ? routeParty : exchangeParty,
    tradeId: obligation.trade_id,
    purpose: 'ROUTE_SETTLEMENT',
  });
  await ctx.tx.updateTable('route_settlement').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', s.id).execute();
  if (s.flow === 'TO_ROUTE') {
    await settleFunding(ctx, { kind: 'ROUTE_PAYMENT', chainSendId: s.chain_send_id! }, 'CONSUMED', `route settlement ${s.ref} confirmed`);
  }
  const allocated = await allocateToObligation(ctx, { obligation, side, routeSettlementId: s.id, amount });
  await appendAudit(ctx, {
    action: 'route_settlement.confirmed', entityType: 'route_settlement', entityId: s.id,
    before: { status: 'RECORDED' }, after: { status: 'CONFIRMED', amount, side, obligation_status: allocated.status },
  });
  return { status: 'CONFIRMED' as const, obligationStatus: allocated.status };
}

/** The exchange-side wallet of a route movement, read from the evidence row. */
async function counterpartyWallet(ctx: TxContext, movementId: string, flow: RouteSettlementFlow): Promise<string> {
  const c = await ctx.tx.selectFrom('crypto_transfer').select(['payer_id', 'payee_id']).where('id', '=', movementId).executeTakeFirstOrThrow();
  const id = flow === 'TO_ROUTE' ? c.payer_id : c.payee_id;
  if (!id) throw new DomainError('INVALID_ARGUMENT', 'the transfer has no treasury side');
  return id;
}
