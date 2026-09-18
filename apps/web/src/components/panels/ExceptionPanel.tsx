'use client';

import { useState } from 'react';
import { Money, Rate, usdtToInr } from '@inrp2p/kernel';
import type { DeskCase, DeskTrade } from '@inrp2p/desk';
import { Button, ExceptionBanner } from '@inrp2p/ui';
import { formatUsdt } from '@inrp2p/ui/format';
import { requestAdjustmentAction, resolveExceptionAction, takeExceptionAction } from '../../server/actions/desk.ts';
import { useCommand } from '../useCommand.tsx';
import styles from './panel.module.css';

type Resolution = 'await_top_up' | 'accept_sender' | 'hold_in_suspense' | 'confirm_new_destination' | 'keep_original' | 'escalate' | 'create_replacement_leg';

/** The resolutions each case type actually offers, in the order a desk would consider them (DOMAIN_MODEL §3). */
const OPTIONS: Record<string, readonly { value: Resolution; label: string }[]> = {
  USDT_WRONG_AMOUNT: [
    { value: 'await_top_up', label: 'Wait for the client to top up' },
    { value: 'escalate', label: 'Escalate' },
  ],
  USDT_OVERPAYMENT: [
    { value: 'hold_in_suspense', label: 'Hold the excess in suspense' },
    { value: 'escalate', label: 'Escalate' },
  ],
  USDT_UNEXPECTED_SENDER: [
    { value: 'accept_sender', label: 'Accept this sender' },
    { value: 'escalate', label: 'Escalate' },
  ],
  CLIENT_BANK_CHANGED: [
    { value: 'confirm_new_destination', label: 'Confirm the new destination' },
    { value: 'keep_original', label: 'Keep the original destination' },
  ],
  BANK_TRANSFER_FAILED: [
    { value: 'create_replacement_leg', label: 'Create a replacement leg' },
    { value: 'escalate', label: 'Escalate' },
  ],
  FUNDS_AFTER_TRADE_CLOSED: [
    { value: 'hold_in_suspense', label: 'Hold in suspense' },
    { value: 'escalate', label: 'Escalate' },
  ],
  UNALLOCATED_DEPOSIT: [
    { value: 'hold_in_suspense', label: 'Hold in suspense' },
    { value: 'escalate', label: 'Escalate' },
  ],
};

const FALLBACK: readonly { value: Resolution; label: string }[] = [{ value: 'escalate', label: 'Escalate' }];

/**
 * The exception resolver (UX_FLOWS F6). It offers the resolutions the domain actually accepts for that case
 * type, and it separates the two kinds honestly: the non-financial ones close the case, while adjusting the
 * trade to what arrived is a **financial adjustment** that a second person still has to approve (FI-31).
 */
