import { sql } from 'kysely';
import { Money, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { Accounts, accountBalance } from '@inrp2p/ledger';

/**
 * A trader's Security Reserve as figures (docs/TRADERS.md §8), all read from the ledger and the open withdrawals and
 * applications — never a balance kept on the side. Part of the trader core because a trader's standing, which quote
 * commands check for a desk's deal (ADR 0020), depends on it.
 */
export interface ReserveFigures {
  readonly balance: Money<'USDT'>;
  readonly required: Money<'USDT'> | null;
  readonly locked: Money<'USDT'>;
  readonly pendingRelease: Money<'USDT'>;
  readonly applying: Money<'USDT'>;
  readonly available: Money<'USDT'>;
  readonly shortfall: Money<'USDT'>;
  /** True while the reserve is locked because the trader is online or has an order open. */
  readonly engaged: boolean;
  readonly openOrders: number;
}

export async function reserveBalance(ex: Executor, traderId: string): Promise<Money<'USDT'>> {
  const net = await accountBalance(ex, Accounts.traderReserve(traderId));
  // A liability is a credit balance: DR − CR is negative when the exchange owes the trader.
  return Money.ofMinor(-net, 'USDT');
}

export async function reserveFigures(ex: Executor, traderId: string): Promise<ReserveFigures> {
  const id = requireUuid(traderId, 'traderId');
  const profile = await ex.selectFrom('trader_profile').select(['available', 'required_reserve_minor']).where('id', '=', id).executeTakeFirstOrThrow();
  const balance = await reserveBalance(ex, id);
  const counts = await sql<{ open: string; withdrawing: string; applying: string }>`
    select
      (select count(*) from trader_order where trader_id = ${id} and status in ('ACCEPTED', 'IN_PROGRESS'))::text as open,
      (select coalesce(sum(amount_minor), 0) from trader_reserve_withdrawal where trader_id = ${id} and status in ('REQUESTED', 'SENT'))::text as withdrawing,
      (select coalesce(sum(amount_minor), 0) from trader_reserve_application where trader_id = ${id} and status in ('APPROVED', 'SENT'))::text as applying`.execute(ex);
  const openOrders = Number.parseInt(counts.rows[0]!.open, 10);
  const withdrawing = BigInt(counts.rows[0]!.withdrawing);
  const applying = BigInt(counts.rows[0]!.applying);
  const required = profile.required_reserve_minor;
  const engaged = profile.available || openOrders > 0;
  const free = balance.minor - withdrawing - applying;
  const locked = engaged && required !== null ? (free < required ? (free > 0n ? free : 0n) : required) : 0n;
  const available = free - locked;
  const shortfall = required !== null && free < required ? required - free : 0n;
  return {
    balance,
    required: required === null ? null : Money.ofMinor(required, 'USDT'),
    locked: Money.ofMinor(locked, 'USDT'),
    pendingRelease: Money.ofMinor(withdrawing, 'USDT'),
    applying: Money.ofMinor(applying, 'USDT'),
    available: Money.ofMinor(available > 0n ? available : 0n, 'USDT'),
    shortfall: Money.ofMinor(shortfall, 'USDT'),
    engaged,
    openOrders,
  };
}

/** True when the reserve covers the requirement (after anything already on its way out). */
export function reserveFunded(f: ReserveFigures): boolean {
  return f.required !== null && f.shortfall.isZero();
}

