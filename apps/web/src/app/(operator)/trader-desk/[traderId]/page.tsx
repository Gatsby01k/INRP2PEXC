import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { payoutAccounts, treasuryWallets } from '@inrp2p/desk';
import { type DeskTraderDetail, deskTrader } from '@inrp2p/traders';
import { can, operatorPage } from '../../../../server/operator.ts';
import { dateTime, inr, titleCase, usdt } from '../../_desk/format.ts';
import { Chip, Columns, KpiBand, Page, PageBody, PageHeader, Section, Stack, Timeline } from '../../_desk/ui.tsx';
import { StatusChip } from '../TraderList.tsx';
import { TraderControls } from './TraderControls.tsx';
import { TraderMoney } from './TraderMoney.tsx';
import { TraderOrders } from './TraderOrders.tsx';
import { TraderReview } from './TraderReview.tsx';
import d from '../../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

/** Audit actions in the words the desk uses: `trader.destination_verified` → "Destination verified". */
const decisionTitle = (action: string): string => titleCase(action.replace(/^trader(_\w+)?\./, ''));

/** One trader: the decision controls, its registered details, its reserve and rewards, its orders — and the record. */
export default async function TraderDeskPage({ params }: { params: Promise<{ traderId: string }> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'traders:view')) notFound();
  const { traderId } = await params;
  let detail: DeskTraderDetail;
  try {
    detail = await deskTrader(ctx.db, traderId);
  } catch (e) {
    if (isDomainError(e) && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGUMENT')) notFound();
    throw e;
  }
  const [accounts, wallets] = await Promise.all([payoutAccounts(ctx.db), treasuryWallets(ctx.db)]);
  const t = detail.trader;
  const perms = {
    configure: can(ctx, 'traders:configure'),
    pause: can(ctx, 'traders:pause'),
    assign: can(ctx, 'traders:assign'),
    record: can(ctx, 'trader_payout:record'),
    confirm: can(ctx, 'trader_payout:confirm'),
    routeRecord: can(ctx, 'route_settlement:record'),
    routeConfirm: can(ctx, 'route_settlement:confirm'),
    reveal: can(ctx, 'bank_account:reveal'),
  };
  const short = /[1-9]/.test(detail.reserve.shortfall);
  const underReview = t.status === 'UNDER_REVIEW';
  const decisions = (
    <Section title="Decisions" count={detail.decisions.length} hint="Every decision the desk took about this trader, with its reason.">
      {detail.decisions.length === 0 ? (
        <p className={d.fieldHint}>Nothing recorded yet.</p>
      ) : (
        <Timeline events={detail.decisions.map((x, i) => ({ key: `${x.at}:${i}`, title: decisionTitle(x.action), meta: x.detail || undefined, time: dateTime(x.at) }))} />
      )}
    </Section>
  );

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: '/trader-desk', label: 'Traders' }]}
        title={`${t.ref} · ${t.clientName}`}
        badge={
          <span className={d.row}>
            <StatusChip t={t} />
            {t.assignmentsEnabled ? null : <Chip tone="warning">assignments off</Chip>}
          </span>
        }
        meta={`applied ${dateTime(t.appliedAt)}`}
      />
      <PageBody>
        <KpiBand
          label="Trader figures"
          items={underReview ? [
            { key: 'p', label: 'Provides', value: t.sides.map((x) => (x === 'BUY_USDT' ? 'INR' : 'USDT')).join(' · ') || '—', sub: 'what the trader offers the desk' },
            { key: 'i', label: 'Typical INR order', value: t.typicalInr ? inr(t.typicalInr) : '—' },
            { key: 'u', label: 'Typical USDT order', value: t.typicalUsdt ? usdt(t.typicalUsdt) : '—' },
            { key: 'v', label: 'Details verified', value: `${[detail.bank.status, detail.wallet.status].filter((x) => x === 'ACTIVE').length} of 2`, sub: 'bank account and wallet', ...([detail.bank.status, detail.wallet.status].some((x) => x !== 'ACTIVE') ? { tone: 'warning' as const } : {}) },
          ] : [
            { key: 'r', label: 'Security Reserve', value: usdt(detail.reserve.balance), sub: detail.reserve.required ? `of ${usdt(detail.reserve.required)} required` : 'requirement not set', ...(short ? { tone: 'warning' as const } : {}) },
            { key: 'o', label: 'Open orders', value: String(t.openOrders), sub: t.offers > 0 ? `${t.offers} offered` : 'none offered' },
            { key: 'u', label: 'Unresolved', value: String(t.unresolved), ...(t.unresolved > 0 ? { tone: 'danger' as const } : {}) },
            { key: 'c', label: 'Completed orders', value: String(t.completedOrders), sub: `${usdt(detail.earnings.completedUsdt)}` },
            { key: 'e', label: 'Rewards unpaid', value: inr(detail.earnings.available), sub: detail.earnings.rewardBps === null ? 'no reward' : `${detail.earnings.rewardBps} bps` },
          ]}
        />
        {underReview ? (
          // An application: the only work is the review. Verify each submitted detail, then decide — orders, reserve
          // and rewards have nothing to show until the trader is approved.
          <Columns>
            <Stack>
              <Section title="Application" hint="Verify the bank account and the wallet one at a time; the decision beside this waits for both.">
                <TraderReview detail={detail} perms={perms} />
              </Section>
              {decisions}
            </Stack>
            <Section>
              <TraderControls detail={detail} perms={perms} />
            </Section>
          </Columns>
        ) : (
          <Columns>
            <Stack>
              <Section title="Orders" count={detail.orders.length}>
                <TraderOrders detail={detail} accounts={accounts} wallets={wallets} perms={perms} />
              </Section>
              <TraderMoney detail={detail} accounts={accounts} perms={perms} />
              {decisions}
            </Stack>
            <Stack>
              <Section>
                <TraderControls detail={detail} perms={perms} />
              </Section>
              <Section>
                <TraderReview detail={detail} perms={perms} />
              </Section>
            </Stack>
          </Columns>
        )}
      </PageBody>
    </Page>
  );
}
