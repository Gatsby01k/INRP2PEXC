import Link from 'next/link';
import { isDomainError } from '@inrp2p/kernel';
import { deskApprovals, deskExceptions, deskNow, deskTrade } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { ContextPanel, PanelSection } from '../_desk/ContextPanel.tsx';
import { LiveRefresh } from '../_desk/Keyboard.tsx';
import { age, caseTitle, dateTime, money } from '../_desk/format.ts';
import { Chip, Empty, KpiBand, LinkTabs, Notice, Page, PageBody, PageHeader, Section, Side } from '../_desk/ui.tsx';
import { CaseCard } from '../_trade/Cases.tsx';
import { AdjustmentItem } from '../_trade/Closeout.tsx';
import { tradePerms } from '../_trade/perms.ts';
import { CasesTable } from './CasesTable.tsx';
import q from '../queue.module.css';
import d from '../_desk/desk.module.css';
import t from '../_trade/trade.module.css';

export const dynamic = 'force-dynamic';

const SUBJECT: Record<string, string> = {
  TRADE: 'trade',
  SETTLEMENT_LEG: 'settlement leg',
  FIAT_TRANSFER: 'bank transfer',
  CRYPTO_TRANSFER: 'on-chain transfer',
  DEPOSIT_ADDRESS: 'deposit address',
  ROUTE_OBLIGATION: 'route obligation',
  ROUTE_SETTLEMENT: 'route settlement',
  INR_ACCOUNT: 'INR account',
  CLIENT: 'client',
};

/**
 * Exceptions (UX_FLOWS F6), desk-wide. The queue shows a trade on hold; this is where every open case is worked —
 * including the ones no trade owns: funds at an address nobody was told to use, a deposit pool running dry, a bank
 * line the desk never recorded. The second tab is the other kind of waiting work: a financial adjustment or a
 * refund that one person asked for and a different person has to decide (FI-31, SECURITY §4).
 */
