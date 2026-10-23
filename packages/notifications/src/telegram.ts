import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { Money, Rate } from '@inrp2p/kernel';
import type { Db, DirectionValue, Executor, TraderSide } from '@inrp2p/db';
import { type TelegramAdapter, deliveryFailureOf } from '@inrp2p/adapters';
import type { OutboxEvent, OutboxHandler } from '@inrp2p/outbox';

/**
 * Telegram alerts for a desk's people (docs/adr/0020-desks.md §2.14): its new deals, the moves that are its own, the
 * deadlines it is about to miss, and completions — to every person of the trader's client who linked a chat.
 *
 * As with email, nothing here decides anything: an alert exists because a command wrote a state change and enqueued an
 * event, and the words are composed from the rows, never from the event's own wording. A desk deal names its client —
 * the client is the desk's own; an order of the INRP2P desk's trader programme names nobody on the other side.
 *
 * Each alert to each chat is a `telegram_delivery` row whose id is derived from what it is about and the chat, so a
 * redelivered event sends the same message, never a second one; it is SENT only with Telegram's message id. A chat that
 * blocked the bot is a permanent refusal: the delivery fails and the link is revoked.
 */

/** Attempts per chat before a delivery is given up as FAILED; the outbox's own retries run alongside. */
export const MAX_TELEGRAM_ATTEMPTS = 8;

