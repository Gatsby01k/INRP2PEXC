import { Money } from '@inrp2p/kernel';
import { HEALTH_CHECKS, allows, stateOf, usdtView } from '@inrp2p/desk';
import { operatorPage } from '../../../server/operator.ts';
import { nowOf } from '../_desk/reads.ts';
import { age, dateTime, usdt } from '../_desk/format.ts';
import { Chip, KpiBand, Meter, Notice, Page, PageBody, PageHeader, Section, Segmented } from '../_desk/ui.tsx';
import { BackfillsTable, CustodyTable, ProvidersTable, TransfersTable, WalletsTable } from './UsdtTables.tsx';
import d from '../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

/** Below this many free pool addresses the desk is warned before SELL acceptance starts failing (D-02). */
const LOW_POOL_THRESHOLD = 20;

type Filter = 'all' | 'detected' | 'unattributed';

/**
 * USDT treasury (brief "USDT Treasury"): an operational position, not a wallet — for every exchange address, what
 * the chain shows and what could leave now beside how much of the trades' money is there (B2, D-16: the platform
 * holds no USDT of its own to pay with); the deposit-address pool every SELL trade depends on (D-02); the scanner's
 * own state, so "no new transfers" can be told apart from "broken"; and what the chain has produced.
 */
export default async function UsdtPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const filter: Filter = params.show === 'detected' || params.show === 'unattributed' ? params.show : 'all';
  const [view, now] = await Promise.all([usdtView(ctx.db, { transferLimit: 100 }), nowOf(ctx)]);
  const nowMs = new Date(now).getTime();

  const total = (values: readonly string[]) => values.reduce((acc, v) => acc.add(Money.parse(v, 'USDT')), Money.zero('USDT')).toDecimalString();
  const held = total(view.custody.map((p) => p.tradesMoney));
  const freeOnChain = total(view.custody.filter((p) => p.unusable === null).map((p) => p.freeOnChain));
  const unusable = view.custody.filter((p) => p.unusable !== null).length;
  const notSeen = view.custody.filter((p) => p.notSeenOnChain !== null).length;
  const canRefresh = allows(ctx.actor, 'custody:refresh_balance');

  const lagCheck = HEALTH_CHECKS.find((c) => c.id === 'scanner_lag_seconds')!;
  const lagSeconds = view.scanner?.lastRunAt ? Math.max(0, Math.floor((nowMs - new Date(view.scanner.lastRunAt).getTime()) / 1000)) : null;
  const scannerState = lagSeconds === null ? 'alarm' : stateOf(lagCheck, lagSeconds);
  const pool = view.pool;
  const poolTotal = pool.available + pool.assigned + pool.cooldown;
  const lowPool = pool.capability === 'POOL' && pool.available < LOW_POOL_THRESHOLD;
  const awaitingFinality = view.transfers.filter((t) => t.state === 'DETECTED').length;
  // A Security Reserve deposit or withdrawal belongs to a trader, not to a trade: attributed, never "unattributed".
  const unattributed = view.transfers.filter((t) => t.tradeRef === null && t.reserve === null && t.source === 'SCANNER').length;
  const transfers = filter === 'detected' ? view.transfers.filter((t) => t.state === 'DETECTED') : filter === 'unattributed' ? view.transfers.filter((t) => t.tradeRef === null && t.reserve === null) : view.transfers;

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
            { key: 'h', label: 'Trades’ money held', value: usdt(held), sub: 'client and counterparty USDT not yet paid on', size: 'lg' },
            { key: 'f', label: 'Free on chain', value: usdt(freeOnChain), sub: 'by the latest usable readings, less what is leaving' },
            { key: 'u', label: 'Readings not usable', value: String(unusable), sub: `older than ${Math.round(view.maxObservationAgeSeconds / 60)} min, contradicted or missing`, ...(unusable > 0 ? { tone: 'warning' as const } : {}) },
            { key: 'p', label: 'Deposit addresses free', value: pool.capability === 'POOL' ? String(pool.available) : pool.capability === 'DERIVED' ? 'derived' : 'none', sub: `${pool.assigned} assigned · ${pool.cooldown} cooling down`, ...(lowPool || pool.capability === 'UNSUPPORTED' ? { tone: 'danger' as const } : {}) },
            { key: 't', label: 'Awaiting finality', value: String(awaitingFinality), sub: `${unattributed} unattributed`, ...(unattributed > 0 ? { tone: 'warning' as const } : {}) },
          ]}
        />

        {view.scanner && view.scanner.lastComplete === false ? (
          <Notice tone="warning" icon="exceptions" role="status">
            <strong>The last scan could not prove its whole window read.</strong> The cursor stays below the gap until a run reads it:{' '}
            {view.scanner.lastIncompleteReason ?? 'no reason recorded'}
          </Notice>
        ) : null}

        {pool.capability === 'UNSUPPORTED' ? (
          <Notice tone="danger" icon="lock">
            <strong>Unique deposit addresses are not supported by the custody provider.</strong> SELL USDT acceptance is disabled; there is no fallback attribution by amount or sender.
          </Notice>
        ) : lowPool ? (
          <Notice tone="warning" icon="exceptions">
            <strong>Deposit pool low:</strong> {pool.available} addresses left, fewer than {LOW_POOL_THRESHOLD}. Replenish the pool in the custody provider before SELL acceptance starts failing.
          </Notice>
        ) : null}

        {notSeen > 0 ? (
          <Notice tone="danger" icon="exceptions" role="alert">
            <strong>
              {notSeen} {notSeen === 1 ? 'address shows' : 'addresses show'} less USDT on chain than the trades’ money recorded there.
            </strong>{' '}
            A reading taken just before a delivery catches up within a minute; a gap that survives a refresh is money that left outside the platform.
          </Notice>
        ) : null}

        <Section
          title="Custody positions"
          count={view.custody.length}
          hint={`A USDT payout or refund leaves an address only against a reading under ${Math.round(view.maxObservationAgeSeconds / 60)} minutes old that shows it free there — and only from the address holding that trade’s money (D-16).`}
          flush
        >
          <CustodyTable positions={view.custody} canRefresh={canRefresh} />
        </Section>

        <Section title="Treasury wallets" count={view.wallets.length} hint="Watch-only. Reserved is only ever a trade accepted before D-16: no trade reserves treasury USDT any more." flush>
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
          title="Chain providers"
          count={view.providers.length}
          hint="Detection reads through the first provider that answers; confirmation asks every one and never confirms on a single word above the D-05 threshold."
          flush
        >
          <ProvidersTable providers={view.providers} />
        </Section>

        {view.backfills.length > 0 ? (
          <Section title="Backfills" count={view.backfills.length} hint="Historical ranges read again for named exchange addresses (TD-06). The scanner cursor never moves for them." flush>
            <BackfillsTable backfills={view.backfills} />
          </Section>
        ) : null}

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
