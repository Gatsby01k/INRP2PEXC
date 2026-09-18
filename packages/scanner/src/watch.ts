import type { Executor } from '@inrp2p/db';

export interface WatchedAddress {
  readonly address: string;
  readonly kind: 'DEPOSIT' | 'TREASURY';
  readonly id: string;
  /** `ASSIGNED` / `COOLDOWN` for a deposit address, `ACTIVE` for a treasury wallet. */
  readonly status: string;
}

/**
 * The addresses the scanner watches. Assigned deposit addresses are where a client's funds are expected;
 * cooled-down ones are watched too, because a late payment to a closed trade must be *seen* and turned into a
 * `FUNDS_AFTER_TRADE_CLOSED` case rather than quietly missed (D-02, FI-26). Treasury wallets are watched so
 * funds sent straight to them surface as `UNALLOCATED_DEPOSIT`.
 *
 * Nothing here attributes anything: watching an address only decides what the scanner reads.
 */
export async function watchedAddresses(ex: Executor, limit: number): Promise<readonly WatchedAddress[]> {
  const deposits = await ex
    .selectFrom('deposit_address')
    .select(['id', 'address', 'status'])
    .where('network', '=', 'TRON')
    .where('status', 'in', ['ASSIGNED', 'COOLDOWN'])
    .orderBy('updated_at desc')
    .limit(limit)
    .execute();
  const remaining = limit - deposits.length;
  const treasury = remaining > 0
    ? await ex
        .selectFrom('treasury_wallet')
        .select(['id', 'address', 'status'])
        .where('network', '=', 'TRON')
        .where('status', '=', 'ACTIVE')
        .orderBy('created_at')
        .limit(remaining)
        .execute()
    : [];
  return [
    ...deposits.map((d) => ({ address: d.address, kind: 'DEPOSIT' as const, id: d.id, status: d.status })),
    ...treasury.map((t) => ({ address: t.address, kind: 'TREASURY' as const, id: t.id, status: t.status })),
  ];
}
