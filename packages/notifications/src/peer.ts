import { Money, Rate } from '@inrp2p/kernel';
import type { Db, NotificationKind } from '@inrp2p/db';
import type { OutboxEvent, OutboxHandler } from '@inrp2p/outbox';
import { recordNotification } from './inbox.ts';
import { type NotificationFacts, draftFor } from './messages.ts';

/**
 * ADR 0033: what clients in the book are told — a meeting to start (its maker), a meeting waiting for the other side (its
 * taker), a meeting ended, a deal started for its maker, a price near a client's own, a held price that lapsed while the
 * search goes on. One event per person told; composed from the rows, never from the event's wording; never who the other
 * client is.
 */
type Payload = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

const KIND: Readonly<Record<string, NotificationKind>> = {
  'peer.offered': 'PEER_MATCH_OFFERED',
  'peer.waiting': 'PEER_MATCH_WAITING',
  'peer.ended': 'PEER_MATCH_ENDED',
  'peer.deal_started': 'PEER_DEAL_STARTED',
  'client.peer_nearby': 'PEER_NEARBY',
  'client.waiting_resumed': 'WAITING_RESUMED',
};

export const PEER_EVENTS: ReadonlySet<string> = new Set(Object.keys(KIND));

async function meetingFacts(db: Db, matchId: string, role: 'MAKER' | 'TAKER', reason: string | undefined): Promise<NotificationFacts | null> {
  const m = await db.selectFrom('peer_match as pm')
    .leftJoin('trader_order as o', 'o.id', 'pm.order_id')
    .select(['pm.direction', 'pm.taker_rate_micro', 'pm.maker_rate_micro', 'pm.base_minor', 'pm.route_base_minor', 'pm.inr_minor', 'pm.network_allowance_minor', 'pm.taker_yes_until', 'o.ref as order_ref'])
    .where('pm.id', '=', matchId).executeTakeFirst();
  if (!m) return null;
  const taker = role === 'TAKER';
  const takerNet = m.network_allowance_minor / 2n;
  return {
    peer: {
      role,
      direction: taker ? m.direction : m.direction === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT',
      rate: Rate.ofMicro(taker ? m.taker_rate_micro : m.maker_rate_micro, 'CLIENT').toDecimalString(),
      base: Money.ofMinor(taker ? m.base_minor : m.route_base_minor, 'USDT').toDecimalString(),
      inr: Money.ofMinor(m.inr_minor, 'INR').toDecimalString(),
      network: Money.ofMinor(taker ? takerNet : m.network_allowance_minor - takerNet, 'USDT').toDecimalString(),
      until: m.taker_yes_until,
      ...(reason ? { reason } : {}),
      orderRef: m.order_ref ?? null,
    },
  };
}

async function resolve(db: Db, event: OutboxEvent): Promise<{ clientId: string; kind: NotificationKind; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  const kind = KIND[event.type];
  const clientId = str(p.clientId);
  if (!kind || !clientId) return null;
  if (event.type.startsWith('peer.')) {
    const matchId = str(p.matchId);
    const role = p.role === 'MAKER' || p.role === 'TAKER' ? p.role : null;
    if (!matchId || !role) return null;
    const facts = await meetingFacts(db, matchId, role, str(p.reason));
    return facts ? { clientId, kind, facts } : null;
  }
  const requestId = str(p.requestId);
  if (!requestId) return null;
  const r = await db.selectFrom('trade_request').select(['direction', 'target_rate_micro', 'status', 'waiting_until']).where('id', '=', requestId).executeTakeFirst();
  if (!r) return null;
  if (event.type === 'client.waiting_resumed') return { clientId, kind, facts: r.waiting_until ? { expiresAt: r.waiting_until } : {} };
  // A price near yours: said only while the request still waits — by the time this runs it may have met someone already.
  if (r.status !== 'OPEN' || r.waiting_until === null || (p.kind !== 'READY' && p.kind !== 'NEAR')) return null;
  const rate = str(p.rate);
  if (!rate) return null;
  return {
    clientId, kind,
    facts: {
      peer: {
        role: 'TAKER', direction: r.direction, rate, base: '0', inr: '0', network: '0', near: p.kind,
        ownRate: r.target_rate_micro === null ? null : Rate.ofMicro(r.target_rate_micro, 'CLIENT').toDecimalString(),
      },
    },
  };
}

export function peerNotificationHandler(db: Db): OutboxHandler {
  return {
    name: 'peer_notification_inbox',
    handles: (type) => PEER_EVENTS.has(type),
    run: async (event) => {
      const resolved = await resolve(db, event);
      if (!resolved) return;
      const draft = draftFor(resolved.kind, resolved.facts);
      await recordNotification(db, { ...draft, clientId: resolved.clientId, outboxEventId: event.id });
    },
  };
}
