'use client';

import { useRef, useState } from 'react';
import type { InrAccountView } from '@inrp2p/desk';
import type { StatementImportResult, StatementImportSummary } from '@inrp2p/settlement';
import { Button, StepUpMark } from '@inrp2p/ui';
import { importStatementAction } from '../../../server/actions/finance.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Cell, type Column, DataTable } from '../_desk/DataTable.tsx';
import { SelectField, TextField } from '../_desk/fields.tsx';
import { dateTime } from '../_desk/format.ts';
import { Chip, Empty, KpiBand, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import s from './inr.module.css';

interface Picked {
  readonly filename: string;
  readonly csv: string;
}

/**
 * Manual bank statement reconciliation (SECURITY §5 S7).
 *
 * Everything else in the payout path proves an operator said a payment was made. Only the bank's own statement
 * proves the bank moved it, and until there is a bank API a person brings that file here. The outcome is said in
 * the four words that matter — matched, mismatched, not ours, missing — and it is the last one that opens cases:
 * a payment the desk confirmed that the bank has never heard of.
 */
export function StatementImport({ accounts, statements, canImport }: { accounts: readonly InrAccountView[]; statements: readonly StatementImportSummary[]; canImport: boolean }) {
  const cmd = useCommand();
  const fileInput = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  // The period starts empty rather than on today. A statement is almost never for today, and a date the screen
  // guessed is a date nobody checked; the period is what everything in the import is judged against.
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

  const columns: Column<StatementImportSummary>[] = [
    { key: 'at', header: 'Imported', render: (r) => <span className={d.num}>{dateTime(r.importedAt)}</span> },
    { key: 'file', header: 'Account · file', render: (r) => <Cell main={r.accountLabel} sub={<span className={d.mono}>{r.filename}</span>} /> },
    { key: 'period', header: 'Period', render: (r) => `${r.periodFrom} → ${r.periodTo}` },
    { key: 'lines', header: 'Lines', align: 'right', render: (r) => r.lines },
    { key: 'matched', header: 'Matched', align: 'right', render: (r) => r.matched },
    { key: 'mismatched', header: 'Mismatched', align: 'right', render: (r) => (r.mismatched > 0 ? <strong className={d.negative}>{r.mismatched}</strong> : r.mismatched) },
    { key: 'unrecorded', header: 'Not ours', align: 'right', render: (r) => r.unrecorded },
    { key: 'missing', header: 'Missing', align: 'right', render: (r) => (r.missing > 0 ? <strong className={d.negative}>{r.missing}</strong> : r.missing) },
    { key: 'result', header: 'Result', render: (r) => (r.missing > 0 || r.mismatched > 0 ? <Chip tone="danger">cases opened</Chip> : <Chip tone="success" glyph="done">reconciled</Chip>) },
  ];

  return (
    <div className={d.stack} data-testid="statement-import">
      {canImport ? (
        <div className={s.importForm}>
          <SelectField label="Account" value={accountId} onChange={setAccountId} options={accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} · ${a.label}` }))} />
          <TextField label="Period from" type="date" value={from} onChange={setFrom} />
          <TextField label="Period to" type="date" value={to} onChange={setTo} />
          <div className={d.field}>
            <span id="statement-file-label" className={d.fieldLabel}>
              Statement file (CSV)
            </span>
            {/* The native control is kept for what it does — opening the file picker — and not for how it looks:
                it draws "No file chosen" in a system font, which every page baseline forbids (VISUAL_BASELINES §4). */}
            <input
              ref={fileInput}
              id="statement-file"
              className={s.fileInput}
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
            <span className={d.row} style={{ flexWrap: 'nowrap' }}>
              <Button intent="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                Choose file
              </Button>
              <span className={s.fileName}>{picked ? picked.filename : 'No file chosen'}</span>
            </span>
          </div>
          <div className={s.importAction}>
            <Button intent="primary" size="sm" disabled={!picked || !accountId || !from || !to || cmd.busy || from > to} onClick={submit} shortcut={<StepUpMark label="needs your authenticator code" />}>
              Import statement
            </Button>
          </div>
        </div>
      ) : (
        <Notice icon="lock">Importing a statement needs the owner or finance role.</Notice>
      )}
      {canImport ? <p className={d.fieldHint}>Columns: value_date, direction, amount, reference, description. The file is hashed and never stored — only what it reconciled.</p> : null}

      {outcome ? (
        <div role="status" data-testid="statement-outcome" className={d.stackTight}>
          <KpiBand
            label="Import outcome"
            items={[
              { key: 'l', label: 'Lines', value: String(outcome.lines) },
              { key: 'm', label: 'Matched', value: String(outcome.matched), tone: 'success' },
              { key: 'x', label: 'Mismatched', value: String(outcome.mismatched), ...(outcome.mismatched > 0 ? { tone: 'danger' as const } : {}) },
              { key: 'u', label: 'Not ours', value: String(outcome.unrecorded), sub: 'bank charges, other traffic' },
              { key: 'g', label: 'Missing', value: String(outcome.missing), sub: 'confirmed by us, not on the statement', ...(outcome.missing > 0 ? { tone: 'danger' as const } : {}) },
            ]}
          />
          <Notice tone={outcome.missing > 0 || outcome.mismatched > 0 ? 'danger' : 'success'} icon={outcome.missing > 0 || outcome.mismatched > 0 ? 'exceptions' : 'check'}>
            {outcome.lines} lines · {outcome.matched} matched · {outcome.mismatched} mismatched · {outcome.unrecorded} not ours · {outcome.missing} confirmed payments the statement does not show.
            {outcome.casesOpened > 0 ? ` ${outcome.casesOpened} case${outcome.casesOpened === 1 ? '' : 's'} opened.` : ' No case opened.'}
          </Notice>
        </div>
      ) : null}

      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}

      <DataTable<StatementImportSummary>
        caption="Recent imports"
        label="Recent imports"
        columns={columns}
        rows={statements}
        rowKey={(r) => r.importId}
        empty={<Empty title="No statement imported yet" body="Until one is, nothing here has been checked against the bank." />}
      />
      {cmd.dialog}
    </div>
  );
}
