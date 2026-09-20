import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HEALTH_CHECKS, stateOf } from '../src/health.ts';

/**
 * The alert definitions, held to the two rules that make an alert worth having.
 *
 * **Every alert has a runbook.** An alert that fires at 3am with nowhere to send the person it woke is an alert
 * that gets silenced, and a silenced alert is worse than none — it is a signal everyone now believes is being
 * watched. So the runbook id on each check must exist as a heading in `docs/RUNBOOKS.md`.
 *
 * **Every threshold means something.** `warn` has to be reachable before `alarm`, in the right direction for
 * that signal, or the two states collapse into one.
 */
const RUNBOOKS = readFileSync(fileURLToPath(new URL('../../../docs/RUNBOOKS.md', import.meta.url)), 'utf8');
const headings = [...RUNBOOKS.matchAll(/^## ([a-z0-9-]+)/gm)].map((m) => m[1]!);

describe('every alert knows where to send the person it wakes', () => {
  it.each(HEALTH_CHECKS)('$id points at a runbook that exists', (check) => {
    expect(headings, `docs/RUNBOOKS.md has no "## ${check.runbook}" section`).toContain(check.runbook);
  });

  it('has no runbook nobody can reach from an alert', () => {
    // Two exceptions, both deliberate: the drill is scheduled rather than triggered, and the takeover runbook
    // answers a report from a person rather than a threshold.
    const unreachable = headings.filter((h) => !HEALTH_CHECKS.some((c) => c.runbook === h));
    expect(unreachable.sort()).toEqual(['account-takeover', 'backup-restore-drill', 'duplicate-utr', 'failed-bank-transfer', 'provider-outage']);
  });

  it('says why each signal matters, in words an operator would use', () => {
    for (const check of HEALTH_CHECKS) {
      expect(check.why.length, check.id).toBeGreaterThan(60);
      expect(check.title.length, check.id).toBeGreaterThan(10);
    }
    expect(new Set(HEALTH_CHECKS.map((c) => c.id)).size).toBe(HEALTH_CHECKS.length);
  });
});

describe('the thresholds', () => {
  it('separate warning from alarm in the direction that signal moves', () => {
    for (const check of HEALTH_CHECKS) {
      if (check.id === 'ledger_imbalance') {
        // The one signal whose correct value is zero: any row at all is an alarm.
        expect({ id: check.id, warn: check.warn, alarm: check.alarm }).toEqual({ id: check.id, warn: 0, alarm: 0 });
        continue;
      }
      const lowerIsWorse = check.id === 'inr_capacity_available' || check.id === 'deposit_pool_free';
      if (lowerIsWorse) expect(check.alarm, check.id).toBeLessThan(check.warn);
      else expect(check.alarm, check.id).toBeGreaterThan(check.warn);
    }
  });

  it('reads a rising signal the way a person would', () => {
    const lag = HEALTH_CHECKS.find((c) => c.id === 'scanner_lag_seconds')!;
    expect(stateOf(lag, 0)).toBe('ok');
    expect(stateOf(lag, lag.warn)).toBe('ok');
    expect(stateOf(lag, lag.warn + 1)).toBe('warn');
    expect(stateOf(lag, lag.alarm)).toBe('warn');
    expect(stateOf(lag, lag.alarm + 1)).toBe('alarm');
  });

  it('reads a falling signal the other way, which is the one that gets written backwards', () => {
    const capacity = HEALTH_CHECKS.find((c) => c.id === 'inr_capacity_available')!;
    expect(stateOf(capacity, capacity.warn + 1)).toBe('ok');
    expect(stateOf(capacity, capacity.warn)).toBe('warn');
    expect(stateOf(capacity, capacity.alarm)).toBe('alarm');
    expect(stateOf(capacity, 0)).toBe('alarm');
  });

  it('treats a single imbalanced ledger row as an alarm', () => {
    const ledger = HEALTH_CHECKS.find((c) => c.id === 'ledger_imbalance')!;
    expect(stateOf(ledger, 0)).toBe('ok');
    expect(stateOf(ledger, 1)).toBe('alarm');
  });
});
