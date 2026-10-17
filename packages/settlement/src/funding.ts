import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { AssetCode, Executor, FundingSourceKind, FundingUseKind, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';

/**
 * Counterparty-funded execution (DECISIONS.md D-16, ADR 0016). A trade pays out only money it has received: the
 * client is paid with what the counterparty delivered, the counterparty and a refund with what the client sent —
 * of this trade, in this asset, from the place the money actually is. The platform's own funds never enter.
 *
 * A place is `INR:{inr_account_id}` or `TRON:{address}`. Allocations are earmarks over money the ledger already
 * recorded; they post no journal (FI-27).
 */
export const inrLocation = (inrAccountId: string): string => `INR:${requireUuid(inrAccountId, 'inrAccountId')}`;
export const tronLocation = (address: string): string => `TRON:${address}`;

export interface FundingSourceRow {
  readonly kind: FundingSourceKind;
  readonly sourceId: string;
  readonly asset: AssetCode;
  readonly amountMinor: bigint;
  readonly location: string;
  /** Earmarked by ACTIVE or CONSUMED allocations. */
  readonly takenMinor: bigint;
  readonly availableMinor: bigint;
  readonly confirmedAt: Date | null;
}

/** The trade's confirmed incoming money, with what is still free of each source. Oldest first. */
export async function fundingSources(ex: Executor, tradeId: string, filter: { kind?: FundingSourceKind; asset?: AssetCode } = {}): Promise<FundingSourceRow[]> {
  const r = await sql<{ kind: FundingSourceKind; source_id: string; asset: AssetCode; amount_minor: bigint; location: string; taken: string; confirmed_at: Date | null }>`
    select s.kind, s.source_id, s.asset, s.amount_minor, s.location, s.confirmed_at,
           (select coalesce(sum(f.amount_minor), 0) from funding_allocation f
             where (f.source_leg_id = s.source_id or f.source_route_settlement_id = s.source_id)
               and f.status in ('ACTIVE', 'CONSUMED'))::text as taken
      from funding_source s
     where s.trade_id = ${requireUuid(tradeId, 'tradeId')}
       ${filter.kind ? sql`and s.kind = ${filter.kind}` : sql``}
       ${filter.asset ? sql`and s.asset = ${filter.asset}` : sql``}
     order by s.confirmed_at nulls last, s.source_id`.execute(ex);
  return r.rows.map((row) => {
    const taken = BigInt(row.taken);
    return {
      kind: row.kind, sourceId: row.source_id, asset: row.asset, amountMinor: row.amount_minor, location: row.location,
      takenMinor: taken, availableMinor: row.amount_minor - taken, confirmedAt: row.confirmed_at,
    };
  });
}

export interface FundingUse {
  readonly kind: FundingUseKind;
  readonly legId?: string;
  readonly routeSettlementId?: string;
  /** A route payment the exchange's signer will make, earmarked when it is planned (ADR 0017). */
  readonly chainSendId?: string;
}

const SOURCE_FOR: Record<FundingUseKind, FundingSourceKind> = { CLIENT_PAYOUT: 'COUNTERPARTY_FUNDS', REFUND: 'CLIENT_FUNDS', ROUTE_PAYMENT: 'CLIENT_FUNDS', ESCROW_RETURN: 'COUNTERPARTY_FUNDS' };
const SOURCE_WORDS: Record<FundingSourceKind, string> = { COUNTERPARTY_FUNDS: "the counterparty's", CLIENT_FUNDS: "the client's" };

/**
 * Earmarks `amount` for `use`, oldest money first, from the trade's sources of the kind the use requires
 * (FI-72…74) at the use's own place. The caller holds the trade lock, so two commands of one trade draw on its
 * sources one after the other; the database re-checks at commit that no source is earmarked beyond what arrived
 * (IX085) and that the use is earmarked in full (IX086).
 *
 * The refusals say which situation it is, because each needs a different action: nothing has arrived yet (wait for
 * the counterparty, `FUNDING_NOT_CONFIRMED`), it arrived somewhere else (pay from that place, or move it there first,
 * `FUNDING_LOCATION_MISMATCH`), or not enough arrived (`FUNDING_INSUFFICIENT`).
 */
export async function allocateFunding(
  ctx: TxContext,
  input: { tradeId: string; use: FundingUse; asset: AssetCode; amount: Money; location: string },
): Promise<{ allocations: readonly { id: string; sourceId: string; amountMinor: bigint }[] }> {
  const { amount, asset, location, use } = input;
  if (amount.currency !== asset || !amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'an earmark must be a positive amount of the use\'s asset');
  const sourceKind = SOURCE_FOR[use.kind];
  const sources = await fundingSources(ctx.tx, input.tradeId, { kind: sourceKind, asset });
  const here = sources.filter((s) => s.location === location && s.availableMinor > 0n);
  const freeHere = here.reduce((t, s) => t + s.availableMinor, 0n);
  if (freeHere < amount.minor) {
    const freeAnywhere = sources.reduce((t, s) => t + (s.availableMinor > 0n ? s.availableMinor : 0n), 0n);
    const elsewhere = sources.filter((s) => s.location !== location && s.availableMinor > 0n).map((s) => ({ location: s.location, available: Money.ofMinor(s.availableMinor, asset).toDecimalString() }));
    const details = { requested: amount.toDecimalString(), availableHere: Money.ofMinor(freeHere, asset).toDecimalString(), location, elsewhere };
    if (sources.length === 0 || freeAnywhere === 0n) {
      throw new DomainError('FUNDING_NOT_CONFIRMED', `${SOURCE_WORDS[sourceKind]} ${asset} for this trade has not been confirmed yet (D-16): nothing is paid out ahead of it`, details);
    }
    if (freeAnywhere >= amount.minor && elsewhere.length > 0) {
      throw new DomainError('FUNDING_LOCATION_MISMATCH', `${SOURCE_WORDS[sourceKind]} ${asset} for this trade is at another account or address; pay from where it is`, details);
    }
    throw new DomainError('FUNDING_INSUFFICIENT', `only ${Money.ofMinor(freeHere, asset).toDecimalString()} ${asset} of ${SOURCE_WORDS[sourceKind]} funds is free here for this trade`, details);
  }
  let left = amount.minor;
  const allocations: { id: string; sourceId: string; amountMinor: bigint }[] = [];
  for (const s of here) {
    if (left === 0n) break;
    const take = s.availableMinor < left ? s.availableMinor : left;
    const row = await ctx.tx
      .insertInto('funding_allocation')
      .values({
        trade_id: input.tradeId,
        source_kind: sourceKind,
        source_leg_id: sourceKind === 'CLIENT_FUNDS' ? s.sourceId : null,
        source_route_settlement_id: sourceKind === 'COUNTERPARTY_FUNDS' ? s.sourceId : null,
        use_kind: use.kind,
        use_leg_id: use.legId ?? null,
        use_route_settlement_id: use.routeSettlementId ?? null,
        use_chain_send_id: use.chainSendId ?? null,
        asset,
        amount_minor: take,
        location,
        created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    allocations.push({ id: row.id, sourceId: s.sourceId, amountMinor: take });
    left -= take;
  }
  await appendAudit(ctx, {
    action: 'funding.allocated', entityType: 'trade', entityId: input.tradeId,
    after: { use: use.kind, use_id: use.legId ?? use.routeSettlementId, source_kind: sourceKind, amount, location, allocations: allocations.map((a) => ({ id: a.id, source: a.sourceId, amount: Money.ofMinor(a.amountMinor, asset) })) },
  });
  return { allocations };
}

/**
 * Closes a use's earmarks: CONSUMED when its movement is confirmed, RELEASED when it was cancelled or failed and the
 * money provably did not leave. Never released while the outcome is unknown — an ambiguous payout keeps its money.
 */
export async function settleFunding(ctx: TxContext, use: FundingUse, outcome: 'CONSUMED' | 'RELEASED', reason: string): Promise<number> {
  const rows = await ctx.tx
    .updateTable('funding_allocation')
    .set({ status: outcome, closed_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`, closed_at: sql<Date>`inrp2p_now()`, close_reason: reason.slice(0, 500) })
    .where((eb) => (use.legId ? eb('use_leg_id', '=', use.legId) : use.chainSendId ? eb('use_chain_send_id', '=', use.chainSendId) : eb('use_route_settlement_id', '=', use.routeSettlementId!)))
    .where('status', '=', 'ACTIVE')
    .returning(['id', 'trade_id', 'amount_minor', 'asset'])
    .execute();
  if (rows.length > 0) {
    await appendAudit(ctx, {
      action: outcome === 'CONSUMED' ? 'funding.consumed' : 'funding.released', entityType: 'trade', entityId: rows[0]!.trade_id,
      after: { use: use.kind, use_id: use.legId ?? use.routeSettlementId ?? use.chainSendId, allocations: rows.map((r) => r.id), amount: Money.ofMinor(rows.reduce((t, r) => t + r.amount_minor, 0n), rows[0]!.asset), reason },
    });
  }
  return rows.length;
}

/**
 * FI-77, delivery versus payment: the exchange hands client funds to the counterparty only once the counterparty
 * delivered — the whole route side of a TO_EXCHANGE obligation, or the client's payout of a DIRECT_TO_CLIENT one.
 * The database applies the same rule (IX087); this says so before anything is written.
 */
export async function assertCounterpartyDelivered(ex: Executor, obligationId: string): Promise<void> {
  const r = await sql<{ delivered: boolean }>`select inrp2p_counterparty_delivered(${requireUuid(obligationId, 'routeObligationId')}) as delivered`.execute(ex);
  if (!r.rows[0]?.delivered) {
    throw new DomainError('COUNTERPARTY_NOT_DELIVERED', 'the counterparty has not delivered its side yet: the exchange never pays it first (D-16)');
  }
}

/** What a trade's funding looks like, for the desk: each source with what is earmarked, and every earmark. */
export async function fundingPosition(ex: Executor, tradeId: string) {
  const sources = await fundingSources(ex, tradeId);
  const allocations = await ex
    .selectFrom('funding_allocation')
    .select(['id', 'source_kind', 'source_leg_id', 'source_route_settlement_id', 'use_kind', 'use_leg_id', 'use_route_settlement_id', 'use_chain_send_id', 'asset', 'amount_minor', 'location', 'status', 'created_at', 'closed_at', 'close_reason'])
    .where('trade_id', '=', requireUuid(tradeId, 'tradeId'))
    .orderBy('created_at')
    .execute();
  return { sources, allocations };
}
