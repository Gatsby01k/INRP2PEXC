import { sql } from 'kysely';
import { DomainError, type Money } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { recordCryptoTransfer } from './movements.ts';

/**
 * A trader's Security Reserve delivering the USDT one of its own orders owes (production task D3, TD-21; migration
 * 0029). Two people approved the application (`@inrp2p/traders`); custody — the existing external mechanism, never
 * this code — moves the USDT from the trader's reserve address or a treasury wallet to the order's own delivery
 * address. That movement is recorded here as the order's delivery: a route settlement naming the application, which
 * the chain's finality confirms like any delivery to that address, posting the one journal
 * (`TRADER_RESERVE_APPLIED`: Dr LIAB:TRADER_RESERVE / Cr ASSET:ROUTE_RECEIVABLE). From then on it is counterparty
 * funds of that trade, and the client is paid from it like from any delivery (D-16).
 */

export interface ReserveApplicationRow {
  readonly id: string;
  readonly ref: string;
  readonly trader_id: string;
  readonly trader_order_id: string;
  readonly route_obligation_id: string;
  readonly amount_minor: bigint;
  readonly status: string;
}

export interface ReserveTransferFacts {
  readonly txHash: string;
  readonly logIndex: number;
  readonly tokenContract: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amount: Money<'USDT'>;
  readonly source: 'SCANNER' | 'OPERATOR_SUBMITTED';
}

/** What the route still owes on its delivering side, less deliveries recorded and not yet confirmed. */
export async function routeDeliveryOpen(ex: Executor, obligationId: string): Promise<bigint> {
  const r = await sql<{ open: string }>`select inrp2p_route_delivery_open(${obligationId})::text as open`.execute(ex);
  return BigInt(r.rows[0]!.open);
}

/**
 * The exchange wallet an applied reserve may leave: the trader's own reserve address, or a treasury wallet — never
 * another subject's deposit address, which holds someone else's money. Null when the address is neither.
 */
export async function reserveSourceWallet(ex: Executor, traderId: string, fromAddress: string): Promise<string | null> {
  const wallet = await ex.selectFrom('treasury_wallet').select('id').where('network', '=', 'TRON').where('address', '=', fromAddress).executeTakeFirst();
  if (wallet) return wallet.id;
  const reserve = await ex
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select('d.treasury_wallet_id')
    .where('a.trader_id', '=', traderId)
    .where('d.address', '=', fromAddress)
    .executeTakeFirst();
  return reserve?.treasury_wallet_id ?? null;
}

/** The order's own delivery address and the treasury wallet behind it, if it was issued. */
export async function obligationDeliveryAddress(ex: Executor, obligationId: string): Promise<{ address: string; treasuryWalletId: string } | null> {
  const row = await ex
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.address', 'd.treasury_wallet_id'])
    .where('a.route_obligation_id', '=', obligationId)
    .executeTakeFirst();
  return row ? { address: row.address, treasuryWalletId: row.treasury_wallet_id } : null;
}

