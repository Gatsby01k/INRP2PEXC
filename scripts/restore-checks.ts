import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import { verifyAuditSeals } from '@inrp2p/audit';

/**
 * The questions a restored database has to answer before anyone trusts it (launch checklist).
 *
 * These are deliberately not "did pg_restore exit zero". A restore can exit zero and still be useless: a dump
 * taken without a consistent snapshot can tear one transaction's rows from another's, and the place that shows
 * is the ledger and the audit chain — the two structures in this system that are *supposed* to be impossible to
 * half-write.
 *
 * They are separated from the drill script so they can be tested, which matters more than usual here: a check
 * that silently passes on a corrupted restore is worse than no check, because it is the thing standing between
 * a bad backup and the decision to rely on it. `test/integration/restore-check.int.test.ts` corrupts a database
 * in each of these ways and asserts every one of them is caught.
 */
export interface RestoreCounts {
  readonly migration: string;
  readonly trades: string;
  readonly journals: string;
  readonly entries: string;
  readonly auditEvents: string;
  readonly auditSeals: string;
}

export async function restoreCounts(db: Db): Promise<RestoreCounts> {
  const r = await sql<RestoreCounts>`
    select (select max(version) from schema_migration)::text as migration,
           (select count(*) from trade)::text as trades,
           (select count(*) from ledger_journal)::text as journals,
           (select count(*) from ledger_entry)::text as entries,
           (select count(*) from audit_event)::text as "auditEvents",
           (select count(*) from audit_seal)::text as "auditSeals"`.execute(db);
  return r.rows[0]!;
}

/** Every difference between two count sets, named the way a person reading a drill log needs them named. */
export function countDifferences(before: RestoreCounts, after: RestoreCounts): string[] {
  const keys: (keyof RestoreCounts)[] = ['migration', 'trades', 'journals', 'entries', 'auditEvents', 'auditSeals'];
  return keys.filter((k) => before[k] !== after[k]).map((k) => `${k} differs: source ${before[k]}, restore ${after[k]}`);
}

/**
 * Structural checks on the restored copy itself. Returns the problems it found, empty when there are none —
 * a list rather than a boolean, because "the restore is bad" is not actionable and "the audit chain breaks at
 * seal 41" is.
 */
export async function restoreProblems(db: Db): Promise<string[]> {
  const problems: string[] = [];

  const imbalance = await db.selectFrom('ledger_global_imbalance').selectAll().execute();
  // Amounts come back as bigint, which `JSON.stringify` refuses outright — and a check that throws while
  // reporting a problem reports nothing at all.
  if (imbalance.length > 0) {
    problems.push(`the ledger does not net to zero: ${imbalance.map((row) => Object.entries(row).map(([k, v]) => `${k}=${String(v)}`).join(' ')).join('; ')}`);
  }

  const unbalanced = await sql<{ posting_key: string }>`
    select j.posting_key from ledger_journal j
    join ledger_entry e on e.journal_id = j.id
    group by j.posting_key, e.currency
    having sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) <> 0`.execute(db);
  if (unbalanced.rows.length > 0) {
    problems.push(`${unbalanced.rows.length} journal(s) do not balance, first: ${unbalanced.rows[0]!.posting_key}`);
  }

  const seals = await verifyAuditSeals(db);
  if (!seals.ok) problems.push(`the audit seal chain breaks at seal ${seals.firstInvalidSealId}`);

  // A completed trade must still be fully settled. A torn dump shows up here as a trade that says it is done
  // and cannot prove it.
  const halfSettled = await sql<{ id: string }>`
    select t.id from trade t
    where t.lifecycle_state = 'COMPLETED'
      and coalesce((select sum(amount_minor) from settlement_leg
                    where trade_id = t.id and side = 'EXCHANGE_TO_CLIENT' and status = 'COMPLETED'), 0)
          <> inrp2p_trade_payout_obligation(t.id)`.execute(db);
  if (halfSettled.rows.length > 0) problems.push(`${halfSettled.rows.length} completed trade(s) are not fully settled, first: ${halfSettled.rows[0]!.id}`);

  return problems;
}
