import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type NetworkFeeBearer, networkFeeJournal, postJournal } from '@inrp2p/ledger';
import { settleSendNetwork } from './funding.ts';
import type { SettlementDeps } from './policy.ts';

/**
 * The network of one GasFree permit, once the chain made its transaction final (ADR 0022 §2.4–2.5): what the controller
 * charged is read from the transaction itself — its USDT Transfer from the deal's GasFree account to the provider the
 * permit named, agreed by the configured providers (FI-24) — never from GasFree's own report, and never above the
 * permit's cap. The permit is CONFIRMED with it, the send's network earmark is consumed at it, and the journal books it out
 * of the deal address: borne by the deal's allowance, the refunded client or the returning trader. The caller then
 * settles what the send itself paid (`settleSignedSendInTx`) and confirms the send.
 */
export async function settleGasFreeNetworkInTx(ctx: TxContext, deps: SettlementDeps, input: { permitId: string; txid: string; decidedBy: string }): Promise<{ feeMinor: bigint }> {
  const permit = await ctx.tx.selectFrom('gasfree_permit').selectAll().where('id', '=', requireUuid(input.permitId, 'permitId')).forUpdate().executeTakeFirstOrThrow();
  if (permit.status === 'CONFIRMED') return { feeMinor: permit.fee_minor! };
  if (permit.status === 'EXPIRED') throw new DomainError('INVALID_TRANSITION', `permit ${permit.seq} of its send expired: it never executed`);
  const send = await ctx.tx.selectFrom('chain_send').selectAll().where('id', '=', permit.send_id).executeTakeFirstOrThrow();
  const txid = input.txid.toLowerCase().replace(/^0x/, '');
  const tx = await deps.chain.transactionTransfers('TRON', txid);
  if (tx.status !== 'FOUND') throw new DomainError('TRANSFER_NOT_CONFIRMED', `transaction ${txid} of permit ${permit.seq} is ${tx.status === 'TX_FAILED' ? 'a failure on chain' : 'not known yet'}`);
  const ours = (to: string) => tx.transfers.filter((t) => t.tokenContract === deps.chain.tokenContract && t.fromAddress === permit.gasfree_address && t.toAddress === to);
  // The transfer itself is located and verified with the send; the network is the provider's part of the same transaction.
  if (ours(permit.receiver).filter((t) => t.amountMinor === permit.value_minor).length !== 1) {
    throw new DomainError('INVALID_ARGUMENT', `transaction ${txid} does not pay ${Money.ofMinor(permit.value_minor, 'USDT').toDecimalString()} USDT from ${permit.gasfree_address} to ${permit.receiver} once`);
  }
  const fees = ours(permit.service_provider);
  if (fees.length > 1) throw new DomainError('INVALID_ARGUMENT', `transaction ${txid} pays the provider ${fees.length} times`);
  let fee = 0n;
  if (fees[0]) {
    const verified = await deps.chain.verifyTransfer('TRON', txid, fees[0].logIndex);
    if (verified.status !== 'FOUND' || verified.receipt.amountMinor !== fees[0].amountMinor || verified.receipt.fromAddress !== permit.gasfree_address
      || verified.receipt.toAddress !== permit.service_provider || verified.receipt.receiptStatus !== 'SUCCESS') {
      throw new DomainError('TRANSFER_NOT_CONFIRMED', `the network of transaction ${txid} is not final and agreed yet`);
    }
    fee = verified.receipt.amountMinor;
  }
  if (fee > permit.max_fee_minor) throw new DomainError('INVALID_ARGUMENT', `transaction ${txid} took ${Money.ofMinor(fee, 'USDT').toDecimalString()} USDT for the network, above the permit's cap`);
  const terms = await ctx.tx.selectFrom('trade as t').innerJoin('quote_network_fee as f', 'f.quote_id', 't.quote_id').select('f.transfer_fee_usdt_minor').where('t.id', '=', requireUuid(send.trade_id, 'tradeId')).executeTakeFirst();
  const transferFee = terms?.transfer_fee_usdt_minor ?? fee;
  await ctx.tx
    .updateTable('gasfree_permit')
    .set({
      status: 'CONFIRMED', txid, fee_minor: fee, activate_fee_minor: fee > transferFee ? fee - transferFee : 0n,
      decided_at: sql<Date>`inrp2p_now()`, decided_by: input.decidedBy.slice(0, 300),
    })
    .where('id', '=', permit.id)
    .execute();
  await settleSendNetwork(ctx, send.id, fee);

  const deposit = await ctx.tx.selectFrom('deposit_address').select('treasury_wallet_id').where('network', '=', 'TRON').where('address', '=', permit.gasfree_address).executeTakeFirstOrThrow();
  let bearer: NetworkFeeBearer = { kind: 'ALLOWANCE' };
  if (send.purpose === 'REFUND') {
    bearer = { kind: 'CLIENT', clientId: (await ctx.tx.selectFrom('trade').select('client_id').where('id', '=', send.trade_id!).executeTakeFirstOrThrow()).client_id };
  } else if (send.purpose === 'ESCROW_RETURN') {
    const o = await ctx.tx.selectFrom('route_obligation').select(['id', 'route_id']).where('id', '=', send.route_obligation_id!).executeTakeFirstOrThrow();
    bearer = { kind: 'ROUTE', routeId: o.route_id, routeObligationId: o.id };
  }
  const journal = networkFeeJournal({ permitId: permit.id, tradeId: send.trade_id, walletId: deposit.treasury_wallet_id, fee: Money.ofMinor(fee, 'USDT'), bearer });
  if (journal) await postJournal(ctx, journal);
  await appendAudit(ctx, {
    action: 'gasfree.permit_confirmed', entityType: 'chain_send', entityId: send.id,
    after: { permit: permit.seq, nonce: permit.nonce.toString(), txid, network: Money.ofMinor(fee, 'USDT'), cap: Money.ofMinor(permit.max_fee_minor, 'USDT'), borne_by: bearer.kind },
  });
  return { feeMinor: fee };
}
