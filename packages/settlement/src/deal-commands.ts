import { DomainError, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { type ClientActor, type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { lockTrade } from '@inrp2p/trades';
import { type DealAttachment, type DealAttachmentRef, callSupportInTx, postDealMessageInTx, postDeskMessageInTx } from './chat.ts';
import { clientTradeCommand } from './disputes.ts';
import { choosePayMethodInTx } from './p2p-timing.ts';

/**
 * The client's and INRP2P's commands on a P2P deal's chat and its time to pay (ADR 0023). The trader's live with its
 * other order commands (`@inrp2p/traders`). A file travels beside its command — the payload names it by its hash, so
 * the same press sends it once, and a different file is a different request.
 */

const withFile = (file: DealAttachment | undefined, ref: DealAttachmentRef | null | undefined) => {
  if (!ref) return null;
  if (!file) throw new DomainError('INVALID_ARGUMENT', 'the file did not arrive — attach it again', { field: 'file' });
  return { attachment: file, ref };
};

const legOfRef = async (ctx: TxContext, tradeId: string, legRef: string | null | undefined) => {
  if (!legRef) return null;
  const leg = await ctx.tx.selectFrom('settlement_leg').select('id').where('ref', '=', requireText(legRef, 'legRef', 40)).where('trade_id', '=', tradeId).executeTakeFirst();
  if (!leg) throw new DomainError('NOT_FOUND', 'payment not found');
  return leg.id;
};

/** `deal_chat.post` for a client: a message on its own trade's chat — words, a file, or a receipt for its payment. */
export function postClientDealMessage(actor: ClientActor, file?: DealAttachment) {
  return clientTradeCommand(actor, async (ctx, p: { tradeRef: string; body?: string | null; file?: DealAttachmentRef | null; legRef?: string | null }, tradeId) => {
    await lockTrade(ctx.tx, tradeId);
    return postDealMessageInTx(ctx, { tradeId, author: 'CLIENT', userId: actor.userId, body: p.body ?? null, file: withFile(file, p.file), legId: await legOfRef(ctx, tradeId, p.legRef) });
  });
}

/** `deal_chat.call_support` for a client: INRP2P is asked into the trade's chat. */
export function callClientSupport(actor: ClientActor) {
  return clientTradeCommand(actor, (ctx, p: { tradeRef: string; note?: string | null }, tradeId) => callSupportInTx(ctx, { tradeId, author: 'CLIENT', userId: actor.userId, note: p.note ?? null }));
}

/** `escrow_payment.choose_method` for a client buying USDT: how it pays the seller, and so its time to. */
export function chooseClientPayMethod(actor: ClientActor) {
  return clientTradeCommand(actor, (ctx, p: { tradeRef: string; method: string }, tradeId) => choosePayMethodInTx(ctx, { tradeId, payer: 'CLIENT', userId: actor.userId, method: p.method }));
}

/**
 * `deal_chat.post` for INRP2P's people — `exception:open`, the permission that lets support act on a case: a message
 * in a P2P deal's chat. The first after a side called support says INRP2P joined.
 */
export function postDeskDealMessage(actor: OperatorActor, file?: DealAttachment) {
  return operatorCommand(actor, 'exception:open', async (ctx, p: { tradeId: string; body?: string | null; file?: DealAttachmentRef | null }) =>
    postDeskMessageInTx(ctx, { tradeId: requireUuid(p.tradeId, 'tradeId'), userId: actor.userId, body: p.body ?? null, file: withFile(file, p.file) }));
}
