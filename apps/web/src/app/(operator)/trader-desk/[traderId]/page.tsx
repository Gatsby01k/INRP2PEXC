import { notFound } from 'next/navigation';
import { Money, isDomainError } from '@inrp2p/kernel';
import { type DeskTraderDetail, deskTrader } from '@inrp2p/traders';
import { can, operatorPage } from '../../../../server/operator.ts';
import { dateTime, inr, share, titleCase, usdt, usdtCompact } from '../../_desk/format.ts';
import { LinkTabs, Page, PageBody, PageHeader, Timeline } from '../../_desk/ui.tsx';
import { FieldMeter, Hero, Monogram, Sheet, Stats, Steps, bookStyles as b } from '../../_book/parts.tsx';
import { StatusChip, TIER_WORD, type TraderPerms, provides } from '../words.tsx';
import { ApplicantSheet, RegisteredSheet } from './Profile.tsx';
import { ApplicationReview } from './Application.tsx';
import { Capacity } from './Capacity.tsx';
import { Controls, Settles, Terms } from './Controls.tsx';
import { Proposal } from './Proposal.tsx';
import { TraderMoney } from './TraderMoney.tsx';
import { TraderOrders } from './TraderOrders.tsx';
import d from '../../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

/** Audit actions in the words the desk uses: `trader.destination_verified` → "Destination verified". */
const decisionTitle = (action: string): string => titleCase(action.replace(/^trader(_\w+)?\./, ''));

type Tab = 'orders' | 'reserve' | 'details' | 'history';
const TABS: readonly Tab[] = ['orders', 'reserve', 'details', 'history'];

/**
 * One trader. An application is one job — verify the bank account, verify the wallet, decide — so its page is that job
 * and nothing else. An approved trader's page opens on whether it can be given work now (the orange field is its Security
 * Reserve, the steps beside it what routing checks), then its orders, reserve, details and record one tab at a time, with
 * the desk's controls and the trader's own prices and terms beside them.
 */