export function ExceptionPanel({ trade, canResolve, canAdjust }: { trade: DeskTrade; canResolve: boolean; canAdjust: boolean }) {
  const cmd = useCommand();
  const [selected, setSelected] = useState<Record<string, Resolution>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [adjustReason, setAdjustReason] = useState('');

  const shortfall = shortfallOf(trade);

  return (
    <aside className={styles.panel} aria-label={`Exceptions on ${trade.ref}`} data-testid="exception-panel">
      <div className={styles.head}>
        <span className={styles.ref}>{trade.ref}</span>
        <span className={styles.client}>{trade.clientName}</span>
      </div>

      {trade.cases.length === 0 ? <p className={styles.notice}>No open cases on this trade.</p> : null}

      {trade.cases.map((c) => {
        const options = OPTIONS[c.type] ?? FALLBACK;
        const choice = selected[c.id] ?? options[0]!.value;
        return (
          <section key={c.id} className={styles.section} data-testid={`case-${c.type}`}>
            <ExceptionBanner severity={c.severity === 'BLOCKING' ? 'blocking' : 'warning'} title={title(c)} description={detail(c)} />
            <div className="ix-field">
              <label htmlFor={`res-${c.id}`}>Resolution</label>
              <select
                id={`res-${c.id}`}
                className="ix-input"
                value={choice}
                onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.value as Resolution }))}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="ix-field">
              <label htmlFor={`notes-${c.id}`}>What happened</label>
              <input id={`notes-${c.id}`} className="ix-input" value={notes[c.id] ?? ''} onChange={(e) => setNotes((s) => ({ ...s, [c.id]: e.target.value }))} />
            </div>
            <div className={styles.actions}>
              {c.status === 'OPEN' ? (
                <Button onClick={() => cmd.run(`Take ${c.ref}`, (key) => takeExceptionAction({ exceptionId: c.id }, key))}>Take</Button>
              ) : null}
              <Button
                intent="primary"
                disabled={!canResolve || (notes[c.id] ?? '').trim().length < 3}
                onClick={() =>
                  cmd.run(`Resolve ${c.ref} · ${choice.replace(/_/g, ' ')}`, (key) =>
                    resolveExceptionAction({ exceptionId: c.id, resolution: choice, notes: notes[c.id] ?? '' }, key),
                  )
                }
              >
                Resolve
              </Button>
            </div>

            {shortfall && (c.type === 'USDT_WRONG_AMOUNT' || c.type === 'USDT_OVERPAYMENT') ? (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Or adjust the trade to what arrived</h3>
                <p className={styles.notice}>
                  Received {formatUsdt(shortfall.received, { unit: true })} against {formatUsdt(shortfall.expected, { unit: true })}. Adjusting records a signed
                  correction; it does not edit the frozen terms, and a second person must approve it before it counts.
                </p>
                <div className="ix-field">
                  <label htmlFor={`adj-${c.id}`}>Why</label>
                  <input id={`adj-${c.id}`} className="ix-input" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} />
                </div>
                <div className={styles.actions}>
                  <Button
                    disabled={!canAdjust || adjustReason.trim().length < 10}
                    onClick={() =>
                      cmd.run(`Adjust ${trade.ref} to the received amount`, (key) =>
                        requestAdjustmentAction(
                          {
                            tradeId: trade.tradeId,
                            type: 'AMOUNT_CORRECTION',
                            deltaBaseUsdt: shortfall.deltaBase,
                            deltaClientInr: shortfall.deltaClientInr,
                            reason: adjustReason,
                            exceptionId: c.id,
                          },
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
          </section>
        );
      })}

      {cmd.error ? (
        <p className={styles.error} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </aside>
  );
}

function title(c: DeskCase): string {
  return c.type.replace(/_/g, ' ').toLowerCase().replace(/^./, (m) => m.toUpperCase());
}

function detail(c: DeskCase): string {
  const parts = Object.entries(c.details)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`);
  return parts.length ? parts.join(' · ') : `Opened ${new Date(c.openedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * What an "adjust to received" would have to move. For a SELL the client sent less (or more) USDT than the
 * trade froze, so both the base and the INR the client is owed change; the margin delta is derived by the
 * command, never supplied (FI-02).
 */
function shortfallOf(trade: DeskTrade): { received: Money<'USDT'>; expected: Money<'USDT'>; deltaBase: string; deltaClientInr: string } | null {
  if (trade.direction !== 'SELL_USDT' || trade.receivable.currency !== 'USDT' || !trade.clientRate) return null;
  const expected = Money.parse(trade.receivable.amount, 'USDT');
  const received = Money.parse(trade.received, 'USDT');
  if (received.minor === expected.minor || received.minor === 0n) return null;
  const deltaBaseMinor = received.minor - expected.minor;
  const negative = deltaBaseMinor < 0n;
  const magnitude = Money.ofMinor(negative ? -deltaBaseMinor : deltaBaseMinor, 'USDT');
  // The INR the client is owed moves with the base at the frozen client rate, converted by the kernel — the
  // same rounding the quote used, never a re-derivation here.
  const inrMagnitude = usdtToInr(magnitude, Rate.parse(trade.clientRate, 'CLIENT'), 'DOWN');
  const sign = negative ? '-' : '';
  return {
    received,
    expected,
    deltaBase: `${sign}${magnitude.toDecimalString()}`,
    deltaClientInr: `${sign}${inrMagnitude.toDecimalString()}`,
  };
}
