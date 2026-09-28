import { Money } from '@inrp2p/kernel';
import { HEALTH_CHECKS, deskNow, stateOf, usdtView } from '@inrp2p/desk';
import { operatorPage } from '../../../server/operator.ts';
import { age, dateTime, usdt } from '../_desk/format.ts';
import { Chip, KpiBand, Meter, Notice, Page, PageBody, PageHeader, Section, Segmented } from '../_desk/ui.tsx';
import { TransfersTable, WalletsTable } from './UsdtTables.tsx';
import d from '../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

/** Below this many free pool addresses the desk is warned before SELL acceptance starts failing (D-02). */
const LOW_POOL_THRESHOLD = 20;

type Filter = 'all' | 'detected' | 'unattributed';

/**
 * USDT treasury (brief "USDT Treasury"): an operational position, not a wallet — what the treasury observes, what
 * open trades have reserved and what is free; the deposit-address pool every SELL trade depends on (D-02); the
 * scanner's own state, so "no new transfers" can be told apart from "broken"; and what the chain has produced.
 */
export default async function UsdtPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const filter: Filter = params.show === 'detected' || params.show === 'unattributed' ? params.show : 'all';
  const [view, now] = await Promise.all([usdtView(ctx.db, { transferLimit: 100 }), deskNow(ctx.db)]);
  const nowMs = new Date(now).getTime();

  const live = view.wallets.filter((w) => w.status !== 'RETIRED');
  const sum = (pick: (w: (typeof live)[number]) => string) => live.reduce((acc, w) => acc.add(Money.parse(pick(w), 'USDT')), Money.zero('USDT')).toDecimalString();
  const observed = sum((w) => w.observed);
  const reserved = sum((w) => w.reserved);
  const available = sum((w) => w.available);

  const lagCheck = HEALTH_CHECKS.find((c) => c.id === 'scanner_lag_seconds')!;
  const lagSeconds = view.scanner?.lastRunAt ? Math.max(0, Math.floor((nowMs - new Date(view.scanner.lastRunAt).getTime()) / 1000)) : null;
  const scannerState = lagSeconds === null ? 'alarm' : stateOf(lagCheck, lagSeconds);
  const pool = view.pool;
  const poolTotal = pool.available + pool.assigned + pool.cooldown;
  const lowPool = pool.capability === 'POOL' && pool.available < LOW_POOL_THRESHOLD;
  const awaitingFinality = view.transfers.filter((t) => t.state === 'DETECTED').length;
  const unattributed = view.transfers.filter((t) => t.tradeRef === null && t.source === 'SCANNER').length;
  const transfers = filter === 'detected' ? view.transfers.filter((t) => t.state === 'DETECTED') : filter === 'unattributed' ? view.transfers.filter((t) => t.tradeRef === null) : view.transfers;

  return (
    <Page>
      <PageHeader
        title="USDT treasury"
        meta={
          view.scanner ? (
            <>
              Scanner at block {view.scanner.lastScannedBlock} · solidified {view.scanner.lastSolidifiedBlock}
              {view.scanner.lastRunAt ? ` · last run ${dateTime(view.scanner.lastRunAt)}` : ''}
            </>
          ) : (
            'The scanner has not run yet.'
          )
        }
        badge={
          <Chip tone={scannerState === 'ok' ? 'success' : scannerState === 'warn' ? 'warning' : 'danger'} glyph={scannerState === 'ok' ? 'done' : 'partial'}>
            {scannerState === 'ok' ? 'Scanner live' : lagSeconds === null ? 'Scanner not running' : `Scanner ${age(view.scanner!.lastRunAt!, nowMs)} behind`}
          </Chip>
        }
      />
      <PageBody>
        <KpiBand
          label="Treasury position"
          items={[
            { key: 'a', label: 'Available', value: usdt(available), sub: 'observed less reserved', size: 'lg' },
            { key: 'o', label: 'Observed on chain', value: usdt(observed), sub: `across ${live.length} ${live.length === 1 ? 'wallet' : 'wallets'}` },
            { key: 'r', label: 'Reserved', value: usdt(reserved), sub: 'held for open trades' },
            { key: 'p', label: 'Deposit addresses free', value: pool.capability === 'POOL' ? String(pool.available) : pool.capability === 'DERIVED' ? 'derived' : 'none', sub: `${pool.assigned} assigned · ${pool.cooldown} cooling down`, ...(lowPool || pool.capability === 'UNSUPPORTED' ? { tone: 'danger' as const } : {}) },
            { key: 'f', label: 'Awaiting finality', value: String(awaitingFinality), sub: `${unattributed} unattributed`, ...(unattributed > 0 ? { tone: 'warning' as const } : {}) },
          ]}
        />

        {pool.capability === 'UNSUPPORTED' ? (
          <Notice tone="danger" icon="lock">
            <strong>Unique deposit addresses are not supported by the custody provider.</strong> SELL USDT acceptance is disabled; there is no fallback attribution by amount or sender.
          </Notice>
        ) : lowPool ? (
          <Notice tone="warning" icon="exceptions">
            <strong>Deposit pool low:</strong> {pool.available} addresses left, fewer than {LOW_POOL_THRESHOLD}. Replenish the pool in the custody provider before SELL acceptance starts failing.
          </Notice>
        ) : null}

        <Section title="Treasury wallets" count={view.wallets.length} hint="Watch-only. Balances are what the chain shows; reserved is what open trades will send." flush>
          <WalletsTable wallets={view.wallets} />
        </Section>

        <Section
          title="Deposit addresses · TRC20"
          hint={`${pool.provider ?? 'No provider recorded'} · ${pool.capability === 'DERIVED' ? 'derived per trade' : pool.capability === 'POOL' ? 'provider pool' : 'unsupported'} · one address per SELL trade, attributed by address only`}
        >
          {poolTotal > 0 ? (
            <div className={d.stackTight}>
              <Meter
                label={`${pool.available} available, ${pool.assigned} assigned, ${pool.cooldown} cooling down`}
                parts={[
                  { value: (pool.assigned / poolTotal) * 100, tone: 'brand' },
                  { value: (pool.cooldown / poolTotal) * 100, tone: 'ink' },
                ]}
              />
              <span className={d.meta}>
                <strong>{pool.available}</strong> free · {pool.assigned} assigned to open trades · {pool.cooldown} in cooldown after use
              </span>
            </div>
          ) : (
            <Notice>No addresses have been imported yet.</Notice>
          )}
        </Section>

        <Section
          title="Transfers"
          count={transfers.length}
          hint="What the scanner has seen and what the desk submitted, newest first. Only a solidified transfer confirms anything."
          actions={
            <Segmented
              label="Show"
              items={[
                { href: '/usdt', label: 'All', current: filter === 'all' },
                { href: '/usdt?show=detected', label: `Awaiting finality · ${awaitingFinality}`, current: filter === 'detected' },
                { href: '/usdt?show=unattributed', label: 'Unattributed', current: filter === 'unattributed' },
              ]}
            />
          }
          flush
        >
          <TransfersTable transfers={transfers} />
        </Section>
      </PageBody>
    </Page>
  );
}
