import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { runAs } from '@inrp2p/identity/testing';
import {
  confirmPayout, createPayoutLeg, importBankStatement, listStatementImports, recordLegEvidence, runReconciliation, sendPayoutLeg, voidException,
} from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from './world.ts';

/**
 * Phase 8 exit: reconciliation opens exceptions idempotently.
 *
 * The statement import is the S7 control — the only thing in the system that checks the desk's own word against
 * the bank's. These tests are about what it does with a disagreement, and about what it does when the same
 * statement is imported twice by two people on the same morning.
 */
let w: World;
let tradeId = '';
const paid: { utr: string; amount: string }[] = [];

beforeAll(async () => {
  w = await createWorld('statements', { capacityInr: '500000000.00' });
  const trade = await openTrade(w, { baseUsdt: '1000', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });
  tradeId = trade.tradeId;
  await settleFirstLeg(w, tradeId);
  paid.push(await payLeg('50000.00'), await payLeg('40000.00'));
});
afterAll(async () => w.close());

async function payLeg(amount: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
  });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  const utr = newUtr();
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr });
  await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
  return { utr, amount };
}

const today = async (): Promise<string> => {
  const r = await sql<{ day: string }>`select to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day`.execute(w.app);
  return r.rows[0]!.day;
};

/** A statement file is evidence, so it is identified by its own bytes. */
const digestOf = (lines: readonly { reference: string; amount: string }[], salt = ''): string =>
  createHash('sha256').update(salt + lines.map((l) => `${l.reference}:${l.amount}`).join('|')).digest('hex');

async function importStatement(lines: readonly { reference: string; amount: string; direction?: 'CREDIT' | 'DEBIT' }[], opts: { salt?: string; filename?: string } = {}) {
  const day = await today();
  return runAs(w.app, importBankStatement(w.financeOp.actor), w.financeOp.ref, 'statement.import', {
    inrAccountId: w.inrAccountId,
    periodFrom: day,
    periodTo: day,
    filename: opts.filename ?? 'icici-statement.csv',
    sha256: digestOf(lines, opts.salt ?? ''),
    lines: lines.map((l) => ({ valueDate: day, direction: l.direction ?? ('DEBIT' as const), amount: l.amount, reference: l.reference })),
  });
}

const casesFor = async (reason: string) => {
  const rows = await w.t.owner
    .selectFrom('exception_case')
    .select(['id', 'subject_id', 'status'])
    .where('type', '=', 'RECONCILIATION_MISMATCH')
    .where(sql<boolean>`details ->> 'reason' = ${reason}`)
    .execute();
  return rows;
};

describe('what the bank says against what the desk said', () => {
  it('matches every payment the statement shows, and opens nothing', async () => {
    const out = await importStatement(paid.map((p) => ({ reference: p.utr, amount: p.amount })));
    expect(out).toMatchObject({ lines: 2, matched: 2, mismatched: 0, missing: 0, casesOpened: 0 });
    expect(await casesFor('NOT_IN_STATEMENT')).toHaveLength(0);
  });

  it('ignores the lines a real statement is full of, rather than burying the ones that matter', async () => {
    const out = await importStatement(
      [...paid.map((p) => ({ reference: p.utr, amount: p.amount })), { reference: 'BANKFEE0001', amount: '118.00' }, { reference: 'SWEEP00002', amount: '250000.00', direction: 'CREDIT' as const }],
      { salt: 'with-noise' },
    );
    expect(out).toMatchObject({ matched: 2, unrecorded: 2, mismatched: 0, casesOpened: 0 });
  });

  it('opens a blocking case when the bank moved a different amount', async () => {
    const out = await importStatement([{ reference: paid[0]!.utr, amount: '49000.00' }, { reference: paid[1]!.utr, amount: paid[1]!.amount }], { salt: 'short' });
    expect(out.mismatched).toBe(1);
    expect(out.casesOpened).toBe(1);
    const cases = await casesFor('STATEMENT_AMOUNT_DIFFERS');
    expect(cases).toHaveLength(1);
    // A blocking case is a hold: the trade stops until someone explains the difference.
    const trade = await w.app.selectFrom('trade').select('hold').where('id', '=', tradeId).executeTakeFirstOrThrow();
    expect(trade.hold).toBe(true);
    await resolveAll();
  });

  it('opens a blocking case for a payment the bank has never heard of (S7)', async () => {
    // The statement covers the period and shows only one of the two payments we recorded as confirmed.
    const out = await importStatement([{ reference: paid[0]!.utr, amount: paid[0]!.amount }], { salt: 'missing-one' });
    expect(out.missing).toBe(1);
    expect(out.casesOpened).toBe(1);
    const cases = await casesFor('NOT_IN_STATEMENT');
    expect(cases).toHaveLength(1);
    expect(cases[0]!.subject_id).toBeTruthy();
  });

  it('opens the same case once, however many times the statement is re-imported', async () => {
    const before = (await casesFor('NOT_IN_STATEMENT')).length;
    for (const salt of ['again-1', 'again-2', 'again-3']) {
      const out = await importStatement([{ reference: paid[0]!.utr, amount: paid[0]!.amount }], { salt });
      expect(out.missing).toBe(1);
      // The case already exists and is open; a repeat import finds it rather than opening a second one.
      expect(out.casesOpened).toBe(0);
    }
    expect(await casesFor('NOT_IN_STATEMENT')).toHaveLength(before);
    await resolveAll();
  });
});

