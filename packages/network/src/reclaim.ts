import { sql } from 'kysely';
import { DomainError, formatTrx, normalizeTronAddress } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { networkBudgetWallet } from './budget.ts';
import { planChainSend } from './sends.ts';

/**
 * The TRX a deal address's transfers did not burn (TD-31, ADR 0020 §2.16). A top-up sends an address what its transfer
 * may burn at most; what the chain did not take stays there, and the funder's budget counted all of it as spent. Once no
 * trade uses the address, the signer sends it back to the budget wallet (`TRX_RECLAIM`, a plain TRX transfer the
 * address's free bandwidth usually pays for), and each funder is credited what it put in and was not burned — a
 * `RECLAIM` of its budget. TRX a trader was already paid back for in rupees (a client-borne transfer of a trade that is not
 * P2P) is the platform's; so is anything the address held beyond what can be traced to a funder.
 */

export interface ReclaimShare {
  /** A trader's network deposit, or the platform's budget (null). */
  readonly funder: string | null;
  readonly amountSun: bigint;
}

/**
 * What each funder put into an address and its transfers did not burn: per USDT send from the address since its last
 * reclaim (and before `before`), its confirmed top-ups less every fee its transactions burned there.
 */
export async function reclaimWeights(ex: Executor, address: string, before: Date): Promise<ReclaimShare[]> {
  const r = await sql<{ funder: string | null; bearer: string; mode: string | null; left: string }>`
    with prev as (
      select max(s.created_at) as at from chain_send s
       where s.purpose = 'TRX_RECLAIM' and s.from_address = ${normalizeTronAddress(address)} and s.status = 'CONFIRMED' and s.created_at < ${before}
    )
    select p.funder_trader_id as funder, p.bearer, e.route_execution_mode as mode,
           greatest(
             (select coalesce(sum(t.amount_minor), 0) from chain_send t
               where t.parent_send_id = p.id and t.purpose = 'TOPUP' and t.status = 'CONFIRMED')
           - (select coalesce(sum(a.fee_sun), 0) from chain_send_attempt a where a.send_id = p.id and a.status in ('CONFIRMED', 'FAILED')), 0)::text as left
      from chain_send p
      left join trade_economics e on e.trade_id = p.trade_id
      cross join prev
     where p.from_address = ${normalizeTronAddress(address)} and p.asset = 'USDT' and p.created_at < ${before}
       and (prev.at is null or p.created_at > prev.at)`.execute(ex);
  const by = new Map<string | null, bigint>();
  for (const row of r.rows) {
    const left = BigInt(row.left);
    if (left <= 0n) continue;
    // Paid back in rupees already: a trader's TRX for a transfer it did not bear, on a trade that is not P2P (FI-82).
    const reimbursed = row.funder !== null && row.mode !== 'P2P' && row.bearer !== 'TRADER';
    const funder = reimbursed ? null : row.funder;
    by.set(funder, (by.get(funder) ?? 0n) + left);
  }
  return [...by.entries()].map(([funder, amountSun]) => ({ funder, amountSun }));
}

/**
 * Splits what a reclaim brought back over the funders by what each left there: in full when it covers them all (the rest
 * is the platform's), in proportion when the reclaim's own fee took part of it (rounded down; the remainder is the
 * platform's). Pure, so it is held to its sums by a unit test.
 */
export function splitReclaim(receivedSun: bigint, weights: readonly ReclaimShare[]): ReclaimShare[] {
  if (receivedSun <= 0n) return [];
  const total = weights.reduce((t, w) => t + w.amountSun, 0n);
  const shares = new Map<string | null, bigint>();
  if (total > 0n) {
    for (const w of weights) {
      const share = receivedSun >= total ? w.amountSun : (receivedSun * w.amountSun) / total;
      if (share > 0n) shares.set(w.funder, (shares.get(w.funder) ?? 0n) + share);
    }
  }
  const given = [...shares.values()].reduce((t, v) => t + v, 0n);
  if (receivedSun > given) shares.set(null, (shares.get(null) ?? 0n) + receivedSun - given);
  return [...shares.entries()].filter(([, v]) => v > 0n).map(([funder, amountSun]) => ({ funder, amountSun }));
}

/** Plans the return of an address's TRX to the budget wallet: the platform's own send, needing nobody's approval. */
export async function planTrxReclaimInTx(ctx: TxContext, input: { readonly address: string; readonly amountSun: bigint; readonly feeEstimateSun: bigint }): Promise<{ sendId: string; ref: string }> {
  if (input.amountSun <= 0n) throw new DomainError('INVALID_AMOUNT', 'nothing to reclaim');
  const budget = await networkBudgetWallet(ctx.tx);
  if (!budget) throw new DomainError('WALLET_NOT_ACTIVE', 'no network budget wallet is active');
  const send = await planChainSend(ctx, {
    purpose: 'TRX_RECLAIM', asset: 'TRX', fromAddress: input.address, toAddress: budget.address, amountMinor: input.amountSun, feeEstimateSun: input.feeEstimateSun,
    funder: null, bearer: 'PLATFORM', needsApproval: false, requestedBy: `SYSTEM:${ctx.commandName}`,
  });
  await appendAudit(ctx, { action: 'network.trx_reclaim_planned', entityType: 'chain_send', entityId: send.sendId, after: { ref: send.ref, from: input.address, amount_trx: formatTrx(input.amountSun) } });
  return send;
}

/** A confirmed reclaim: each funder's share back into its budget, once per attempt and funder. */
export async function creditReclaimInTx(ctx: TxContext, input: { readonly sendId: string; readonly attemptId: string }): Promise<readonly ReclaimShare[]> {
  const send = await ctx.tx.selectFrom('chain_send').select(['id', 'ref', 'from_address', 'amount_minor', 'created_at', 'purpose']).where('id', '=', input.sendId).executeTakeFirstOrThrow();
  if (send.purpose !== 'TRX_RECLAIM') throw new DomainError('INVALID_ARGUMENT', 'not a TRX reclaim');
  const shares = splitReclaim(send.amount_minor, await reclaimWeights(ctx.tx, send.from_address, send.created_at));
  for (const s of shares) {
    await ctx.tx
      .insertInto('network_budget_entry')
      .values({
        trader_id: s.funder, kind: 'RECLAIM', amount_sun: s.amountSun, chain_send_attempt_id: input.attemptId,
        posting_key: `trx_reclaim:${input.attemptId}-${s.funder ?? 'platform'}`, note: `unburned TRX back from ${send.from_address} (${send.ref})`.slice(0, 500),
        created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
      })
      .onConflict((oc) => oc.column('posting_key').doNothing())
      .execute();
  }
  await appendAudit(ctx, {
    action: 'network.trx_reclaimed', entityType: 'chain_send', entityId: send.id,
    after: { ref: send.ref, amount_trx: formatTrx(send.amount_minor), shares: shares.map((s) => ({ funder: s.funder ?? 'PLATFORM', trx: formatTrx(s.amountSun) })) },
  });
  return shares;
}
