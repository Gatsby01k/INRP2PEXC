import { notFound } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import { feePolicyView, openDisputes, opsDesks } from '@inrp2p/traders';
import { can, operatorPage } from '../../../server/operator.ts';
import { usdt } from '../_desk/format.ts';
import { KpiBand, LinkTabs, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { DeskDisputes, DeskOpsList } from './DeskOpsList.tsx';
import { FeePanel } from './FeePanel.tsx';

export const dynamic = 'force-dynamic';

const TABS = ['desks', 'disputes', 'fees'] as const;
type Tab = (typeof TABS)[number];

/**
 * Desks, for INRP2P's desk (`desks:view`, ADR 0020 §2.17): every trader's own exchange — the ones that need INRP2P first
 * (suspended, a hidden page they have changed since) — the P2P disputes waiting for a decision, and the platform's fee,
 * changed only by one person's proposal and another's approval.
 */
export default async function DeskOpsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'desks:view')) notFound();
  const tab: Tab = TABS.includes((await searchParams).tab as Tab) ? ((await searchParams).tab as Tab) : 'desks';
  const [desks, disputes, fees] = await Promise.all([opsDesks(ctx.db), openDisputes(ctx.db), feePolicyView(ctx.db)]);
  const live = desks.filter((x) => x.status === 'LIVE').length;
  const suspended = desks.filter((x) => x.status === 'SUSPENDED').length;
  const hidden = desks.filter((x) => x.pageHidden).length;
  const review = desks.filter((x) => x.editedSinceHidden).length;
  const fees30Text = desks.reduce((t, x) => t.add(Money.parse(x.fees30d, 'USDT')), Money.ofMinor(0n, 'USDT')).toDecimalString();

  return (
    <Page>
      <PageHeader
        title="Desks"
        meta={`${desks.length} desk${desks.length === 1 ? '' : 's'} · ${live} live`}
        tabs={
          <LinkTabs
            label="Desks"
            items={[
              { href: '/desk-ops', label: 'Desks', count: desks.length, current: tab === 'desks', ...(review > 0 ? { tone: 'brand' as const } : {}) },
              { href: '/desk-ops?tab=disputes', label: 'Disputes', count: disputes.length, current: tab === 'disputes', tone: 'danger' },
              { href: '/desk-ops?tab=fees', label: 'Fee', count: fees.proposal ? 1 : 0, current: tab === 'fees', tone: 'brand' },
            ]}
          />
        }
      />
      <PageBody>
        <KpiBand
          label="Desks"
          items={[
            { key: 'l', label: 'Live', value: `${live} of ${desks.length}`, sub: 'taking deals now' },
            { key: 's', label: 'Suspended', value: String(suspended), sub: 'by INRP2P', ...(suspended > 0 ? { tone: 'warning' as const } : {}) },
            { key: 'h', label: 'Pages hidden', value: String(hidden), sub: review > 0 ? `${review} changed since — look again` : 'none changed since', ...(review > 0 ? { tone: 'warning' as const } : {}) },
            { key: 'd', label: 'Open disputes', value: String(disputes.length), sub: 'P2P payments to decide', ...(disputes.length > 0 ? { tone: 'danger' as const } : {}) },
            { key: 'f', label: 'Fees · 30 days', value: usdt(fees30Text), sub: `${fees.current.ownDealBps} bps on a desk’s own deal` },
          ]}
        />
        {tab === 'desks' ? (
          <Section title="Desks" count={desks.length} flush>
            <DeskOpsList desks={desks} />
          </Section>
        ) : tab === 'disputes' ? (
          <Section title="Open disputes" count={disputes.length} hint="Oldest first. Each is decided on its trade, from the payee’s bank: paid or not paid." flush>
            <DeskDisputes disputes={disputes} />
          </Section>
        ) : (
          <FeePanel fees={fees} meId={ctx.actor.userId} perms={{ propose: can(ctx, 'fees:propose'), approve: can(ctx, 'fees:approve') }} />
        )}
      </PageBody>
    </Page>
  );
}