/** The approved application of an obligation, locked (after the obligation, ARCHITECTURE §4); null if none. */
export async function lockApprovedReserveApplication(ctx: TxContext, obligationId: string): Promise<ReserveApplicationRow | null> {
  const row = await ctx.tx
    .selectFrom('trader_reserve_application')
    .select(['id', 'ref', 'trader_id', 'trader_order_id', 'route_obligation_id', 'amount_minor', 'status'])
    .where('route_obligation_id', '=', obligationId)
    .where('status', '=', 'APPROVED')
    .where('kind', '=', 'APPLY')
    .forUpdate()
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Records the custody transfer of an approved application as the order's delivery: the movement (exchange wallet →
 * the order's delivery address), a RECORDED route settlement naming the application and its ROUTE allocation; the
 * application is SENT. The caller holds the obligation lock and the application row. Nothing posts until the chain
 * makes the transfer final.
 */
export async function recordAppliedReserveDelivery(
  ctx: TxContext,
  input: { application: ReserveApplicationRow; transfer: ReserveTransferFacts; fromWalletId: string; toWalletId: string },
): Promise<{ transferId: string; routeSettlementId: string; ref: string }> {
  const app = input.application;
  if (app.status !== 'APPROVED') throw new DomainError('INVALID_TRANSITION', `reserve application ${app.ref} is ${app.status.toLowerCase()}`);
  if (input.transfer.amount.minor !== app.amount_minor) {
    throw new DomainError('INVALID_AMOUNT', `this transfer does not move the ${app.amount_minor.toString()} USDT minor units ${app.ref} approved`);
  }
  // The trader may have delivered itself since the approval: the reserve never pays for USDT that is no longer owed.
  const open = await routeDeliveryOpen(ctx.tx, app.route_obligation_id);
  if (open < app.amount_minor) throw new DomainError('INVALID_TRANSITION', `the order no longer owes what ${app.ref} applies; withdraw the application`);
  const obligation = await ctx.tx.selectFrom('route_obligation').select('route_id').where('id', '=', app.route_obligation_id).executeTakeFirstOrThrow();
  const recorded = await recordCryptoTransfer(ctx, {
    ...input.transfer,
    payerType: 'EXCHANGE_TREASURY',
    payerId: input.fromWalletId,
    payeeType: 'EXCHANGE_TREASURY',
    payeeId: input.toWalletId,
  });
  if (recorded.existing) throw new DomainError('DUPLICATE_TX_HASH', 'that transaction is already recorded');
  const settlement = await ctx.tx
    .insertInto('route_settlement')
    .values({
      route_id: obligation.route_id,
      route_obligation_id: app.route_obligation_id,
      obligation_side: 'ROUTE_DELIVERS',
      flow: 'FROM_ROUTE_TO_EXCHANGE',
      asset: 'USDT',
      amount_minor: app.amount_minor,
      transfer_kind: 'CRYPTO',
      crypto_transfer_id: recorded.transferId,
      reserve_application_id: app.id,
      created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  await ctx.tx
    .insertInto('transfer_allocation')
    .values({ transfer_kind: 'CRYPTO', crypto_transfer_id: recorded.transferId, dimension: 'ROUTE', route_settlement_id: settlement.id, amount_minor: app.amount_minor, allocated_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}` })
    .execute();
  await ctx.tx.updateTable('trader_reserve_application').set({ status: 'SENT', sent_at: sql<Date>`inrp2p_now()` }).where('id', '=', app.id).execute();
  await appendAudit(ctx, {
    action: 'route_settlement.recorded', entityType: 'route_settlement', entityId: settlement.id,
    after: { ref: settlement.ref, flow: 'FROM_ROUTE_TO_EXCHANGE', asset: 'USDT', amount: input.transfer.amount, route_obligation_id: app.route_obligation_id, side: 'ROUTE_DELIVERS', evidence: 'CRYPTO', via: 'TRADER_RESERVE', reserve_application: app.ref },
  });
  await appendAudit(ctx, {
    action: 'trader_reserve.application_sent', entityType: 'trader_profile', entityId: app.trader_id,
    after: { ref: app.ref, transfer_id: recorded.transferId, from: input.transfer.fromAddress, to: input.transfer.toAddress, amount: input.transfer.amount, route_settlement: settlement.ref },
  });
  return { transferId: recorded.transferId, routeSettlementId: settlement.id, ref: settlement.ref };
}

/**
 * The scanner's side (`recordTraderDelivery`): USDT reached an order's delivery address from an exchange address. When
 * it is exactly what an approved application of that order moves, from where an applied reserve may leave, it is that
 * application's delivery; otherwise the caller keeps treating it as an unexplained transfer.
 */
export async function attributeAppliedReserve(
  ctx: TxContext,
  transfer: ReserveTransferFacts,
  target: { obligationId: string; toWalletId: string },
): Promise<{ transferId: string } | { mismatch: string } | null> {
  const app = await lockApprovedReserveApplication(ctx, target.obligationId);
  if (!app) return null;
  const fromWalletId = await reserveSourceWallet(ctx.tx, app.trader_id, transfer.fromAddress);
  if (!fromWalletId) return null;
  if (transfer.amount.minor !== app.amount_minor) return { mismatch: `RESERVE_APPLICATION_AMOUNT:${app.ref}` };
  if ((await routeDeliveryOpen(ctx.tx, app.route_obligation_id)) < app.amount_minor) return { mismatch: `RESERVE_APPLICATION_NOT_OWED:${app.ref}` };
  const recorded = await recordAppliedReserveDelivery(ctx, { application: app, transfer, fromWalletId, toWalletId: target.toWalletId });
  return { transferId: recorded.transferId };
}