export default async function TraderDeskPage({ params, searchParams }: { params: Promise<{ traderId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'traders:view')) notFound();
  const { traderId } = await params;
  const query = await searchParams;
  let detail: DeskTraderDetail;
  try {
    detail = await deskTrader(ctx.db, traderId);
  } catch (e) {
    if (isDomainError(e) && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGUMENT')) notFound();
    throw e;
  }
  const t = detail.trader;
  const perms: TraderPerms = {
    configure: can(ctx, 'traders:configure'),
    pause: can(ctx, 'traders:pause'),
    assign: can(ctx, 'traders:assign'),
    record: can(ctx, 'trader_payout:record'),
    confirm: can(ctx, 'trader_payout:confirm'),
    routeRecord: can(ctx, 'route_settlement:record'),
    routeConfirm: can(ctx, 'route_settlement:confirm'),
    reveal: can(ctx, 'bank_account:reveal'),
    applyReserve: can(ctx, 'trader_reserve:apply'),
    approveReserve: can(ctx, 'trader_reserve:approve'),
    meId: ctx.actor.userId,
  };
  const underReview = t.status === 'UNDER_REVIEW';
  const stopped = t.status === 'PAUSED' || t.status === 'REJECTED';
  const history = (
    <Sheet title="History" count={detail.decisions.length} hint="Every decision about this trader, with its reason." label="History">
      {detail.decisions.length === 0 ? (
        <p className={b.quiet}>Nothing recorded yet.</p>
      ) : (
        <Timeline events={detail.decisions.map((x, i) => ({ key: `${x.at}:${i}`, title: decisionTitle(x.action), meta: x.detail || undefined, time: dateTime(x.at) }))} />
      )}
    </Sheet>
  );
  const header = (
    <PageHeader
      crumbs={[{ href: '/trader-desk', label: 'Traders' }]}
      title={
        <span className={b.who} style={{ gap: 'var(--space-3)' }}>
          <Monogram name={t.clientName} size={40} {...(stopped ? { tone: 'quiet' as const } : {})} />
          {t.clientName}
        </span>
      }
      badge={
        <span className={d.row}>
          <StatusChip t={t} />
          {t.status === 'APPROVED' && !t.assignmentsEnabled ? <span className={d.chip} data-tone="warning">no new orders</span> : null}
        </span>
      }
      meta={`${t.ref} · ${detail.applicant.entityType === 'COMPANY' ? 'company' : 'individual'} · ${detail.applicant.clientRef} · ${t.exchangeAccess ? 'also a client' : 'trader only'} · applied ${dateTime(t.appliedAt)}`}
    />
  );

  /* ── An application ───────────────────────────────────────────────────────────────────────────── */
  if (underReview || t.status === 'REJECTED') {
    const verified = [detail.bank.status, detail.wallet.status].filter((s) => s === 'ACTIVE').length;
    const toVerify = [detail.bank.status, detail.wallet.status].filter((s) => s === 'PENDING_REVIEW').length;
    return (
      <Page>
        {header}
        <PageBody>
          <Hero
            label="Application"
            eyebrow={t.status === 'REJECTED' ? 'Application · rejected' : `Application · ${dateTime(t.appliedAt)}`}
            figure={t.status === 'REJECTED' ? 'Rejected' : verified === 2 ? 'Ready to decide' : `${toVerify || 2 - verified} to verify`}
            sub={
              t.status === 'REJECTED'
                ? (t.reviewNote ?? 'The applicant was told why and may apply again.')
                : detail.program.autoReview
                  ? detail.autoReview.flags.length > 0
                    ? 'The programme’s rules left this for a person.'
                    : 'The programme’s rules approve it once the reserve lands from its wallet.'
                  : 'Every detail is checked by a person before approval.'
            }
            stages={verified as 0 | 1 | 2}
            stopped={t.status === 'REJECTED'}
            side={
              <>
                <Steps
                  label="The application, step by step"
                  items={[
                    { key: 'bank', name: 'Bank account', sub: stepWord(detail.bank.status), state: stepState(detail.bank.status) },
                    { key: 'wallet', name: 'TRC20 wallet', sub: stepWord(detail.wallet.status), state: stepState(detail.wallet.status) },
                    {
                      key: 'decide',
                      name: 'Decision',
                      sub: t.status === 'REJECTED' ? 'rejected' : verified === 2 ? 'ready — approve or reject' : 'waits for both details',
                      state: t.status === 'REJECTED' ? 'blocked' : verified === 2 ? 'now' : 'pending',
                    },
                  ]}
                />
                <Stats
                  label="What the applicant offers"
                  items={[
                    { key: 'p', label: 'Provides', value: provides(t.sides), sub: 'what it brings the desk' },
                    { key: 'i', label: 'INR typical', value: t.typicalInr ? inr(t.typicalInr) : '—', sub: detail.applicant.dailyInr ? `${inr(detail.applicant.dailyInr)} a day` : 'no daily figure', ...(t.typicalInr ? {} : { tone: 'muted' as const }) },
                    { key: 'u', label: 'USDT typical', value: t.typicalUsdt ? usdt(t.typicalUsdt) : '—', sub: detail.applicant.dailyUsdt ? `${usdt(detail.applicant.dailyUsdt)} a day` : 'no daily figure', ...(t.typicalUsdt ? {} : { tone: 'muted' as const }) },
                  ]}
                />
              </>
            }
          />
          <div className={b.columns}>
            <div className={b.main}>
              <ApplicationReview detail={detail} perms={perms} />
            </div>
            <div className={b.aside}>
              <ApplicantSheet detail={detail} perms={perms} />
              {history}
            </div>
          </div>
        </PageBody>
      </Page>
    );
  }

  /* ── An approved (or paused) trader ───────────────────────────────────────────────────────────── */
  const tab: Tab = typeof query.tab === 'string' && (TABS as readonly string[]).includes(query.tab) ? (query.tab as Tab) : 'orders';
  const r = detail.reserve;
  const short = /[1-9]/.test(r.shortfall);
  const verified = detail.bank.status === 'ACTIVE' && detail.wallet.status === 'ACTIVE';
  const lockedShare = share(r.locked, r.balance, 'USDT');
  const pendingShare = share(Money.parse(r.pendingRelease, 'USDT').add(Money.parse(r.applying, 'USDT')).toDecimalString(), r.balance, 'USDT');
  const href = (x: Tab) => (x === 'orders' ? `/trader-desk/${t.traderId}` : `/trader-desk/${t.traderId}?tab=${x}`);
  const waitingChange = [detail.proposal.bank?.status, detail.proposal.wallet?.status].some((s) => s === 'PENDING_REVIEW' || s === 'ACTIVE');

  return (
    <Page>
      {header}
      <PageBody>
        <Hero
          label="Trader at a glance"
          eyebrow={t.status === 'PAUSED' ? 'Paused · Security Reserve' : 'Security Reserve'}
          figure={
            <>
              {usdt(r.balance, { unit: false })}
              <small>USDT</small>
            </>
          }
          sub={r.required ? `${usdt(r.required)} required${short ? ` · short by ${usdt(r.shortfall, { exact: true })}` : ''}` : 'No requirement set yet'}
          foot={
            <div className={d.stackTight} style={{ gap: 8 }}>
              <FieldMeter
                label={`${usdt(r.locked, { exact: true })} locked by open orders, ${usdt(r.available, { exact: true })} free`}
                parts={[{ value: lockedShare }, { value: pendingShare, kind: 'locked' }]}
              />
              <span className={b.fieldLegend}>
                <span>
                  <b>{usdt(r.locked, { exact: true })}</b> locked by open orders
                </span>
                <span>
                  <b>{usdt(r.available, { exact: true })}</b> free to withdraw
                </span>
              </span>
            </div>
          }
          stages={stopped ? 1 : short || !verified ? 2 : 3}
          stopped={stopped}
          side={
            <>
              <Steps
                label="Can it be given work now"
                items={[
                  { key: 'online', name: t.available ? 'Online' : 'Offline', sub: t.available ? 'taking work now' : 'the trader is away', state: t.status === 'APPROVED' && t.available ? 'done' : 'pending' },
                  {
                    key: 'orders',
                    name: 'New orders',
                    sub: t.status === 'PAUSED' ? 'paused by the desk' : t.assignmentsEnabled ? 'may be offered' : 'stopped by the desk',
                    state: t.status === 'APPROVED' && t.assignmentsEnabled ? 'done' : 'blocked',
                  },
                  { key: 'reserve', name: 'Reserve', sub: !r.required ? 'no requirement set' : short ? `short by ${usdt(r.shortfall)}` : 'funded', state: !r.required || short ? 'blocked' : 'done' },
                  { key: 'details', name: 'Settlement details', sub: verified ? 'bank and wallet verified' : 'not both verified', state: verified ? 'done' : 'blocked' },
                ]}
              />
              <Stats
                label="Trader figures"
                items={[
                  { key: 'o', label: 'Open orders', value: String(t.openOrders), sub: t.offers > 0 ? `${t.offers} offered, waiting` : 'accepted or running', ...(t.openOrders === 0 ? { tone: 'muted' as const } : {}) },
                  { key: 'u', label: 'Unresolved', value: String(t.unresolved), sub: t.unresolved > 0 ? 'owed, not yet settled' : 'nothing owed', tone: t.unresolved > 0 ? ('danger' as const) : ('muted' as const) },
                  { key: 'c', label: 'Completed', value: String(t.completedOrders), sub: usdt(detail.earnings.completedUsdt), ...(t.completedOrders === 0 ? { tone: 'muted' as const } : {}) },
                  ...(t.risk
                    ? [
                        {
                          key: 'l',
                          label: 'Level',
                          value: `${TIER_WORD[t.risk.level] ?? t.risk.level}${t.risk.heldBack ? ' · held' : ''}`,
                          ...(/[1-9]/.test(t.risk.maxOpen)
                            ? {
                                sub: `${usdtCompact(t.risk.open).replace(' USDT', '')} of ${usdtCompact(t.risk.maxOpen).replace(' USDT', '')} open`,
                                meter: { value: share(t.risk.open, t.risk.maxOpen, 'USDT'), tone: 'brand' as const, label: 'Open deals against the limit' },
                              }
                            : { sub: 'no free reserve yet' }),
                        },
                      ]
                    : []),
                ]}
              />
            </>
          }
        />

        {waitingChange ? <Proposal detail={detail} perms={perms} /> : null}

        <div className={b.columns}>
          <div className={b.main}>
            <LinkTabs
              label="About this trader"
              items={[
                { href: href('orders'), label: 'Orders', count: detail.orders.length, current: tab === 'orders', ...(t.unresolved > 0 ? { tone: 'danger' as const } : {}) },
                { href: href('reserve'), label: 'Reserve', current: tab === 'reserve', ...(detail.applications.some((a) => a.status === 'REQUESTED') || detail.withdrawals.some((w) => w.status === 'REQUESTED' || w.status === 'SENT') ? { count: detail.applications.filter((a) => a.status === 'REQUESTED').length + detail.withdrawals.filter((w) => w.status === 'REQUESTED' || w.status === 'SENT').length, tone: 'brand' as const } : {}) },
                { href: href('details'), label: 'Details', current: tab === 'details' },
                { href: href('history'), label: 'History', count: detail.decisions.length, current: tab === 'history' },
              ]}
            />
            {tab === 'orders' ? (
              <Sheet title="Orders" count={detail.orders.length} hint="Newest first. A line in amber still owes money." flush label="Orders">
                <TraderOrders detail={detail} perms={perms} />
              </Sheet>
            ) : null}
            {tab === 'reserve' ? <TraderMoney detail={detail} perms={perms} /> : null}
            {tab === 'details' ? (
              <>
                <RegisteredSheet detail={detail} perms={perms} />
                <ApplicantSheet detail={detail} perms={perms} />
              </>
            ) : null}
            {tab === 'history' ? history : null}
          </div>
          <div className={b.aside}>
            <Controls detail={detail} perms={perms} />
            <Capacity detail={detail} />
            <Terms detail={detail} perms={perms} />
            <Settles detail={detail} perms={perms} />
          </div>
        </div>
      </PageBody>
    </Page>
  );
}

function stepState(status: string): 'done' | 'now' | 'blocked' | 'pending' {
  return status === 'ACTIVE' ? 'done' : status === 'PENDING_REVIEW' ? 'now' : status === 'REJECTED' ? 'blocked' : 'pending';
}

function stepWord(status: string): string {
  return status === 'ACTIVE' ? 'verified' : status === 'PENDING_REVIEW' ? 'waits for you' : status === 'REJECTED' ? 'rejected' : status.toLowerCase();
}