describe('the import itself', () => {
  it('refuses the same file twice for the same account', async () => {
    const lines = [{ reference: paid[0]!.utr, amount: paid[0]!.amount }];
    await importStatement(lines, { salt: 'once-only' });
    await expect(importStatement(lines, { salt: 'once-only' })).rejects.toMatchObject({ code: 'DUPLICATE_STATEMENT' });
  });

  it('refuses a period that runs backwards, and a file with nothing in it', async () => {
    const day = await today();
    await expect(
      runAs(w.app, importBankStatement(w.financeOp.actor), w.financeOp.ref, 'statement.import', {
        inrAccountId: w.inrAccountId, periodFrom: day, periodTo: '2020-01-01', filename: 'x.csv', sha256: 'a'.repeat(64),
        lines: [{ valueDate: day, direction: 'DEBIT' as const, amount: '1.00', reference: 'X1' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      runAs(w.app, importBankStatement(w.financeOp.actor), w.financeOp.ref, 'statement.import', {
        inrAccountId: w.inrAccountId, periodFrom: day, periodTo: day, filename: 'x.csv', sha256: 'b'.repeat(64), lines: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('is evidence: the rows cannot be edited or removed afterwards', async () => {
    const imports = await listStatementImports(w.app);
    expect(imports.length).toBeGreaterThan(0);
    const id = imports[0]!.importId;
    await expect(sql`update bank_statement_import set matched = 0 where id = ${id}`.execute(w.t.owner)).rejects.toThrow();
    await expect(sql`delete from bank_statement_line where import_id = ${id}`.execute(w.t.owner)).rejects.toThrow();
  });

  it('records what was imported, with the file’s hash and not its contents', async () => {
    const event = await w.t.owner
      .selectFrom('audit_event')
      .select(['after'])
      .where('action', '=', 'statement.imported')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    const after = event.after as Record<string, unknown>;
    expect(after.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(after.lines).toBeDefined();
    expect(after.reference).toBeUndefined();
  });

  it('lists what has been imported, newest first', async () => {
    const imports = await listStatementImports(w.app, { limit: 5 });
    const times = imports.map((i) => Date.parse(i.importedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(imports[0]!.accountLabel.length).toBeGreaterThan(0);
  });
});

describe('the nightly job still says the ledger balances', () => {
  it('finds nothing to report when it does', async () => {
    await resolveAll();
    expect(await runReconciliation(w.t.worker)).toEqual({ routeMismatches: 0, currencyImbalances: [] });
  });
});

/**
 * Clears the cases these tests opened, the way an operator would. Not with SQL: `trade.hold` is enforced by a
 * database trigger against the open blocking cases, so the only thing that can close one is the command that
 * recomputes the hold with it.
 */
async function resolveAll(): Promise<void> {
  const open = await w.t.owner
    .selectFrom('exception_case')
    .select('id')
    .where('type', '=', 'RECONCILIATION_MISMATCH')
    .where('status', 'in', ['OPEN', 'IN_PROGRESS'])
    .execute();
  for (const c of open) {
    await runAs(w.app, voidException(w.financeOp.actor), w.financeOp.ref, 'exception.void', { exceptionId: c.id, reason: 'test cleanup' });
  }
}
