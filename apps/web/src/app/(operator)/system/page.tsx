import { notFound } from 'next/navigation';
import { systemHealth } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { dateTime } from '../_desk/format.ts';
import { Chip, KpiBand, Notice, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { HealthTable } from './HealthTable.tsx';
import { reading } from './reading.ts';

export const dynamic = 'force-dynamic';

/**
 * System health (launch checklist: monitoring + alerts), for the operator rather than the pager: the same nine
 * signals `/api/health/status` serves, each against its own thresholds, grouped by what fails — the money, the
 * pipelines that move it, the desk's capacity to take work — with the runbook to follow and the desk page to act on.
 * Gated like the API: capacity and blocked-trade counts are `economics:view` figures.
 */
export default async function SystemPage() {
  const ctx = await operatorPage();
  if (!can(ctx, 'economics:view')) notFound();
  const health = await systemHealth(ctx.db);
  const alarms = health.checks.filter((c) => c.state === 'alarm');
  const warnings = health.checks.filter((c) => c.state === 'warn');
  const tone = health.state === 'ok' ? 'success' : health.state === 'warn' ? 'warning' : 'danger';
  const find = (id: string) => health.checks.find((c) => c.id === id);
  const capacity = find('inr_capacity_available');
  const scanner = find('scanner_lag_seconds');
  const blocking = find('blocking_exceptions');

  return (
    <Page>
      <PageHeader
        title="System health"
        badge={
          <Chip tone={tone} glyph={health.state === 'ok' ? 'done' : health.state === 'warn' ? 'partial' : 'closed'}>
            {health.state === 'ok' ? 'All signals fine' : health.state === 'warn' ? `${warnings.length} to look at` : `${alarms.length} in alarm`}
          </Chip>
        }
        meta={`checked ${dateTime(health.checkedAt)} · one snapshot, every signal read in the same query`}
      />
      <PageBody>
        <KpiBand
          label="Health summary"
          items={[
            { key: 'a', label: 'In alarm', value: String(alarms.length), sub: alarms.length ? alarms.map((c) => c.runbook).join(' · ') : 'nothing to wake anyone for', ...(alarms.length ? { tone: 'danger' as const } : {}) },
            { key: 'w', label: 'Worth a look', value: String(warnings.length), sub: warnings.length ? warnings.map((c) => c.runbook).join(' · ') : 'no warnings', ...(warnings.length ? { tone: 'warning' as const } : {}) },
            ...(capacity ? [{ key: 'c', label: 'INR capacity left today', value: reading(capacity, capacity.value), href: '/inr', ...(capacity.state !== 'ok' ? { tone: capacity.state === 'alarm' ? ('danger' as const) : ('warning' as const) } : {}) }] : []),
            ...(scanner ? [{ key: 's', label: 'Scanner last ran', value: `${reading(scanner, scanner.value)} ago`, href: '/usdt', ...(scanner.state !== 'ok' ? { tone: scanner.state === 'alarm' ? ('danger' as const) : ('warning' as const) } : {}) }] : []),
            ...(blocking ? [{ key: 'b', label: 'Trades on hold', value: String(blocking.value), href: '/exceptions', ...(blocking.state !== 'ok' ? { tone: blocking.state === 'alarm' ? ('danger' as const) : ('warning' as const) } : {}) }] : []),
          ]}
        />
        {alarms.length > 0 ? (
          <Notice tone="danger" icon="exceptions" role="alert">
            <strong>{alarms.map((c) => c.title).join('; ')}.</strong> Follow the runbook named on the row; an alarm is the level at which someone is woken.
          </Notice>
        ) : null}
        <Section title="Signals" count={health.checks.length} hint="Thresholds live in code and are reviewed like code. Open a row to go where the desk acts on it." flush>
          <HealthTable checks={health.checks} />
        </Section>
      </PageBody>
    </Page>
  );
}
