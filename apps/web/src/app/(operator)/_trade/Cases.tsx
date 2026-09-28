'use client';

import { useState } from 'react';
import { Money, Rate, usdtToInr } from '@inrp2p/kernel';
import type { DeskTrade } from '@inrp2p/desk';
import { Button } from '@inrp2p/ui';
import { requestAdjustmentAction, resolveExceptionAction, takeExceptionAction, voidExceptionAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Ago } from '../_desk/clock.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { Choices, TextArea } from '../_desk/fields.tsx';
import { caseDetails, caseTitle, money, usdt } from '../_desk/format.ts';
import { Chip, KeyValues, Notice } from '../_desk/ui.tsx';
import { type Resolution, resolutionsFor } from './resolutions.ts';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

export interface CaseView {
  readonly id: string;
  readonly ref: string;
  readonly type: string;
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'VOID';
  readonly details: Record<string, unknown>;
  readonly openedAt: string;
  readonly takenBy: string | null;
  readonly takenByLabel: string | null;
}

export interface CasePerms {
  readonly meId: string;
  readonly resolveException: boolean;
  readonly requestAdjustment: boolean;
}

/**
 * One exception case and its way out (UX_FLOWS F6). The resolutions offered are exactly the ones the domain
 * accepts for this type (`resolutions.ts`, held against the domain by a test), and the two kinds are kept apart
 * honestly: a non-financial resolution closes the case, while anything that moves money — adjusting a trade to
 * what arrived, a refund, a cancellation — is its own command that a second person approves (FI-31).
 */
export function CaseCard({ c, perms, trade }: { c: CaseView; perms: CasePerms; trade?: DeskTrade | null }) {
  const cmd = useCommand();
  const choices = resolutionsFor(c.type);
  const [resolution, setResolution] = useState<Resolution>(choices.resolutions[0]!.value);
  const [notes, setNotes] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const mine = c.takenBy === perms.meId;
  const fact = headlineFact(c, trade);
  const shortfall = trade && (c.type === 'USDT_WRONG_AMOUNT' || c.type === 'USDT_OVERPAYMENT') ? shortfallOf(trade) : null;
  // Amounts in a case are the trade's first-leg currency (USDT for a SELL, INR for a BUY); shown exactly.
  const currency = trade?.direction === 'BUY_USDT' ? 'INR' : 'USDT';
  const details = caseDetails(c.details).map((x) =>
    AMOUNT_KEYS.has(x.label.toLowerCase()) && /^-?\d+(\.\d+)?$/.test(x.value) && trade ? { ...x, value: safeMoney(x.value, currency) } : x,
  );

  return (
    <article className={t.case} data-severity={c.severity} data-testid={`case-${c.type}`} aria-label={`${caseTitle(c.type)} ${c.ref}`}>
      <div className={t.caseHead}>
        <div className={d.stackTight} style={{ gap: 2 }}>
          <h4 className={t.caseTitle}>{caseTitle(c.type)}</h4>
          <span className={t.caseMeta}>
            {c.ref} · opened <Ago at={c.openedAt} />{c.takenByLabel ? ` · ${mine ? 'you took it' : `taken by ${c.takenByLabel}`}` : ''}
          </span>
        </div>
        <Chip tone={c.severity === 'BLOCKING' ? 'danger' : 'warning'} icon={c.severity === 'BLOCKING' ? 'lock' : 'flag'}>
          {c.severity === 'BLOCKING' ? 'Blocks the trade' : 'Warning'}
        </Chip>
      </div>

      {fact ? <span className={t.headlineFact}>{fact}</span> : null}
      {details.length > 0 ? <KeyValues items={details.map((x) => ({ label: x.label, value: x.value }))} /> : null}

      {perms.resolveException ? (
        <>
          <Choices<Resolution>
            legend="Resolution"
            value={resolution}
            onChange={setResolution}
            choices={choices.resolutions.map((o) => ({ value: o.value, title: o.label }))}
          />
          <TextArea label="What happened" value={notes} onChange={setNotes} placeholder="Recorded with the resolution in the audit trail" />
          <div className={d.actions}>
            <Button
              intent="primary"
              size="sm"
              disabled={cmd.busy || notes.trim().length < 3}
              onClick={() =>
                cmd.run(`Resolve ${c.ref} · ${resolution.replace(/_/g, ' ')}`, (key) => resolveExceptionAction({ exceptionId: c.id, resolution, notes: notes.trim() }, key))
              }
            >
              Resolve
            </Button>
            {c.status === 'OPEN' ? (
              <Button size="sm" intent="secondary" disabled={cmd.busy} onClick={() => cmd.run(`Take ${c.ref}`, (key) => takeExceptionAction({ exceptionId: c.id }, key))}>
                Take it
              </Button>
            ) : null}
            {choices.voidable ? (
              <GuardedAction
                label="Void case"
                trigger="ghost"
                busy={cmd.busy}
                consequence="Closes the case as one that should never have been opened. Nothing is resolved and nothing moves; the record says so plainly."
                reasonLabel="Why it should not exist"
                onConfirm={async (reason) => (await cmd.run(`Void ${c.ref}`, (key) => voidExceptionAction({ exceptionId: c.id, reason }, key))).ok}
              />
            ) : null}
          </div>
        </>
      ) : (
        <Notice>Resolving cases needs a role with exception:resolve.</Notice>
      )}

      {choices.financial ? (
        <Notice icon="shield">
          <strong>Money moves elsewhere.</strong> {choices.financial}
        </Notice>
      ) : null}

      {shortfall && trade && perms.requestAdjustment ? (
        <div className={d.guard}>
          <p className={d.guardTitle}>Or adjust the trade to what arrived</p>
          <p className={d.guardBody}>
            Received {usdt(shortfall.received, { exact: true })} against {usdt(shortfall.expected, { exact: true })}: a correction of {usdt(shortfall.deltaBase, { exact: true })} and{' '}
            {money(shortfall.deltaClientInr, 'INR')} owed to the client, at the frozen client rate. It is recorded as a signed adjustment — the frozen terms never change — and counts
            only once a second person approves it.
          </p>
          <TextArea label="Why" value={adjustReason} onChange={setAdjustReason} placeholder="At least 10 characters" />
          <div className={d.actions}>
            <Button
              size="sm"
              disabled={cmd.busy || adjustReason.trim().length < 10}
              onClick={() =>
                cmd.run(`Adjust ${trade.ref} to the received amount`, (key) =>
                  requestAdjustmentAction(
                    { tradeId: trade.tradeId, type: 'AMOUNT_CORRECTION', deltaBaseUsdt: shortfall.deltaBase, deltaClientInr: shortfall.deltaClientInr, reason: adjustReason.trim(), exceptionId: c.id },
                    key,
                  ),
                )
              }
            >
              Request adjustment
            </Button>
          </div>
        </div>
      ) : null}

      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </article>
  );
}

