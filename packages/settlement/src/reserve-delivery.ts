import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';

/** What the route still owes on its delivering side, less deliveries recorded and not yet confirmed. */
export async function routeDeliveryOpen(ex: Executor, obligationId: string): Promise<bigint> {
  const r = await sql<{ open: string }>`select inrp2p_route_delivery_open(${obligationId})::text as open`.execute(ex);
  return BigInt(r.rows[0]!.open);
}
