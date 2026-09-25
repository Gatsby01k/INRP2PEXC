import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor, StatementLineOutcome } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { openExceptionInTx } from './exceptions.ts';

/**
 * Manual bank statement import (SECURITY §5 S7).
 *
 * The control this implements is narrow and worth stating plainly: everything else in the payout path proves
 * that an **operator** said a payment was made — uniqueness on the UTR, the evidence they attached, the
 * authenticator they had to produce. None of that proves the **bank** moved the money. Only the bank's own
 * statement does, and V1 gets it by hand because there is no bank API yet.
 *
 * So the import asks two questions, and the second one is the one that matters:
 *
 *   1. For each line in the statement, is there a payment we recorded with that reference, for that amount?
 *      A different amount is a `MISMATCHED` line and opens a case. A line we never recorded is `UNRECORDED` and
 *      does not — a real statement is full of fees, sweeps and transfers this system never made, and opening a
 *      case for each would bury the ones that matter.
 *   2. For each payment we recorded as confirmed in the period, on that account, does the statement show it?
 *      A payment the bank has never heard of is the fake-UTR case, and it opens a blocking case against the
 *      transfer — which puts its trade on hold until someone explains it.
 */
export interface StatementLineInput {
  readonly valueDate: string;
  readonly direction: 'CREDIT' | 'DEBIT';
  /** Decimal INR, as the statement prints it. */
  readonly amount: string;
  readonly reference: string;
  readonly description?: string | null;
}

export interface ImportStatementPayload {
  readonly inrAccountId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly filename: string;
  /** sha256 of the uploaded bytes, computed at the edge. The same file is the same evidence, not new evidence. */
  readonly sha256: string;
  readonly lines: readonly StatementLineInput[];
}