const AMOUNT_KEYS = new Set(['expected', 'received', 'amount', 'difference']);

function safeMoney(value: string, currency: 'INR' | 'USDT'): string {
  try {
    return money(value, currency, { exact: currency === 'USDT' });
  } catch {
    return value;
  }
}

/** "Short by 50.000000 USDT" beats a table of fields: the one fact the case is about, when the details say it. */
function headlineFact(c: CaseView, trade?: DeskTrade | null): string | null {
  const expected = typeof c.details.expected === 'string' ? c.details.expected : null;
  const received = typeof c.details.received === 'string' ? c.details.received : null;
  const currency = trade?.direction === 'BUY_USDT' ? 'INR' : 'USDT';
  try {
    if (c.type === 'USDT_WRONG_AMOUNT' && expected && received) return `Short by ${money(Money.parse(expected, currency).sub(Money.parse(received, currency)).toDecimalString(), currency, { exact: true })}`;
    if (c.type === 'USDT_OVERPAYMENT' && expected && received) return `Over by ${money(Money.parse(received, currency).sub(Money.parse(expected, currency)).toDecimalString(), currency, { exact: true })}`;
  } catch {
    return null;
  }
  return null;
}

/**
 * What "adjust to received" would move. For a SELL the client sent less (or more) USDT than the trade froze, so both
 * the base and the INR the client is owed change; the margin delta is derived by the command, never supplied (FI-02).
 */
function shortfallOf(trade: DeskTrade): { received: string; expected: string; deltaBase: string; deltaClientInr: string } | null {
  if (trade.direction !== 'SELL_USDT' || trade.receivable.currency !== 'USDT' || !trade.clientRate) return null;
  const expected = Money.parse(trade.receivable.amount, 'USDT');
  const received = Money.parse(trade.received, 'USDT');
  if (received.minor === expected.minor || received.minor === 0n) return null;
  const deltaMinor = received.minor - expected.minor;
  const negative = deltaMinor < 0n;
  const magnitude = Money.ofMinor(negative ? -deltaMinor : deltaMinor, 'USDT');
  // The INR the client is owed moves with the base at the frozen client rate, converted by the kernel — the same
  // rounding the quote used, never a re-derivation here.
  const inrMagnitude = usdtToInr(magnitude, Rate.parse(trade.clientRate, 'CLIENT'), 'DOWN');
  const sign = negative ? '-' : '';
  return {
    received: received.toDecimalString(),
    expected: expected.toDecimalString(),
    deltaBase: `${sign}${magnitude.toDecimalString()}`,
    deltaClientInr: `${sign}${inrMagnitude.toDecimalString()}`,
  };
}
