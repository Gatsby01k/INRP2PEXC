'use client';

import { useRef, useState } from 'react';
import type { InrAccountView } from '@inrp2p/desk';
import type { StatementImportResult, StatementImportSummary } from '@inrp2p/settlement';
import { Button, EmptyState, StepUpMark, TradeTable, formatIstDateTime } from '@inrp2p/ui';
import { importStatementAction } from '../../../server/actions/finance.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import styles from './inr.module.css';

interface Picked {
  readonly filename: string;
  readonly csv: string;
}

/**
 * Manual bank statement reconciliation (SECURITY §5 S7).
 *
 * Everything else in the payout path proves an operator said a payment was made. Only the bank's own statement
 * proves the bank moved it, and until there is a bank API a person brings that file here. The screen says what
 * the import found in the four words that matter — matched, mismatched, unrecorded, missing — and it is the
 * last one that opens cases: a payment we confirmed that the bank has never heard of.
 */
export function StatementImport({
  accounts,
  statements,
  canImport,
}: {
  accounts: readonly InrAccountView[];
  statements: readonly StatementImportSummary[];
  canImport: boolean;
}) {
  const cmd = useCommand();
  const fileInput = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  // The period starts empty rather than on today. A statement is almost never for today — it is for yesterday,
  // or last week, or the month that just closed — and a date the screen guessed is a date nobody checked. The
  // period is what everything in the import is judged against, so the operator states it.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [outcome, setOutcome] = useState<StatementImportResult | null>(null);

  const submit = () => {
    if (!picked || !accountId) return;
    setOutcome(null);
    void cmd
      .run(`Import ${picked.filename}`, (k) => importStatementAction({ accountId, periodFrom: from, periodTo: to, filename: picked.filename, csv: picked.csv }, k))
      .then((out) => {
        if (out.ok) {
          setOutcome(out.result);
          setPicked(null);
        }
        return out;
      });
  };

  return (
    <section className="ix-card" data-testid="statement-import">
      <h2 className="ix-sectionTitle">Bank statement</h2>
      <p className="ix-muted">
        Reconciles what the bank says it moved against what this desk recorded. A payment we confirmed that the statement does not show opens a
        blocking case on its trade.
      </p>

      {canImport ? (
        <div className={styles.statementForm}>
          <div className="ix-field">
            <label htmlFor="statement-account">Account</label>
            <select id="statement-account" className="ix-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.bankName} · {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ix-field">
            <label htmlFor="statement-from">Period from</label>
            <input id="statement-from" className="ix-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="ix-field">
            <label htmlFor="statement-to">Period to</label>
            <input id="statement-to" className="ix-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="ix-field">
            <span id="statement-file-label">Statement file (CSV)</span>
            {/* The native control is kept for what it does — opening the file picker — and not for how it looks:
                it draws "No file chosen" in a system font, which every page baseline forbids (VISUAL_BASELINES
                §4). The button and the filename beside it are ours, in the desk's own type. */}
            <input
              ref={fileInput}
              id="statement-file"
              className={styles.fileInput}
              type="file"
              accept=".csv,text/csv"
              aria-labelledby="statement-file-label"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) {
                  setPicked(null);
                  return;
                }
                // Read, never rewrite: the bytes this file holds are what gets hashed and what gets read.
                void file.text().then((csv) => setPicked({ filename: file.name, csv }));
              }}
            />
            <span className="ix-row">
              <Button intent="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                Choose file
              </Button>
              <span className="ix-hint">{picked ? picked.filename : 'No file chosen'}</span>
            </span>
            <span className="ix-hint">Columns: value_date, direction, amount, reference, description</span>
          </div>
          <Button disabled={!picked || !accountId || !from || !to || cmd.busy || from > to} onClick={submit}>
            Import statement <StepUpMark />
          </Button>
        </div>
      ) : null}

      {outcome ? (
        <p className={outcome.missing > 0 || outcome.mismatched > 0 ? styles.statementAlarm : styles.statementQuiet} role="status" data-testid="statement-outcome">
          {outcome.lines} lines · {outcome.matched} matched · {outcome.mismatched} mismatched · {outcome.unrecorded} not ours · {outcome.missing} confirmed
          payments the statement does not show.
          {outcome.casesOpened > 0 ? ` ${outcome.casesOpened} case${outcome.casesOpened === 1 ? '' : 's'} opened.` : ' No case opened.'}
        </p>
      ) : null}

      {statements.length === 0 ? (
        <EmptyState title="No statement imported yet" body="Until one is, nothing here has been checked against the bank." />
      ) : (
        <TradeTable
          caption="Recent imports"
          rowKey={(r: StatementImportSummary) => r.importId}
          columns={[
            { key: 'at', header: 'Imported', render: (r: StatementImportSummary) => formatIstDateTime(new Date(r.importedAt)) },
            { key: 'account', header: 'Account', render: (r: StatementImportSummary) => r.accountLabel },
            { key: 'file', header: 'File', render: (r: StatementImportSummary) => r.filename },
            { key: 'period', header: 'Period', render: (r: StatementImportSummary) => `${r.periodFrom} → ${r.periodTo}` },
            { key: 'lines', header: 'Lines', numeric: true, render: (r: StatementImportSummary) => r.lines },
            { key: 'matched', header: 'Matched', numeric: true, render: (r: StatementImportSummary) => r.matched },
            { key: 'mismatched', header: 'Mismatched', numeric: true, render: (r: StatementImportSummary) => r.mismatched },
            { key: 'unrecorded', header: 'Not ours', numeric: true, render: (r: StatementImportSummary) => r.unrecorded },
            { key: 'missing', header: 'Missing', numeric: true, render: (r: StatementImportSummary) => r.missing },
            { key: 'by', header: 'By', render: (r: StatementImportSummary) => r.importedBy },
          ]}
          rows={statements}
        />
      )}

      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </section>
  );
}