export interface StatementImportResult {
  readonly importId: string;
  readonly lines: number;
  readonly matched: number;
  readonly mismatched: number;
  readonly unrecorded: number;
  /** Confirmed payments in the period that the statement does not show. Each one opened a blocking case. */
  readonly missing: number;
  readonly casesOpened: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINES = 5000;

/**
 * `statement.import` — `statement:import` (⧗). One transaction: the file, its lines, their outcomes and every
 * case they open. A half-imported statement would be worse than none, because the missing half would look
 * reconciled.
 */
export function importBankStatement(actor: OperatorActor) {
  return operatorCommand(actor, 'statement:import', async (ctx, p: ImportStatementPayload): Promise<StatementImportResult> => {
    const accountId = requireUuid(p.inrAccountId, 'inrAccountId');
    const from = requireDay(p.periodFrom, 'periodFrom');
    const to = requireDay(p.periodTo, 'periodTo');
    if (from > to) throw new DomainError('INVALID_ARGUMENT', 'statement period starts after it ends');
    const filename = requireText(p.filename, 'filename', 200);
    const digest = requireText(p.sha256, 'sha256', 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new DomainError('INVALID_ARGUMENT', 'sha256 must be 64 hex characters');
    if (!Array.isArray(p.lines) || p.lines.length === 0) throw new DomainError('INVALID_ARGUMENT', 'a statement with no lines reconciles nothing');
    if (p.lines.length > MAX_LINES) throw new DomainError('INVALID_ARGUMENT', `a statement may carry at most ${MAX_LINES} lines`);

    const account = await ctx.tx.selectFrom('inr_settlement_account').select(['id', 'label']).where('id', '=', accountId).executeTakeFirst();
    if (!account) throw new DomainError('NOT_FOUND', 'INR settlement account not found');

    const already = await ctx.tx.selectFrom('bank_statement_import').select('id').where('inr_account_id', '=', accountId).where('sha256', '=', digest).executeTakeFirst();
    if (already) throw new DomainError('DUPLICATE_STATEMENT', 'this statement file has already been imported for this account', { importId: already.id });

    const lines = p.lines.map((line, i) => readLine(line, i));
    const counts: Record<StatementLineOutcome, number> = { MATCHED: 0, MISMATCHED: 0, UNRECORDED: 0 };

    // Resolved before anything is written, so the import row can be inserted with its final counts and stay
    // genuinely immutable. Evidence that gets updated after the fact is evidence with a gap in it.
    // A reference is matched the way FI-22 makes it unique — trimmed and upper-cased — and only against movements
    // that went through this account, in the direction the statement says. The operator may have typed the UTR in
    // lower case; the bank prints it in upper case; both are the same payment.
    const resolved = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const transfer = await ctx.tx
        .selectFrom('fiat_transfer')
        .select(['id', 'amount_minor', 'payer_type', 'payer_id'])
        .where(sql<boolean>`upper(btrim(utr)) = ${line.reference}`)
        .where((eb) => eb.or([
          eb.and([eb('payer_type', '=', 'EXCHANGE_ACCOUNT'), eb('payer_id', '=', accountId)]),
          eb.and([eb('payee_type', '=', 'EXCHANGE_ACCOUNT'), eb('payee_id', '=', accountId)]),
        ]))
        .orderBy('recorded_at')
        .executeTakeFirst();
      const expectedDirection = transfer && transfer.payer_type === 'EXCHANGE_ACCOUNT' && transfer.payer_id === accountId ? 'DEBIT' : 'CREDIT';
      const outcome: StatementLineOutcome = !transfer
        ? 'UNRECORDED'
        : transfer.amount_minor === line.amount.minor && line.direction === expectedDirection ? 'MATCHED' : 'MISMATCHED';
      counts[outcome] += 1;
      if (transfer) seen.add(transfer.id);
      resolved.push({ line, outcome, transfer: transfer ?? null, expectedDirection });
    }

    // The second question: what did we say moved through this account that the bank has never heard of? Every
    // confirmed movement counts — payouts and refunds out, the client's INR in, route settlements both ways. The
    // incoming client payment matters most: a fake UTR there is how USDT would be released for rupees that never came.
    const recorded = await sql<{ id: string; utr: string; amount_minor: bigint }>`
      select f.id, f.utr, f.amount_minor
      from fiat_transfer f
      where f.status = 'CONFIRMED'
        and ((f.payer_type = 'EXCHANGE_ACCOUNT' and f.payer_id = ${accountId}) or (f.payee_type = 'EXCHANGE_ACCOUNT' and f.payee_id = ${accountId}))
        and (f.confirmed_at AT TIME ZONE 'Asia/Kolkata')::date between ${from}::date and ${to}::date
      order by f.id`.execute(ctx.tx);
    const absent = recorded.rows.filter((r) => !seen.has(r.id));

    const importRow = await ctx.tx
      .insertInto('bank_statement_import')
      .values({
        inr_account_id: accountId, period_from: from, period_to: to, filename, sha256: digest,
        line_count: lines.length, matched: counts.MATCHED, mismatched: counts.MISMATCHED, unrecorded: counts.UNRECORDED,
        missing: absent.length, imported_by: actorLabel(ctx),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    let casesOpened = 0;
    for (const { line, outcome, transfer, expectedDirection } of resolved) {
      await ctx.tx
        .insertInto('bank_statement_line')
        .values({
          import_id: importRow.id, seq: line.seq, value_date: line.valueDate, direction: line.direction,
          amount_minor: line.amount.minor, reference: line.reference, description: line.description,
          outcome, fiat_transfer_id: transfer?.id ?? null,
        })
        .execute();
      if (outcome !== 'MISMATCHED' || !transfer) continue;
      const opened = await openExceptionInTx(ctx, {
        type: 'RECONCILIATION_MISMATCH', subjectType: 'FIAT_TRANSFER', subjectId: transfer.id,
        tradeId: await tradeOfTransfer(ctx.tx, transfer.id), detectedBy: 'SYSTEM',
        details: {
          reason: line.direction === expectedDirection ? 'STATEMENT_AMOUNT_DIFFERS' : 'STATEMENT_DIRECTION_DIFFERS', reference: line.reference,
          recorded: Money.ofMinor(transfer.amount_minor, 'INR').toDecimalString(), statement: line.amount.toDecimalString(),
          recorded_direction: expectedDirection, statement_direction: line.direction,
        },
      });
      if (opened.opened) casesOpened += 1;
    }

    for (const row of absent) {
      const opened = await openExceptionInTx(ctx, {
        type: 'RECONCILIATION_MISMATCH', subjectType: 'FIAT_TRANSFER', subjectId: row.id,
        tradeId: await tradeOfTransfer(ctx.tx, row.id), detectedBy: 'SYSTEM',
        details: { reason: 'NOT_IN_STATEMENT', reference: row.utr, recorded: Money.ofMinor(row.amount_minor, 'INR').toDecimalString(), statement_from: from, statement_to: to },
      });
      if (opened.opened) casesOpened += 1;
    }
    const missing = absent.length;

    await appendAudit(ctx, {
      action: 'statement.imported', entityType: 'bank_statement_import', entityId: importRow.id,
      after: {
        inr_account_id: accountId, account: account.label, period_from: from, period_to: to, filename, sha256: digest,
        lines: lines.length, matched: counts.MATCHED, mismatched: counts.MISMATCHED, unrecorded: counts.UNRECORDED, missing, cases_opened: casesOpened,
      },
    });

    return { importId: importRow.id, lines: lines.length, matched: counts.MATCHED, mismatched: counts.MISMATCHED, unrecorded: counts.UNRECORDED, missing, casesOpened };
  });
}

async function tradeOfTransfer(ex: Executor, fiatTransferId: string): Promise<string | null> {
  const row = await ex
    .selectFrom('transfer_allocation as a')
    .innerJoin('settlement_leg as l', 'l.id', 'a.settlement_leg_id')
    .select('l.trade_id')
    .where('a.fiat_transfer_id', '=', fiatTransferId)
    .where('a.voided_at', 'is', null)
    .executeTakeFirst();
  return row?.trade_id ?? null;
}

function requireDay(value: unknown, field: string): string {
  const day = requireText(value, field, 10);
  if (!DAY.test(day)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an IST day as YYYY-MM-DD`);
  return day;
}

function readLine(line: StatementLineInput, index: number): {
  seq: number; valueDate: string; direction: 'CREDIT' | 'DEBIT'; amount: Money<'INR'>; reference: string; description: string | null;
} {
  const seq = index + 1;
  const amount = Money.parse(line.amount, 'INR');
  if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', `statement line ${seq} has a non-positive amount; direction carries the sign`);
  return {
    seq,
    valueDate: requireDay(line.valueDate, `lines[${index}].valueDate`),
    direction: requireOneOf(line.direction, `lines[${index}].direction`, ['CREDIT', 'DEBIT'] as const),
    amount,
    reference: requireText(line.reference, `lines[${index}].reference`, 40).trim().toUpperCase(),
    description: line.description ? requireText(line.description, `lines[${index}].description`, 300) : null,
  };
}

const CSV_COLUMNS = ['value_date', 'direction', 'amount', 'reference', 'description'] as const;

/**
 * Read an exported bank statement (RFC 4180) into lines the import can take.
 *
 * Parsing lives here rather than in the browser because the file is evidence: whatever the operator uploaded is
 * what gets hashed and what gets read, and a field the page rewrote on the way would break that. The shape is
 * deliberately fixed — `value_date,direction,amount,reference,description` — because every bank exports a
 * different statement, and V1's honest position is that a human maps it once rather than that we guess.
 *
 * Nothing is validated beyond the shape: `importBankStatement` is the authority on what a line may say, and a
 * parser that also judged would be a second, quieter set of rules.
 */
export function parseStatementCsv(text: string): readonly StatementLineInput[] {
  const rows = readCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length === 0) throw new DomainError('INVALID_ARGUMENT', 'the statement file is empty');
  const header = (rows[0] ?? []).map((c) => c.trim().toLowerCase().replace(/\s+/g, '_'));
  const missing = CSV_COLUMNS.filter((c) => c !== 'description' && !header.includes(c));
  if (missing.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', `the statement file must have a header row with ${CSV_COLUMNS.join(', ')}; missing: ${missing.join(', ')}`);
  }
  const at = (row: readonly string[], column: (typeof CSV_COLUMNS)[number]): string => (row[header.indexOf(column)] ?? '').trim();
  return rows.slice(1).map((row) => {
    const description = header.includes('description') ? at(row, 'description') : '';
    return {
      valueDate: at(row, 'value_date'),
      direction: at(row, 'direction').toUpperCase() as 'CREDIT' | 'DEBIT',
      amount: at(row, 'amount').replace(/[,\s₹]/g, ''),
      reference: at(row, 'reference'),
      description: description === '' ? null : description,
    };
  });
}

/** The reader that matches the writer in `@inrp2p/reporting`: quoted fields, doubled quotes, CR or CRLF. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // The writer's formula guard (a leading tab) is the reader's to remove, so a round trip is the identity.
  return rows.map((r) => r.map((c) => (c.startsWith('\t') ? c.slice(1) : c)));
}

export interface StatementImportSummary {
  readonly importId: string;
  readonly accountLabel: string;
  readonly filename: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly lines: number;
  readonly matched: number;
  readonly mismatched: number;
  readonly unrecorded: number;
  readonly missing: number;
  readonly importedAt: string;
  readonly importedBy: string;
}

/** The statements imported for the desk's INR screen, newest first. */
export async function listStatementImports(ex: Executor, opts: { limit?: number } = {}): Promise<readonly StatementImportSummary[]> {
  const rows = await ex
    .selectFrom('bank_statement_import as s')
    .innerJoin('inr_settlement_account as a', 'a.id', 's.inr_account_id')
    .select(['s.id', 'a.label', 's.filename', 's.period_from', 's.period_to', 's.line_count', 's.matched', 's.mismatched', 's.unrecorded', 's.missing', 's.imported_at', 's.imported_by'])
    .orderBy('s.imported_at', 'desc')
    .orderBy('s.id', 'desc')
    .limit(Math.min(opts.limit ?? 20, 100))
    .execute();
  return rows.map((r) => ({
    importId: r.id,
    accountLabel: r.label,
    filename: r.filename,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    lines: r.line_count,
    matched: r.matched,
    mismatched: r.mismatched,
    unrecorded: r.unrecorded,
    missing: r.missing,
    importedAt: r.imported_at.toISOString(),
    importedBy: r.imported_by,
  }));
}