export function telegramDeliveryId(dedupeKey: string, linkId: string): string {
  const b = createHash('sha256').update(`inrp2p.telegram:${dedupeKey}:${linkId}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface TelegramAlert {
  /** The client whose people are told: the trader's client. */
  readonly clientId: string;
  /** What the alert is about, once: a redelivered event or a second sweep finds the same key. */
  readonly dedupeKey: string;
  readonly body: string;
  readonly buttonUrl: string | null;
}

/** Records one alert for every linked chat of the client's active people; returns the deliveries still to send. */
export async function queueTelegram(db: Db, alert: TelegramAlert): Promise<string[]> {
  const links = await db
    .selectFrom('telegram_link as l')
    .innerJoin('client_user as cu', 'cu.id', 'l.client_user_id')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select('l.id')
    .where('cu.client_id', '=', alert.clientId)
    .where('l.status', '=', 'ACTIVE')
    .where('cu.status', '=', 'ACTIVE')
    .where('u.status', '=', 'ACTIVE')
    .execute();
  if (links.length === 0) return [];
  const rows = links.map((l) => ({ id: telegramDeliveryId(alert.dedupeKey, l.id), telegram_link_id: l.id, dedupe_key: alert.dedupeKey, body: alert.body.slice(0, 1000), button_url: alert.buttonUrl }));
  await db.insertInto('telegram_delivery').values(rows).onConflict((oc) => oc.doNothing()).execute();
  const open = await db.selectFrom('telegram_delivery').select('id').where('id', 'in', rows.map((r) => r.id)).where('status', '=', 'PENDING').execute();
  return open.map((r) => r.id);
}

/** Sends deliveries, each under its row's lock; throws while any is still pending so the caller's retry tries again. */
export async function sendTelegramDeliveries(db: Db, adapter: TelegramAdapter, ids: readonly string[]): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let pending = 0;
  for (const id of ids) {
    const outcome = await db.transaction().execute(async (tx) => {
      const d = await tx
        .selectFrom('telegram_delivery as d')
        .innerJoin('telegram_link as l', 'l.id', 'd.telegram_link_id')
        .select(['d.id', 'd.status', 'd.attempts', 'd.body', 'd.button_url', 'l.id as link_id', 'l.chat_id', 'l.status as link_status'])
        .where('d.id', '=', id)
        .forUpdate('d')
        .executeTakeFirst();
      if (!d || d.status !== 'PENDING') return d?.status === 'SENT' ? 'SENT' : 'FAILED';
      if (d.link_status !== 'ACTIVE' || d.chat_id === null) {
        await tx.updateTable('telegram_delivery').set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, last_error: 'LINK_REVOKED' }).where('id', '=', d.id).execute();
        return 'FAILED';
      }
      try {
        const { messageId } = await adapter.send({ chatId: d.chat_id.toString(), text: d.body, ...(d.button_url ? { button: { text: 'Open in INRP2P', url: d.button_url } } : {}) });
        await tx.updateTable('telegram_delivery').set({ status: 'SENT', attempts: d.attempts + 1, provider_message_id: messageId.slice(0, 64), sent_at: sql<Date>`inrp2p_now()`, last_error: null }).where('id', '=', d.id).execute();
        return 'SENT';
      } catch (e) {
        const failure = deliveryFailureOf(e);
        const attempts = d.attempts + 1;
        const final = !failure.retryable || attempts >= MAX_TELEGRAM_ATTEMPTS;
        await tx
          .updateTable('telegram_delivery')
          .set({ attempts, last_error: failure.code.slice(0, 80), ...(final ? { status: 'FAILED' as const, failed_at: sql<Date>`inrp2p_now()` } : {}) })
          .where('id', '=', d.id)
          .execute();
        // The person blocked the bot or deleted the chat: no alert reaches it again until they link it anew.
        if (failure.code === 'TELEGRAM_BLOCKED') {
          await tx.updateTable('telegram_link').set({ status: 'REVOKED', revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: 'the chat blocked the bot' }).where('id', '=', d.link_id).where('status', '=', 'ACTIVE').execute();
        }
        return final ? 'FAILED' : 'PENDING';
      }
    });
    if (outcome === 'SENT') sent += 1;
    else if (outcome === 'FAILED') failed += 1;
    else pending += 1;
  }
  if (pending > 0) throw new Error(`TELEGRAM_DELIVERY_PENDING: ${pending} of ${ids.length} chats not reached yet`);
  return { sent, failed };
}

// ---- what the alerts say -----------------------------------------------------------------------------------------

const usdt = (minor: bigint): string => {
  const [whole = '0', fraction = ''] = Money.ofMinor(minor, 'USDT').toDecimalString().split('.');
  const kept = fraction.replace(/0+$/, '');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${kept ? `.${kept.length < 2 ? kept.padEnd(2, '0') : kept}` : ''} USDT`;
};
const inr = (minor: bigint): string => {
  const [whole = '0', paise = ''] = Money.ofMinor(minor, 'INR').toDecimalString().split('.');
  return `₹${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${/[1-9]/.test(paise) ? `.${paise}` : ''}`;
};
const rate = (micro: bigint, kind: 'CLIENT' | 'ROUTE'): string => {
  const [whole = '0', fraction = ''] = Rate.ofMicro(micro, kind).toDecimalString().split('.');
  return `₹${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
};

/** The facts an order's alert is written from: the order, and — for a desk's deal — its client and the client's side. */
export interface OrderFacts {
  readonly orderId: string;
  readonly ref: string;
  readonly traderClientId: string;
  /** The trader's side: SELL_USDT, the trader delivers USDT. */
  readonly side: TraderSide;
  /** The trader's USDT (what it delivers or receives) and the rupees between the two sides. */
  readonly traderBaseMinor: bigint;
  readonly inrMinor: bigint;
  readonly rateMicro: bigint;
  /** ADR 0019: the rupees move straight between the two sides, the USDT through the deal's escrow. */
  readonly p2p: boolean;
  readonly desk: { readonly clientName: string; readonly direction: DirectionValue; readonly clientBaseMinor: bigint; readonly clientRateMicro: bigint } | null;
}

export async function orderFacts(ex: Executor, orderId: string): Promise<OrderFacts | null> {
  const o = await ex
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .innerJoin('trade_request as r', 'r.id', 'o.trade_request_id')
    .innerJoin('client as c', 'c.id', 'r.client_id')
    .innerJoin('liquidity_route as lr', 'lr.id', 'o.route_id')
    .leftJoin(
      (eb) => eb.selectFrom('quote_network_fee').select(['trader_order_id', sql<string>`max(quote_id::text)`.as('quote_id')]).groupBy('trader_order_id').as('nf'),
      (join) => join.onRef('nf.trader_order_id', '=', 'o.id'),
    )
    .leftJoin('quote as q', (join) => join.on(sql<boolean>`q.id = coalesce(o.quote_id, nf.quote_id::uuid)`))
    .select(['o.id', 'o.ref', 'o.side', 'o.base_minor', 'o.inr_minor', 'o.rate_micro', 't.client_id as trader_client_id', 'r.desk_id', 'r.direction', 'c.display_name', 'q.base_minor as client_base', 'q.client_rate_micro', 'lr.execution_mode'])
    .where('o.id', '=', orderId)
    .executeTakeFirst();
  if (!o) return null;
  return {
    orderId: o.id, ref: o.ref, traderClientId: o.trader_client_id, side: o.side, traderBaseMinor: o.base_minor, inrMinor: o.inr_minor, rateMicro: o.rate_micro, p2p: o.execution_mode === 'P2P',
    desk: o.desk_id ? { clientName: o.display_name, direction: o.direction, clientBaseMinor: o.client_base ?? o.base_minor, clientRateMicro: o.client_rate_micro ?? o.rate_micro } : null,
  };
}

export type OrderMoment = 'NEW_OFFER' | 'STARTED' | 'YOUR_MOVE' | 'CLIENT_PAID' | 'COMPLETED' | 'CANCELLED' | 'DEADLINE' | 'DISPUTE' | 'DECIDED_PAID' | 'DECIDED_NOT_PAID' | 'TIME_RAN_OUT';

/** One alert's words, from the order's facts. `minutesLeft` for a deadline. */
export function orderAlertText(f: OrderFacts, moment: OrderMoment, minutesLeft?: number): string | null {
  const sells = f.side === 'SELL_USDT';
  if (f.desk) {
    const d = f.desk;
    const clientSells = d.direction === 'SELL_USDT';
    const deal = `${d.clientName} ${clientSells ? 'sells you' : 'buys'} ${usdt(d.clientBaseMinor)} at ${rate(d.clientRateMicro, 'CLIENT')} (${inr(f.inrMinor)})`;
    switch (moment) {
      case 'STARTED':
        return clientSells
          ? `New deal ${f.ref}\n${deal}. You pay the rupees once their USDT is in escrow.`
          : `New deal ${f.ref}\n${deal}. Your move: put ${usdt(f.traderBaseMinor)} in escrow now.`;
      case 'YOUR_MOVE':
        return `Your move · ${f.ref}\nPay ${inr(f.inrMinor)} to ${d.clientName}. Their ${usdt(d.clientBaseMinor)} is in escrow.`;
      case 'CLIENT_PAID':
        return `Your move · ${f.ref}\n${d.clientName} says it paid ${inr(f.inrMinor)}. Check your account, then confirm.`;
      case 'DEADLINE':
        return `${minutesLeft ?? 10} minutes left · ${f.ref}\n${clientSells ? `Pay ${inr(f.inrMinor)} to ${d.clientName}.` : `Confirm ${d.clientName}’s ${inr(f.inrMinor)}, or fund the escrow.`}`;
      case 'COMPLETED':
        return `Done · ${f.ref}\nThe deal with ${d.clientName} is complete${clientSells ? `: ${usdt(f.traderBaseMinor)} released to your wallet` : ''}.`;
      case 'CANCELLED':
        return `Cancelled · ${f.ref}\nThe deal with ${d.clientName} was cancelled.`;
      case 'DISPUTE':
        return `With INRP2P · ${f.ref}\n${d.clientName} says your ${inr(f.inrMinor)} has not arrived. Add your bank’s reference on the deal.`;
      case 'DECIDED_PAID':
        return sells
          ? `Released · ${f.ref}\nINRP2P found ${d.clientName}’s ${inr(f.inrMinor)} arrived and released the escrow to them.`
          : `Confirmed · ${f.ref}\nINRP2P confirmed your ${inr(f.inrMinor)} reached ${d.clientName}. Your USDT is on its way.`;
      case 'DECIDED_NOT_PAID':
        return sells
          ? `Cancelled · ${f.ref}\nINRP2P found ${d.clientName}’s ${inr(f.inrMinor)} did not arrive. Your ${usdt(f.traderBaseMinor)} goes back to your wallet.`
          : `Cancelled · ${f.ref}\nINRP2P found your ${inr(f.inrMinor)} did not reach ${d.clientName}. Their USDT goes back to them — do not pay again.`;
      case 'TIME_RAN_OUT':
        return `Cancelled · ${f.ref}\nThe time to pay ${d.clientName} ran out. Their USDT goes back to them — do not pay now.`;
      default:
        return null;
    }
  }
  const order = `${sells ? 'Sell' : 'Buy'} ${usdt(f.traderBaseMinor)} at ${rate(f.rateMicro, 'ROUTE')} (${inr(f.inrMinor)})`;
  switch (moment) {
    case 'NEW_OFFER':
      return `New order ${f.ref}\n${order}. Accept or decline it in Traders before it expires.`;
    case 'STARTED':
      return `Order ${f.ref} is confirmed\n${order}. You will be told when it is your turn.`;
    case 'YOUR_MOVE':
      return `Your turn · ${f.ref}\nSend your ${sells ? usdt(f.traderBaseMinor) : inr(f.inrMinor)} as shown on the order.`;
    case 'CLIENT_PAID':
      return `Your move · ${f.ref}\nThe buyer says it paid ${inr(f.inrMinor)}. Check your account, then confirm.`;
    case 'DEADLINE':
      return `${minutesLeft ?? 10} minutes left · ${f.ref}\nYour step on this order is due.`;
    case 'COMPLETED':
      return `Order ${f.ref} completed\nSettled in full.`;
    case 'CANCELLED':
      return `Order ${f.ref} cancelled`;
    case 'DISPUTE':
      return `With INRP2P · ${f.ref}\nThe seller says your ${inr(f.inrMinor)} has not arrived. Add your bank’s reference on the order.`;
    case 'DECIDED_PAID':
      return sells ? `Released · ${f.ref}\nINRP2P found the buyer’s ${inr(f.inrMinor)} arrived and released the escrow.` : `Confirmed · ${f.ref}\nINRP2P confirmed your ${inr(f.inrMinor)} reached the seller. Your USDT is on its way.`;
    case 'DECIDED_NOT_PAID':
      return sells
        ? `Cancelled · ${f.ref}\nINRP2P found the buyer’s ${inr(f.inrMinor)} did not arrive. Your ${usdt(f.traderBaseMinor)} goes back to your wallet.`
        : `Cancelled · ${f.ref}\nINRP2P found your ${inr(f.inrMinor)} did not reach the seller. Their USDT goes back — do not pay again.`;
    case 'TIME_RAN_OUT':
      return `Cancelled · ${f.ref}\nThe time to pay ran out. The seller’s USDT goes back to them — do not pay now.`;
    default:
      return null;
  }
}

/** Where the alert's button opens: the deal in the desk's workspace, or the order in Traders. Only over https. */
export function orderAlertUrl(f: OrderFacts, linkBase: string | undefined): string | null {
  if (!linkBase || !linkBase.startsWith('https://')) return null;
  try {
    return new URL(f.desk ? `/desk/deals/${encodeURIComponent(f.ref)}` : `/traders/orders/${encodeURIComponent(f.ref)}`, linkBase).toString();
  } catch {
    return null;
  }
}

/** A dispute or an unwind (block 9): what it means for the trader, from the event's own enumerated values — or nothing. */
function p2pMoment(event: OutboxEvent): OrderMoment | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'trader.p2p_dispute_opened':
      // The client says the trader's rupees did not arrive; a trader's own dispute it opened itself.
      return p.payee === 'CLIENT' ? 'DISPUTE' : null;
    case 'trader.p2p_dispute_decided':
      if (p.via !== 'INRP2P') return null;
      return p.decision === 'PAID' ? 'DECIDED_PAID' : p.decision === 'NOT_PAID' ? 'DECIDED_NOT_PAID' : null;
    case 'trader.p2p_unwind_started':
      return p.reason === 'PAY_WINDOW_MISSED' ? 'TIME_RAN_OUT' : null;
    default:
      return null;
  }
}
const P2P_MOMENT_EVENTS: ReadonlySet<string> = new Set(['trader.p2p_dispute_opened', 'trader.p2p_dispute_decided', 'trader.p2p_unwind_started']);

const MOMENTS: Readonly<Record<string, OrderMoment>> = {
  'trader.order_offered': 'NEW_OFFER',
  'trader.order_started': 'STARTED',
  'desk.payout_actionable': 'YOUR_MOVE',
  'desk.client_payment_claimed': 'CLIENT_PAID',
  'trader.order_completed': 'COMPLETED',
  'trader.order_cancelled': 'CANCELLED',
};

async function orderOf(db: Db, event: OutboxEvent): Promise<string | null> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (typeof p.orderId === 'string') return p.orderId;
  if (typeof p.tradeId === 'string') {
    const o = await db.selectFrom('trader_order').select('id').where('trade_id', '=', p.tradeId).where('status', '=', 'IN_PROGRESS').executeTakeFirst();
    if (o || !P2P_MOMENT_EVENTS.has(event.type)) return o?.id ?? null;
    // A decision may have cancelled the trade already: its order is still the one it was.
    const any = await db.selectFrom('trader_order').select('id').where('trade_id', '=', p.tradeId).orderBy('offered_at', 'desc').executeTakeFirst();
    return any?.id ?? null;
  }
  return null;
}

/**
 * Outbox handler for the Telegram channel. Registered only when a bot is configured: with none, nobody has a chat linked
 * and nothing is lost. A trade's payout signal and a client's "I paid" are alerts only when a trader's order stands
 * behind the trade and the move is the trader's.
 */
export function telegramOrderHandler(db: Db, adapter: TelegramAdapter, opts: { linkBase?: string | undefined } = {}): OutboxHandler {
  return {
    name: 'telegram_order_alerts',
    handles: (type) => type in MOMENTS || P2P_MOMENT_EVENTS.has(type),
    run: async (event) => {
      const moment = MOMENTS[event.type] ?? p2pMoment(event);
      if (!moment) return;
      const orderId = await orderOf(db, event);
      if (!orderId) return;
      const facts = await orderFacts(db, orderId);
      if (!facts) return;
      // A desk's own deal is accepted the moment it is priced: it has no offer to announce.
      if (moment === 'NEW_OFFER' && facts.desk) return;
      // On a P2P deal the client's funds arriving is the trader's move only when the client sold (the trader pays the
      // rupees); a client's "I paid" is the trader's to confirm only when the trader sold, and only on a P2P deal — through
      // INRP2P's account the rupees are INRP2P's to check.
      if (moment === 'YOUR_MOVE' && facts.p2p && facts.side === 'SELL_USDT') return;
      if (moment === 'CLIENT_PAID' && !(facts.p2p && facts.side === 'SELL_USDT')) return;
      const body = orderAlertText(facts, moment);
      if (!body) return;
      const ids = await queueTelegram(db, { clientId: facts.traderClientId, dedupeKey: `${event.type}:${orderId}`, body, buttonUrl: orderAlertUrl(facts, opts.linkBase) });
      if (ids.length > 0) await sendTelegramDeliveries(db, adapter, ids);
    },
  };
}
