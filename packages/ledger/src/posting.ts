import { DomainError, Money } from '@inrp2p/kernel';
import { isUniqueViolation, type TxContext } from '@inrp2p/db';
import { type AccountRef, resolveAccountIds } from './accounts.ts';

export interface EntryInput {
  readonly account: AccountRef;
  readonly direction: 'DR' | 'CR';
  readonly amount: Money;
  readonly routeObligationId?: string | null;
}

export interface JournalInput {
  /** Unique business-event or movement key, e.g. `trade:{id}:accept`, `fiat:{id}:confirm` (FI-42). */
  readonly postingKey: string;
  readonly eventType: string;
  readonly tradeId?: string | null;
  readonly entries: readonly EntryInput[];
}

export interface PostedJournal {
  readonly id: string;
  readonly postingKey: string;
}

/** Application-side validation mirroring the database constraint trigger (FI-40). */
export function assertBalanced(entries: readonly EntryInput[]): void {
  if (entries.length < 2) throw new DomainError('EMPTY_JOURNAL', 'a journal needs at least two entries');
  const sums = new Map<string, bigint>();
  for (const e of entries) {
    if (!e.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'ledger entry amounts must be positive');
    if (e.amount.currency !== e.account.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `${e.account.code} is ${e.account.currency}, entry is ${e.amount.currency}`);
    }
    const signed = e.direction === 'DR' ? e.amount.minor : -e.amount.minor;
    sums.set(e.amount.currency, (sums.get(e.amount.currency) ?? 0n) + signed);
  }
  const unbalanced = [...sums.entries()].filter(([, v]) => v !== 0n).map(([c]) => c);
  if (unbalanced.length) throw new DomainError('UNBALANCED_JOURNAL', `unbalanced in ${unbalanced.join(', ')}`);
}

async function insertJournal(ctx: TxContext, input: JournalInput, reversesJournalId: string | null): Promise<PostedJournal> {
  if (!ctx.idempotencyKey) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'ledger postings are financial mutations');
  assertBalanced(input.entries);
  const ids = await resolveAccountIds(ctx, input.entries.map((e) => e.account));
  let journal: { id: string };
  try {
    journal = await ctx.tx
      .insertInto('ledger_journal')
      .values({
        posting_key: input.postingKey,
        event_type: input.eventType,
        trade_id: input.tradeId ?? null,
        correlation_id: ctx.correlationId,
        idempotency_key: ctx.idempotencyKey,
        posted_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
        reverses_journal_id: reversesJournalId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  } catch (e) {
    if (isUniqueViolation(e, 'ledger_journal_posting_key_key')) throw new DomainError('DUPLICATE_POSTING_KEY', input.postingKey);
    if (isUniqueViolation(e, 'ledger_journal_reverses_journal_id_key')) throw new DomainError('JOURNAL_ALREADY_REVERSED', String(reversesJournalId));
    throw e;
  }
  await ctx.tx
    .insertInto('ledger_entry')
    .values(
      input.entries.map((e) => ({
        journal_id: journal.id,
        account_id: ids.get(`${e.account.code}|${e.account.currency}`)!,
        currency: e.amount.currency,
        direction: e.direction,
        amount_minor: e.amount.minor,
        trade_id: input.tradeId ?? null,
        route_obligation_id: e.routeObligationId ?? null,
      })),
    )
    .execute();
  return { id: journal.id, postingKey: input.postingKey };
}

/** Posts one balanced journal inside the command transaction. Balance is re-checked by the database at commit. */
export function postJournal(ctx: TxContext, input: JournalInput): Promise<PostedJournal> {
  return insertJournal(ctx, input, null);
}

/**
 * Posts the exact mirror of an existing journal (compensating entries, FI-12). A journal can be
 * reversed at most once and a reversal cannot itself be reversed; the database verifies the mirror.
 */
export async function reverseJournal(ctx: TxContext, args: { originalPostingKey: string; postingKey: string; eventType: string }): Promise<PostedJournal> {
  const original = await ctx.tx
    .selectFrom('ledger_journal')
    .select(['id', 'trade_id', 'reverses_journal_id'])
    .where('posting_key', '=', args.originalPostingKey)
    .executeTakeFirst();
  // No row lock (journals are append-only): concurrent reversals are serialized by the unique
  // constraint on reverses_journal_id.
  if (!original) throw new DomainError('JOURNAL_NOT_FOUND', args.originalPostingKey);
  if (original.reverses_journal_id) throw new DomainError('REVERSAL_OF_REVERSAL', args.originalPostingKey);
  const already = await ctx.tx.selectFrom('ledger_journal').select('id').where('reverses_journal_id', '=', original.id).executeTakeFirst();
  if (already) throw new DomainError('JOURNAL_ALREADY_REVERSED', args.originalPostingKey);

  const rows = await ctx.tx
    .selectFrom('ledger_entry as e')
    .innerJoin('ledger_account as a', 'a.id', 'e.account_id')
    .select(['a.code', 'a.type', 'e.currency', 'e.direction', 'e.amount_minor', 'e.route_obligation_id'])
    .where('e.journal_id', '=', original.id)
    .orderBy('e.id')
    .execute();
  const entries: EntryInput[] = rows.map((r) => ({
    account: { code: r.code, type: r.type, currency: r.currency as 'INR' | 'USDT' },
    direction: r.direction === 'DR' ? 'CR' : 'DR',
    amount: Money.ofMinor(r.amount_minor, r.currency as 'INR' | 'USDT'),
    routeObligationId: r.route_obligation_id,
  }));
  return insertJournal(ctx, { postingKey: args.postingKey, eventType: args.eventType, tradeId: original.trade_id, entries }, original.id);
}