export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const tab = params.tab === 'approvals' ? 'approvals' : 'cases';
  const caseId = typeof params.case === 'string' ? params.case : null;
  const [cases, approvals, now] = await Promise.all([deskExceptions(ctx.db), deskApprovals(ctx.db, ctx.access), deskNow(ctx.db)]);
  const perms = tradePerms(ctx);
  const selected = caseId ? (cases.find((c) => c.id === caseId) ?? null) : null;
  let trade = null;
  if (selected?.trade) {
    try {
      trade = await deskTrade(ctx.db, selected.trade.id, ctx.access);
    } catch (e) {
      if (!(isDomainError(e) && e.code === 'NOT_FOUND')) throw e;
    }
  }
  const nowMs = new Date(now).getTime();
  const blocking = cases.filter((c) => c.severity === 'BLOCKING');
  const unassigned = cases.filter((c) => c.takenBy === null);
  const oldest = cases.reduce<string | null>((acc, c) => (acc === null || c.openedAt < acc ? c.openedAt : acc), null);
  const approvalCount = approvals.adjustments.length + approvals.refunds.length;
  const approver = can(ctx, 'adjustment:approve') || can(ctx, 'refund:approve');

  return (
    <Page fixed={tab === 'cases'}>
      <PageHeader
        title="Exceptions"
        meta={`${cases.length} open · ${blocking.length} blocking · ${approvalCount} waiting for a second person`}
        tabs={
          <LinkTabs
            label="Exception views"
            items={[
              { href: '/exceptions', label: 'Open cases', count: cases.length, ...(blocking.length > 0 ? { tone: 'danger' as const } : {}), current: tab === 'cases' },
              { href: '/exceptions?tab=approvals', label: 'Approvals', count: approvalCount, ...(approver && approvalCount > 0 ? { tone: 'brand' as const } : {}), current: tab === 'approvals' },
            ]}
          />
        }
      />
      <LiveRefresh seconds={30} />
      {tab === 'cases' ? (
        <>
          <div className={q.strip}>
            <KpiBand
              label="Exception summary"
              items={[
                { key: 'b', label: 'Blocking', value: String(blocking.length), sub: 'each one holds a trade or a flow', ...(blocking.length > 0 ? { tone: 'danger' as const } : {}) },
                { key: 'w', label: 'Warnings', value: String(cases.length - blocking.length), sub: 'the work keeps moving' },
                { key: 'u', label: 'Unassigned', value: String(unassigned.length), sub: 'nobody has taken them', ...(unassigned.length > 0 ? { tone: 'warning' as const } : {}) },
                { key: 'n', label: 'Without a trade', value: String(cases.filter((c) => !c.trade).length), sub: 'deposits, pool, statements' },
                { key: 'o', label: 'Oldest open', value: oldest ? age(oldest, nowMs) : '—', sub: oldest ? `since ${dateTime(oldest)}` : 'nothing open' },
              ]}
            />
          </div>
          <div className={q.split} {...(selected ? { 'data-panel': '' } : {})}>
            <div className={q.list}>
              <CasesTable
                cases={cases.map((c) => ({
                  ...c,
                  title: caseTitle(c.type),
                  subject: c.trade ? null : (SUBJECT[c.subjectType] ?? c.subjectType.toLowerCase()),
                }))}
                selected={selected?.id ?? null}
                meId={perms.meId}
              />
            </div>
            {selected ? (
              <div className={q.panelCol}>
                <ContextPanel
                  refLabel={selected.ref}
                  title={caseTitle(selected.type)}
                  subtitle={selected.trade ? `${selected.trade.ref} · ${selected.trade.clientName}` : `No trade · ${SUBJECT[selected.subjectType] ?? selected.subjectType}`}
                  badges={
                    <>
                      <Chip tone={selected.severity === 'BLOCKING' ? 'danger' : 'warning'}>{selected.severity === 'BLOCKING' ? 'Blocking' : 'Warning'}</Chip>
                      {selected.trade ? <Side direction={selected.trade.direction} /> : null}
                    </>
                  }
                  closeHref="/exceptions"
                  {...(selected.trade ? { recordHref: `/orders/${encodeURIComponent(selected.trade.ref)}` } : {})}
                  testId="case-panel"
                  label={`Case ${selected.ref}`}
                >
                  {trade ? (
                    <PanelSection title="Trade">
                      <Notice icon="orders">
                        {trade.ref} · {money(trade.base, 'USDT')} · {trade.hold ? 'on hold' : trade.lifecycle.toLowerCase().replace(/_/g, ' ')} ·{' '}
                        <Link href={`/?row=trade:${trade.tradeId}&do=exception`}>open on the desk</Link>
                      </Notice>
                    </PanelSection>
                  ) : null}
                  <CaseCard c={selected} perms={perms} trade={trade} />
                </ContextPanel>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <PageBody>
          {!approver ? <Notice icon="shield">Deciding adjustments and confirming refunds needs the owner or finance role. The list is here so everyone can see what is waiting.</Notice> : null}
          <Section title="Adjustments waiting for approval" count={approvals.adjustments.length} hint="Requested by one person, approved or rejected by another. Nothing posts until then.">
            {approvals.adjustments.length === 0 ? (
              <Empty title="No adjustment is waiting" />
            ) : (
              <ul className={t.legs}>
                {approvals.adjustments.map((a) => (
                  <AdjustmentItem key={a.id} a={a} perms={perms} showTrade />
                ))}
              </ul>
            )}
          </Section>
          <Section title="Refunds waiting to be confirmed" count={approvals.refunds.length} hint="Planned by one person; confirmed, with the bank or chain evidence, by another.">
            {approvals.refunds.length === 0 ? (
              <Empty title="No refund is waiting" />
            ) : (
              <ul className={t.legs}>
                {approvals.refunds.map((r) => (
                  <li key={r.legId} className={t.leg} data-attention="">
                    <div className={t.legHead}>
                      <span className={t.legAmount}>
                        {money(r.amount, r.asset, { exact: r.asset === 'USDT' })} refund <span className={d.muted}>· {r.tradeRef} · {r.clientName}</span>
                      </span>
                      <Link className={d.linkButton} href={`/orders/${encodeURIComponent(r.tradeRef)}`}>
                        Open trade record
                      </Link>
                    </div>
                    <div className={t.legMeta}>
                      <span>{r.legRef}</span>
                      <span>
                        planned by <strong>{r.createdBy === perms.meId ? 'you' : r.createdByLabel}</strong> · {dateTime(r.createdAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </PageBody>
      )}
    </Page>
  );
}
