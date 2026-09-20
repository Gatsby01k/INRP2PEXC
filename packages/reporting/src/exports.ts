import { sql } from 'kysely';
import { DomainError, Money, Rate } from '@inrp2p/kernel';
import type { Db, Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { executeCommand } from '@inrp2p/commands';
import { sha256 } from './canonical.ts';
import { csvDocument } from './csv.ts';

/**
 * Finance exports (PRODUCT §4 FINANCE, SECURITY §8 `export.generated`).
 *
 * An export is a **statement about a period**, so two things matter more than the columns. It is bounded by
 * explicit IST days, because "everything" is not a period and a finance file without one cannot be reconciled
 * against anything. And every generation is audited with the row count and a hash of the bytes — so if two
 * people hold files that disagree, the audit trail says which one this system produced.
 *
 * Amounts are ungrouped decimal strings (D-11): these files are read by machines and by spreadsheets, and a
 * thousands separator is how a column silently becomes text.
 */
export interface ExportPeriod {
  /** Inclusive IST day boundaries, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
}

export type ExportKind = 'trades' | 'ledger' | 'receipts';

export interface ExportResult {
  readonly kind: ExportKind;
  readonly period: ExportPeriod;
  readonly filename: string;
  readonly contentType: 'text/csv';
  readonly body: string;
  readonly rows: number;
  readonly sha256: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function requirePeriod(period: ExportPeriod): ExportPeriod {
  if (!DAY.test(period.from) || !DAY.test(period.to)) throw new DomainError('INVALID_ARGUMENT', 'export period must be two YYYY-MM-DD IST days');
  if (period.from > period.to) throw new DomainError('INVALID_ARGUMENT', 'export period starts after it ends');
  return period;
}

const TRADE_COLUMNS = [
  'trade_ref', 'client', 'direction', 'status', 'opened_at', 'completed_at', 'usdt', 'inr', 'client_rate',
  'route_rate', 'gross_margin_inr', 'realized',
] as const;

/**
 * Every trade that opened in the period, with the economics it was frozen with. `realized` says whether the
 * margin is money the ledger has recognised or a figure still expected — they are never added together, and an
 * export that let a reader do it by accident would be the easiest way to overstate revenue (FI §4).
 */
export async function exportTrades(ex: Executor, period: ExportPeriod): Promise<ExportResult> {
  const p = requirePeriod(period);
  const rows = await sql<{
    ref: string; display_name: string; direction: string; lifecycle_state: string; opened_at: Date; completed_at: Date | null;
    base_minor: bigint; quote_inr_minor: bigint; client_rate_micro: bigint; route_rate_micro: bigint; gross_margin_inr_minor: bigint;
  }>`
    select t.ref, c.display_name, t.direction, t.lifecycle_state, t.opened_at, t.completed_at,
           e.base_minor, e.quote_inr_minor, e.client_rate_micro, e.route_rate_micro, e.gross_margin_inr_minor
    from trade t
    join trade_economics e on e.trade_id = t.id
    join client c on c.id = t.client_id
    where (t.opened_at AT TIME ZONE 'Asia/Kolkata')::date between ${p.from}::date and ${p.to}::date
    order by t.opened_at, t.ref`.execute(ex);

  const body = csvDocument(
    TRADE_COLUMNS,
    rows.rows.map((r) => [
      r.ref,
      r.display_name,
      r.direction,
      r.lifecycle_state,
      r.opened_at.toISOString(),
      r.completed_at ? r.completed_at.toISOString() : '',
      Money.ofMinor(r.base_minor, 'USDT').toDecimalString(),
      Money.ofMinor(r.quote_inr_minor, 'INR').toDecimalString(),
      Rate.ofMicro(r.client_rate_micro, 'CLIENT').toDecimalString(),
      Rate.ofMicro(r.route_rate_micro, 'ROUTE').toDecimalString(),
      Money.ofMinor(r.gross_margin_inr_minor, 'INR').toDecimalString(),
      r.lifecycle_state === 'COMPLETED' ? 'realized' : 'expected',
    ]),
  );
  return result('trades', p, body, rows.rows.length);
}

const LEDGER_COLUMNS = ['posted_at', 'journal', 'posting_key', 'event', 'trade_ref', 'account', 'currency', 'direction', 'amount'] as const;

/**
 * Every ledger entry posted in the period, in posting order. This is the file a bookkeeper reconciles against,
 * so it carries the posting key: two exports of the same period are the same rows, and a line that appears
 * twice is the same line, not two postings.
 */
export async function exportLedger(ex: Executor, period: ExportPeriod): Promise<ExportResult> {
  const p = requirePeriod(period);
  const rows = await sql<{
    posted_at: Date; journal_id: string; posting_key: string; event_type: string; ref: string | null;
    code: string; currency: string; direction: 'DR' | 'CR'; amount_minor: bigint;
  }>`
    select j.posted_at, j.id as journal_id, j.posting_key, j.event_type, t.ref,
           a.code, e.currency, e.direction, e.amount_minor
    from ledger_entry e
    join ledger_journal j on j.id = e.journal_id
    join ledger_account a on a.id = e.account_id
    left join trade t on t.id = e.trade_id
    where (j.posted_at AT TIME ZONE 'Asia/Kolkata')::date between ${p.from}::date and ${p.to}::date
    order by j.posted_at, j.id, e.id`.execute(ex);

  const body = csvDocument(
    LEDGER_COLUMNS,
    rows.rows.map((r) => [
      r.posted_at.toISOString(),
      r.journal_id,
      r.posting_key,
      r.event_type,
      r.ref ?? '',
      r.code,
      r.currency,
      r.direction,
      Money.ofMinor(r.amount_minor, r.currency as 'INR' | 'USDT').toDecimalString(),
    ]),
  );
  return result('ledger', p, body, rows.rows.length);
}

const RECEIPT_COLUMNS = ['trade_ref', 'version', 'generated_at', 'sha256', 'json_sha256', 'csv_sha256', 'html_sha256'] as const;

/**
 * The receipts issued in the period, by hash. Not the documents — the evidence that a given document is the one
 * this system issued, which is what an auditor holding a client's copy actually needs.
 */
export async function exportReceipts(ex: Executor, period: ExportPeriod): Promise<ExportResult> {
  const p = requirePeriod(period);
  const rows = await sql<{ ref: string; version: number; generated_at: Date; sha256: string; json_sha256: string; csv_sha256: string; html_sha256: string }>`
    select t.ref, r.version, r.generated_at, r.sha256, r.json_sha256, r.csv_sha256, r.html_sha256
    from receipt r join trade t on t.id = r.trade_id
    where (r.generated_at AT TIME ZONE 'Asia/Kolkata')::date between ${p.from}::date and ${p.to}::date
    order by r.generated_at, t.ref, r.version`.execute(ex);

  const body = csvDocument(
    RECEIPT_COLUMNS,
    rows.rows.map((r) => [r.ref, String(r.version), r.generated_at.toISOString(), r.sha256, r.json_sha256, r.csv_sha256, r.html_sha256]),
  );
  return result('receipts', p, body, rows.rows.length);
}

const EXPORTS = { trades: exportTrades, ledger: exportLedger, receipts: exportReceipts } as const;

function result(kind: ExportKind, period: ExportPeriod, body: string, rows: number): ExportResult {
  return {
    kind,
    period,
    filename: `inrp2p-${kind}-${period.from}-to-${period.to}.csv`,
    contentType: 'text/csv',
    body,
    rows,
    sha256: sha256(body),
  };
}

/**
 * Generates an export and records that it happened (SECURITY §8 `export.generated`).
 *
 * The audit event carries the period, the row count and the hash — never the file. Who pulled what, when, and
 * whether the bytes they are holding are the bytes this system produced: that is the whole question an export
 * audit has to answer, and the file itself would only make the trail expensive and leak into it.
 */
export async function generateExport(
  db: Db,
  actor: { readonly type: 'USER' | 'SYSTEM'; readonly id: string | null; readonly surface: 'OPERATOR' | 'SYSTEM'; readonly sessionId?: string },
  input: { kind: ExportKind; period: ExportPeriod },
): Promise<ExportResult> {
  const build = EXPORTS[input.kind];
  if (!build) throw new DomainError('INVALID_ARGUMENT', `unknown export ${String(input.kind)}`);
  const out = await build(db, input.period);
  await executeCommand(
    db,
    {
      authorize: async () => {},
      handle: async (ctx) => {
        await appendAudit(ctx, {
          action: 'export.generated', entityType: 'export', entityId: null,
          after: { kind: out.kind, from: out.period.from, to: out.period.to, rows: out.rows, sha256: out.sha256, filename: out.filename },
        });
      },
    },
    { name: 'export.generate', actor, payload: { kind: input.kind, ...input.period }, financial: false },
  );
  return out;
}
