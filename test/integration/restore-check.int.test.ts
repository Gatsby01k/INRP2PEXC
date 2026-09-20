import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { appendAudit, sealAudit } from '@inrp2p/audit';
import { Accounts, postJournal } from '@inrp2p/ledger';
import { countDifferences, restoreCounts, restoreProblems } from '../../scripts/restore-checks.ts';
import { inCommand } from './support.ts';

/**
 * The checks the backup drill runs on a restored database (launch checklist).
 *
 * The drill itself needs `pg_dump`, a second database and several minutes; what actually has to be right is
 * what it *asks* of the restore. A check that passes on a corrupted copy is worse than no check at all, because
 * it is the thing standing between a bad backup and the decision to rely on it. So each check is held against a
 * database corrupted in exactly the way it exists to catch.
 *
 * The corruption is done as the **owner**, with triggers stood down where necessary: the application role
 * cannot do any of this, which is the point of those grants. A restore can still arrive in this state, because
 * a dump does not replay a transaction — it copies rows.
 */
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('restore_check');
  // A little real history: one balanced journal and a sealed audit range.
  const client = randomUUID();
  await inCommand(t.app, 'restore_check.fixture', async (ctx) => {
    await appendAudit(ctx, { action: 'settings.threshold_changed', entityType: 'settings', entityId: randomUUID(), after: { drill: true } });
    await postJournal(ctx, {
      postingKey: `restore_check:${randomUUID()}`,
      eventType: 'restore_check.fixture',
      entries: [
        { account: Accounts.suspenseUnallocated('INR'), direction: 'DR', amount: Money.parse('100.00', 'INR') },
        { account: Accounts.clientPayable(client, 'INR'), direction: 'CR', amount: Money.parse('100.00', 'INR') },
      ],
    });
  });
  await sealAudit(t.owner, { settleSeconds: 0 });
}, 180_000);
afterAll(async () => t.close());

describe('a healthy database', () => {
  it('reports no problems at all', async () => {
    expect(await restoreProblems(t.app)).toEqual([]);
  });

  it('counts what a drill compares', async () => {
    // As the migrator, which is the role a drill runs with: `schema_migration` is deliberately not readable by
    // the application, and the migration number is the first thing a restore has to match.
    const counts = await restoreCounts(t.owner);
    expect(Number(counts.migration)).toBeGreaterThan(0);
    expect(Number(counts.journals)).toBeGreaterThanOrEqual(1);
    expect(Number(counts.auditEvents)).toBeGreaterThanOrEqual(1);
    expect(Number(counts.auditSeals)).toBeGreaterThanOrEqual(1);
  });

  it('calls a restore with different counts out, field by field', () => {
    const before = { migration: '19', trades: '5', journals: '9', entries: '18', auditEvents: '40', auditSeals: '2' };
    expect(countDifferences(before, before)).toEqual([]);
    expect(countDifferences(before, { ...before, trades: '4', auditEvents: '39' })).toEqual([
      'trades differs: source 5, restore 4',
      'auditEvents differs: source 40, restore 39',
    ]);
  });
});

describe('a database corrupted the way a torn dump corrupts one', () => {
  it('catches a journal whose other half is missing', async () => {
    const line = await sql<{ id: string }>`
      select e.id from ledger_entry e join ledger_journal j on j.id = e.journal_id
      where j.posting_key like 'restore_check:%' and e.direction = 'CR' limit 1`.execute(t.owner);
    await sql`set session_replication_role = replica`.execute(t.owner);
    try {
      await sql`delete from ledger_entry where id = ${line.rows[0]!.id}`.execute(t.owner);
      const problems = await restoreProblems(t.app);
      expect(problems.some((p) => p.includes('do not balance'))).toBe(true);
      // The global check sees it too: the two are different queries and a restore can fail either one.
      expect(problems.some((p) => p.includes('does not net to zero'))).toBe(true);
    } finally {
      await sql`set session_replication_role = origin`.execute(t.owner);
    }
  });

  it('catches an audit event that went missing from a sealed range', async () => {
    // Put the ledger back first, so this test fails only for its own reason.
    await sql`set session_replication_role = replica`.execute(t.owner);
    try {
      await sql`delete from ledger_entry where journal_id in (select id from ledger_journal where posting_key like 'restore_check:%')`.execute(t.owner);
      await sql`delete from ledger_journal where posting_key like 'restore_check:%'`.execute(t.owner);
      expect(await restoreProblems(t.app)).toEqual([]);

      const event = await sql<{ seq: string }>`select seq::text as seq from audit_event order by seq desc limit 1`.execute(t.owner);
      await sql`delete from audit_event where seq = ${event.rows[0]!.seq}::bigint`.execute(t.owner);
      const problems = await restoreProblems(t.app);
      expect(problems.some((p) => p.includes('audit seal chain breaks'))).toBe(true);
    } finally {
      await sql`set session_replication_role = origin`.execute(t.owner);
    }
  });
});
