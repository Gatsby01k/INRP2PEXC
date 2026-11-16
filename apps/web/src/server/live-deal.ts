import 'server-only';
import type { Db } from '@inrp2p/db';
import type { PortalAccess } from '@inrp2p/portal';
import { dealNow, p2pDeal } from '@inrp2p/settlement';
import { traderOrders } from '@inrp2p/traders';

/**
 * The one deal that is waiting for this person right now, for the workspace's bar: its reference, where it is, what
 * the move is, and until when — or null when nothing waits on them. "Waiting on them" is the deal's own word for it
 * (`P2pDeal.turn`, a trader order's `YOUR_TURN` or `OFFER` stage, a desk-priced trade still waiting for the client's
 * first leg), never a guess from the page.
 *
 * Read after the page has drawn, by the bar itself (`/api/client/live`): the frame stays at its four statements
 * (ADR 0021), and a slower read here never holds a page back.
 */
export interface LiveDeal {
  readonly ref: string;
  readonly href: string;
  /** The move, in a few words: "send USDT", "pay INR", "confirm the INR", "new order". */
  readonly move: string;
  /** When the move's time runs out; null when nothing is timed. */
  readonly dueBy: string | null;
  /** Other deals also waiting on them. */
  readonly more: number;
  /** The server's clock when this was read: what a countdown counts from. */
  readonly now: string;
}

/** A client has few deals open at once; past this many, the bar names the most urgent of the first ones. */
const OPEN_LIMIT = 8;

interface Waiting {
  readonly ref: string;
  readonly href: string;
  readonly move: string;
  readonly dueBy: string | null;
}

export async function liveDeal(db: Db, member: PortalAccess, userId: string): Promise<LiveDeal | null> {
  const waiting: Waiting[] = [];

  // The client's own trades still in flight and not paused.
  const open = await db
    .selectFrom('trade')
    .select(['id', 'ref', 'direction', 'lifecycle_state'])
    .where('client_id', '=', member.clientId)
    .where('lifecycle_state', 'not in', ['COMPLETED', 'CANCELLED'])
    .where('hold', '=', false)
    .orderBy('opened_at', 'desc')
    .limit(OPEN_LIMIT)
    .execute();
  for (const t of open) {
    const sell = t.direction === 'SELL_USDT';
    const deal = await p2pDeal(db, null, { tradeId: t.id, viewer: 'CLIENT' });
    if (deal) {
      // The client is the seller of a SELL and the buyer of a BUY; a dispute is INRP2P's turn, not theirs.
      if (deal.turn !== (sell ? 'SELLER' : 'BUYER')) continue;
      const move = deal.step === 'ESCROW' ? 'send USDT' : deal.step === 'PAY' ? 'pay INR' : 'confirm the INR';
      waiting.push({ ref: t.ref, href: `/trades/${t.ref}`, move, dueBy: deal.dueBy });
    } else if (t.lifecycle_state === 'AWAITING_FIRST_LEG') {
      waiting.push({ ref: t.ref, href: `/trades/${t.ref}`, move: sell ? 'send USDT' : 'pay INR', dueBy: null });
    }
  }

  // A trader's orders: an offer to take, or its own side of a deal to pay or confirm.
  const trader = await db.selectFrom('trader_profile').select('id').where('client_id', '=', member.clientId).executeTakeFirst();
  if (trader) {
    const { rows } = await traderOrders(db, userId, 'active', OPEN_LIMIT);
    for (const o of rows) {
      if (o.stage === 'OFFER') {
        waiting.push({ ref: o.ref, href: `/traders/orders/${o.ref}`, move: 'new order', dueBy: o.offerExpiresAt });
      } else if (o.stage === 'YOUR_TURN') {
        const buy = o.side === 'BUY_USDT';
        const move = o.p2pStep === 'CONFIRM' ? 'confirm the INR' : o.p2pStep === 'ESCROW' || !buy ? 'send USDT' : 'pay INR';
        waiting.push({ ref: o.ref, href: `/traders/orders/${o.ref}`, move, dueBy: o.dueBy });
      }
    }
  }

  if (waiting.length === 0) return null;
  // The most urgent first: the one whose time runs out soonest; untimed ones after, newest first as read.
  const ordered = waiting
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.dueBy ? Date.parse(a.w.dueBy) : Infinity) - (b.w.dueBy ? Date.parse(b.w.dueBy) : Infinity) || a.i - b.i);
  const first = ordered[0]!.w;
  return { ...first, more: waiting.length - 1, now: (await dealNow(db)).toISOString() };
}
