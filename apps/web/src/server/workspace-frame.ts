import 'server-only';
import type { Db } from '@inrp2p/db';
import { unreadCount } from '@inrp2p/notifications';
import type { PortalAccess } from '@inrp2p/portal';
import { payoutsHeld } from '@inrp2p/trades';

/** What the workspace's frame shows besides the person: their inbox, a payment hold, their desk, desks they deal with. */
export interface WorkspaceFrame {
  readonly unread: number;
  /** After a database recovery the workspace may ask for a payment that was already made; it says so until reconciled. */
  readonly held: boolean;
  /** The client's trader standing, when it has one, and its own desk (ADR 0020), when it has opened one. */
  readonly trader: { readonly status: string; readonly desk: { readonly displayName: string; readonly status: string } | null } | null;
  /** The client deals with independent desks, so finds them beside the Exchange. */
  readonly dealsWithDesks: boolean;
}

/**
 * The frame's reads, sent together: none of them depends on another, so the frame waits for one round trip, not five.
 * A trader has at most one desk and a client at most one trader standing (both unique), so the join is one row.
 */
export async function workspaceFrame(db: Db, member: PortalAccess | null): Promise<WorkspaceFrame> {
  const [unread, { held }, trader, dealsWithDesks] = await Promise.all([
    member ? unreadCount(db, member.clientId) : 0,
    payoutsHeld(db),
    member
      ? db
          .selectFrom('trader_profile as tp')
          .leftJoin('desk as d', 'd.trader_id', 'tp.id')
          .select(['tp.status', 'd.display_name', 'd.status as desk_status'])
          .where('tp.client_id', '=', member.clientId)
          .executeTakeFirst()
      : undefined,
    member ? db.selectFrom('desk_client').select('id').where('client_id', '=', member.clientId).limit(1).executeTakeFirst().then(Boolean) : false,
  ]);
  return {
    unread,
    held,
    trader: trader
      ? { status: trader.status, desk: trader.display_name !== null && trader.desk_status !== null ? { displayName: trader.display_name, status: trader.desk_status } : null }
      : null,
    dealsWithDesks,
  };
}
