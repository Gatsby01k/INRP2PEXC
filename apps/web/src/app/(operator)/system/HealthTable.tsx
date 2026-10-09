'use client';

import { useRouter } from 'next/navigation';
import type { HealthCheck } from '@inrp2p/desk';
import { Cell, DataTable, type RowGroup } from '../_desk/DataTable.tsx';
import { Chip } from '../_desk/ui.tsx';
import { reading } from './reading.ts';
import d from '../_desk/desk.module.css';
import h from './system.module.css';

/** Where the operator goes to act on a signal. Signals with nowhere on the desk to act (outbox, seal) open nothing. */
const WHERE: Record<string, { href: string; label: string }> = {
  ledger_imbalance: { href: '/pnl', label: 'P&L · ledger check' },
  scanner_lag_seconds: { href: '/usdt', label: 'USDT treasury' },
  custody_outflows_unobserved: { href: '/usdt', label: 'USDT treasury' },
  blocking_exceptions: { href: '/exceptions', label: 'Exceptions' },
  reconciliation_mismatches: { href: '/exceptions', label: 'Exceptions' },
  overdue_route_obligations: { href: '/rates#positions', label: 'Rates · route positions' },
  inr_capacity_available: { href: '/inr', label: 'INR accounts' },
  deposit_pool_free: { href: '/usdt', label: 'USDT treasury' },
  trader_orders_overdue: { href: '/trader-desk', label: 'Traders' },
  traders_ready_sell_usdt: { href: '/trader-desk', label: 'Traders' },
  traders_ready_buy_usdt: { href: '/trader-desk', label: 'Traders' },
};

/**
 * The signals in the three places they fail: money itself, the infrastructure that moves it, and liquidity — kept
 * apart because no trader online is quiet, not broken, and never makes the deployment unready (D-16).
 */
const GROUPS: readonly { key: HealthCheck['group']; title: string }[] = [
  { key: 'money', title: 'Money' },
  { key: 'infrastructure', title: 'Infrastructure' },
  { key: 'liquidity', title: 'Liquidity — reported apart, never "not ready"' },
];

/** A low number is the problem when the alarm threshold sits below the warning one (capacity, the address pool). */
const lowerIsWorse = (c: HealthCheck) => c.alarm < c.warn;

function thresholds(c: HealthCheck): string {
  if (c.warn === c.alarm) return c.unit === 'count' && c.alarm === 0 ? 'must be 0' : `alarm above ${reading(c, c.alarm)}`;
  return lowerIsWorse(c) ? `warn at ${reading(c, c.warn)} · alarm at ${reading(c, c.alarm)}` : `warn above ${reading(c, c.warn)} · alarm above ${reading(c, c.alarm)}`;
}

/**
 * Where the reading sits between fine and alarm, as a 0–100 position where right is always worse — for capacity
 * and the address pool that means the scale runs downwards. It extends half again past the alarm threshold, so an
 * alarm marker sits visibly past the line rather than pinned to it.
 */
function position(c: HealthCheck): { marker: number; warnAt: number; alarmAt: number } {
  if (lowerIsWorse(c)) {
    const top = Math.max(c.warn * 1.5, 1);
    const pct = (v: number) => Math.max(0, Math.min(100, 100 - (v / top) * 100));
    return { marker: pct(c.value), warnAt: pct(c.warn), alarmAt: pct(c.alarm) };
  }
  // A must-be-zero signal (the ledger) has no warning band: fine on the left half, alarm on the right.
  if (c.alarm === 0 && c.warn === 0) return { marker: c.value > 0 ? 100 : 0, warnAt: 50, alarmAt: 50 };
  const top = c.alarm * 1.5;
  const pct = (v: number) => Math.max(0, Math.min(100, (v / top) * 100));
  return { marker: pct(c.value), warnAt: pct(c.warn), alarmAt: pct(c.alarm) };
}

function Gauge({ c }: { c: HealthCheck }) {
  const p = position(c);
  return (
    <span className={h.gauge} aria-hidden>
      <span className={h.zoneWarn} style={{ left: `${p.warnAt}%`, width: `${Math.max(p.alarmAt - p.warnAt, 0)}%` }} />
      <span className={h.zoneAlarm} style={{ left: `${p.alarmAt}%`, right: 0 }} />
      <span className={h.marker} data-state={c.state} data-check={c.id} style={{ left: `${p.marker}%` }} />
    </span>
  );
}

const STATE: Record<HealthCheck['state'], { word: string; tone: 'success' | 'warning' | 'danger'; glyph: 'done' | 'partial' | 'closed' }> = {
  ok: { word: 'OK', tone: 'success', glyph: 'done' },
  warn: { word: 'Look', tone: 'warning', glyph: 'partial' },
  alarm: { word: 'Alarm', tone: 'danger', glyph: 'closed' },
};

export function HealthTable({ checks }: { checks: readonly HealthCheck[] }) {
  const router = useRouter();
  const groups: RowGroup<HealthCheck>[] = GROUPS.map((g) => {
    const rows = checks.filter((c) => c.group === g.key);
    return { key: g.key, title: g.title, rows, ...(rows.some((r) => r.state === 'alarm') ? { tone: 'danger' as const } : {}) };
  }).filter((g) => g.rows.length > 0);

  return (
    <DataTable
      caption="System health signals"
      testId="health-checks"
      groups={groups}
      rowKey={(c) => c.id}
      rail={(c) => (c.state === 'alarm' ? 'danger' : c.state === 'warn' ? 'action' : null)}
      onOpen={(c) => {
        const where = WHERE[c.id];
        if (where) router.push(where.href);
      }}
      columns={[
        {
          key: 'state',
          header: 'State',
          width: 96,
          render: (c) => (
            <Chip tone={STATE[c.state].tone} glyph={STATE[c.state].glyph}>
              {STATE[c.state].word}
            </Chip>
          ),
        },
        { key: 'signal', header: 'Signal', wrap: true, render: (c) => <Cell main={c.title} sub={<span className={h.why}>{c.why.replace(/\*\*/g, '')}</span>} /> },
        {
          key: 'now',
          header: 'Now',
          align: 'right',
          width: 140,
          render: (c) => (
            <span className={h.reading} data-state={c.state} data-check={c.id}>
              {reading(c, c.value)}
            </span>
          ),
        },
        {
          key: 'scale',
          header: 'Against thresholds',
          width: 220,
          render: (c) => (
            <span className={h.scale}>
              <Gauge c={c} />
              <span className={d.muted}>{thresholds(c)}</span>
            </span>
          ),
        },
        {
          key: 'runbook',
          header: 'Runbook · act in',
          width: 220,
          render: (c) => (
            <Cell
              main={<span className={d.mono}>RUNBOOKS § {c.runbook}</span>}
              sub={
WHERE[c.id] ? `→ ${WHERE[c.id]!.label}` : 'infrastructure · outside the desk'
              }
            />
          ),
        },
      ]}
    />
  );
}
