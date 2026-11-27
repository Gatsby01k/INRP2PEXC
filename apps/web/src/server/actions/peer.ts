'use server';

import { revalidatePath } from 'next/cache';
import { requestIdForRef } from '@inrp2p/portal';
import { acceptQuoteStandingInTx, completePeerStart, declinePeer, meetPeer, setWait, startPeer, stillLooking } from '@inrp2p/quotes';
import { subscribePush, unsubscribePush } from '@inrp2p/clients';
import { type CommandResult } from '../command.ts';
import { runClientCommand, withClient } from '../client.ts';
import { quoteDepsForWeb } from '../quotes.ts';

/**
 * One book (ADR 0033), as the client acts in it: meeting another client's price, starting a deal another client said yes
 * to, not starting it, saying it is still looking, choosing how long to look, and turning on notifications in this browser.
 * Each runs a domain command as the signed-in client user; the request is named by its reference, resolved within the
 * client's own requests.
 */
const PEER_MESSAGES: ReadonlySet<string> = new Set(['PEER_PRICE_MOVED', 'PEER_MATCH_OVER', 'PEER_MATCH_LIVE', 'PEER_OFF', 'PEER_NOT_AVAILABLE', 'REQUEST_NOT_OPEN', 'WAIT_TOO_SHORT']);

function refresh(): void {
  revalidatePath('/exchange', 'layout');
}

/** "Buy at ₹102.26" — the client says yes to another client's price; the other client is asked to start. */
export async function meetPeerAction(input: { requestRef: string; rate: string }, key: string): Promise<CommandResult<{ matchRef: string; yesUntil: string }>> {
  const id = await withClient((ctx) => requestIdForRef(ctx.db, ctx.access.clientId, input.requestRef));
  if (!id.ok) return id;
  const out = await runClientCommand((ctx) => meetPeer(ctx.actor), { requestId: id.result, rate: input.rate }, { name: 'peer.meet', idempotencyKey: key, keepMessages: PEER_MESSAGES });
  if (out.ok) refresh();
  return out;
}

/**
 * "Start the deal" — the other client's yes stands, so the deal opens in the step right after: the taker's standing yes
 * accepts its price (the web holds the custody adapter a selling taker's escrow address comes from).
 */
export async function startPeerAction(input: { matchRef: string }, key: string): Promise<CommandResult<{ started: boolean }>> {
  const out = await runClientCommand((ctx) => startPeer(ctx.actor), { matchRef: input.matchRef }, { name: 'peer.start', idempotencyKey: key, keepMessages: PEER_MESSAGES });
  if (!out.ok) return out;
  let started = false;
  if (out.result.standing) {
    const done = await withClient((ctx) => completePeerStart(ctx.db, (tx, quoteId, userId) => acceptQuoteStandingInTx(tx, quoteDepsForWeb(), quoteId, userId), out.result.matchId));
    started = done.ok && done.result === 'ACCEPTED';
  }
  refresh();
  revalidatePath('/deals', 'layout');
  return { ok: true, result: { started } };
}

/** "Not this one" — the deal another client said yes to is not started. No strike: the client said so. */
export async function declinePeerAction(input: { matchRef: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runClientCommand((ctx) => declinePeer(ctx.actor), { matchRef: input.matchRef }, { name: 'peer.decline', idempotencyKey: key, keepMessages: PEER_MESSAGES });
  if (out.ok) refresh();
  return out;
}

/** "Still looking" — a request paused after its client missed a meeting is a price for others again. */
export async function stillLookingAction(input: { requestRef: string }, key: string): Promise<CommandResult<unknown>> {
  const id = await withClient((ctx) => requestIdForRef(ctx.db, ctx.access.clientId, input.requestRef));
  if (!id.ok) return id;
  const out = await runClientCommand((ctx) => stillLooking(ctx.actor), { requestId: id.result }, { name: 'peer.still_looking', idempotencyKey: key, keepMessages: PEER_MESSAGES });
  if (out.ok) refresh();
  return out;
}

/** How long the exchange keeps looking: an hour, a day, three days or a week from when the request started waiting. */
export async function setWaitAction(input: { requestRef: string; hours: number }, key: string): Promise<CommandResult<{ waitingUntil: string }>> {
  const id = await withClient((ctx) => requestIdForRef(ctx.db, ctx.access.clientId, input.requestRef));
  if (!id.ok) return id;
  const out = await runClientCommand((ctx) => setWait(ctx.actor), { requestId: id.result, hours: input.hours }, { name: 'request.set_wait', idempotencyKey: key, financial: false, keepMessages: PEER_MESSAGES });
  if (out.ok) refresh();
  return out;
}

/** This browser is told what the person's Telegram would be (ADR 0033 §2.6). */
export async function subscribePushAction(input: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null }, key: string): Promise<CommandResult<unknown>> {
  const out = await runClientCommand((ctx) => subscribePush(ctx.actor), input, { name: 'push.subscribe', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/account');
  return out;
}

export async function unsubscribePushAction(input: { endpoint: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runClientCommand((ctx) => unsubscribePush(ctx.actor), input, { name: 'push.unsubscribe', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/account');
  return out;
}
