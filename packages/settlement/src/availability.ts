import { sql } from 'kysely';
import { DomainError, Money } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { type LatestObservation, isUsableQuality, latestObservation } from '@inrp2p/treasury';
import { type SettlementDeps, policyOf } from './policy.ts';

/**
 * Physical availability of USDT at one address (production task B2, ADR 0016 §2.6): what a fresh, usable reading of
 * the chain says the address holds, less every outflow from it that reading does not yet reflect. Economic
 * availability (whose money it is — the funding earmarks) is a separate question, asked separately; a payout needs
 * both.
 *
 * An outflow is subtracted exactly once: until its movement is confirmed in a block at or below the reading's
 * solidified block it is subtracted (planned, sent, detected — the money is leaving or has left after the reading);
 * once it is, the reading already shows it gone and it is not subtracted again. Incoming money the reading does not
 * show yet is never counted.
 */
export interface PhysicalAvailability {
  readonly address: string;
  readonly observation: LatestObservation | null;
  /** Why the reading cannot be relied on, if it cannot. */
  readonly unusable: string | null;
  readonly observedMinor: bigint;
  readonly pendingOutMinor: bigint;
  readonly availableMinor: bigint;
}

export async function physicalAvailability(
  ex: Executor,
  deps: Pick<SettlementDeps, 'policy'>,
  input: { address: string; amountMinor?: bigint; excludeLegId?: string | null; excludeSendId?: string | null },
): Promise<PhysicalAvailability> {
  const policy = policyOf(deps);
  const obs = await latestObservation(ex, input.address);
  let unusable: string | null = null;
  if (!obs) unusable = 'this address has never been observed';
  else if (!isUsableQuality(obs.quality)) unusable = `the latest reading is ${obs.quality.toLowerCase()}`;
  else if (obs.ageSeconds > policy.maxObservationAgeSeconds) unusable = `the latest reading is ${obs.ageSeconds}s old (limit ${policy.maxObservationAgeSeconds}s)`;
  else if (obs.quality === 'SINGLE_SOURCE' && input.amountMinor !== undefined && input.amountMinor >= Money.parse(policy.dualProviderThresholdUsdt, 'USDT').minor) {
    unusable = 'an outflow of this size needs a balance two independent sources agree on (D-05)';
  }
  const block = obs?.solidifiedBlock ?? -1n;
  const pending = await sql<{ total: string }>`
    with outflow as (
      -- Exchange-paid USDT legs (payouts and refunds) leaving this address.
      select l.amount_minor, c.state, c.block_number
        from settlement_leg l
        left join deposit_address d on d.id = l.source_deposit_address_id
        left join treasury_wallet w on w.id = l.treasury_wallet_id
        left join transfer_allocation a on a.settlement_leg_id = l.id and a.dimension = 'CLIENT' and a.voided_at is null
        left join crypto_transfer c on c.id = a.crypto_transfer_id
       where l.payer = 'EXCHANGE_ACCOUNT' and l.asset = 'USDT' and l.side <> 'CLIENT_TO_EXCHANGE'
         and l.status in ('PENDING', 'PROCESSING', 'COMPLETED')
         and coalesce(d.address, w.address) = ${input.address}
         and (${input.excludeLegId ?? null}::uuid is null or l.id <> ${input.excludeLegId ?? null}::uuid)
      union all
      -- Payments to a route or trader, and reserve withdrawals, sent from this address.
      select c.amount_minor, c.state, c.block_number
        from crypto_transfer c
       where c.from_address = ${input.address} and c.state in ('DETECTED', 'CONFIRMED')
         and (c.payer_type = 'EXCHANGE_TREASURY')
         and exists (select 1 from route_settlement s where s.crypto_transfer_id = c.id and s.flow = 'TO_ROUTE' and s.status in ('RECORDED', 'CONFIRMED')
                     union all select 1 from trader_reserve_withdrawal r where r.crypto_transfer_id = c.id and r.status in ('SENT', 'COMPLETED')
                     -- The signer's own sends that are no payout leg: an escrow back to its trader, earnings to the revenue wallet.
                     union all select 1 from chain_send x where x.crypto_transfer_id = c.id and x.purpose in ('ESCROW_RETURN', 'FEE_SWEEP'))
      union all
      -- A route payment the exchange's signer has planned or is sending from this address (ADR 0017): leaving, with no
      -- movement recorded until the chain makes it final — then it is the route settlement above.
      select s.amount_minor, null::text, null::bigint
        from chain_send s
       where s.purpose in ('ROUTE_PAYMENT', 'ESCROW_RETURN', 'FEE_SWEEP') and s.asset = 'USDT' and s.from_address = ${input.address} and s.status not in ('CONFIRMED', 'CANCELLED')
         and (${input.excludeSendId ?? null}::uuid is null or s.id <> ${input.excludeSendId ?? null}::uuid)
    )
    -- A planned outflow has no transfer yet (state null): it counts. Only one confirmed at or below the reading's block
    -- is already reflected in it.
    select coalesce(sum(amount_minor) filter (where not coalesce(state = 'CONFIRMED' and block_number <= ${block}, false)), 0)::text as total from outflow`.execute(ex);
  const pendingOut = BigInt(pending.rows[0]!.total);
  const observed = obs && isUsableQuality(obs.quality) ? obs.balanceMinor! : 0n;
  return { address: input.address, observation: obs, unusable, observedMinor: observed, pendingOutMinor: pendingOut, availableMinor: observed - pendingOut };
}

/** Refuses an outflow the chain cannot be shown to cover right now (B2). */
export async function assertPhysicallyAvailable(ctx: TxContext, deps: Pick<SettlementDeps, 'policy'>, input: { address: string; amount: Money; excludeLegId?: string | null; excludeSendId?: string | null }): Promise<PhysicalAvailability> {
  const a = await physicalAvailability(ctx.tx, deps, { address: input.address, amountMinor: input.amount.minor, excludeLegId: input.excludeLegId ?? null, excludeSendId: input.excludeSendId ?? null });
  if (a.unusable) {
    throw new DomainError('CUSTODY_OBSERVATION_STALE', `USDT at ${input.address} cannot be relied on: ${a.unusable}; refresh the balance first`, { address: input.address });
  }
  if (a.availableMinor < input.amount.minor) {
    throw new DomainError('CUSTODY_BALANCE_INSUFFICIENT', `the chain shows ${Money.ofMinor(a.availableMinor < 0n ? 0n : a.availableMinor, 'USDT').toDecimalString()} USDT free at ${input.address}`, {
      address: input.address, observed: a.observedMinor.toString(), pendingOut: a.pendingOutMinor.toString(), requested: input.amount.minor.toString(),
    });
  }
  return a;
}
