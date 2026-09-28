import { notFound } from 'next/navigation';
import { collectionAccounts, deskTraders } from '@inrp2p/traders';
import { can, operatorPage } from '../../../server/operator.ts';
import { KpiBand, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { ProgramForm } from './ProgramForm.tsx';
import { TraderList } from './TraderList.tsx';

export const dynamic = 'force-dynamic';

/**
 * Traders, for the desk (`traders:view`): new applications and settlement changes to review first, then every trader
 * with what matters for routing, and the programme settings beside them. Anyone can apply through "Become a trader";
 * nothing an applicant submits is usable until it is verified here.
 */
export default async function TradersDeskPage() {
  const ctx = await operatorPage();
  if (!can(ctx, 'traders:view')) notFound();
  const [{ program, traders }, accounts] = await Promise.all([deskTraders(ctx.db), collectionAccounts(ctx.db)]);
  const review = traders.filter((t) => t.status === 'UNDER_REVIEW').length;
  const changes = traders.filter((t) => t.status !== 'UNDER_REVIEW' && t.awaitingReview > 0).length;
  const online = traders.filter((t) => t.status === 'APPROVED' && t.available).length;
  const approved = traders.filter((t) => t.status === 'APPROVED' || t.status === 'PAUSED').length;
  const unresolved = traders.reduce((n, t) => n + t.unresolved, 0);
  const open = traders.reduce((n, t) => n + t.openOrders, 0);

  return (
    <Page>
      <PageHeader title="Traders" meta={`${review} new application${review === 1 ? '' : 's'} · ${changes} settlement change${changes === 1 ? '' : 's'} to review`} />
      <PageBody>
        <KpiBand
          label="Trader programme"
          items={[
            { key: 'r', label: 'To review', value: String(review + changes), sub: `${review} application${review === 1 ? '' : 's'} · ${changes} change${changes === 1 ? '' : 's'}`, ...(review + changes > 0 ? { tone: 'warning' as const } : {}) },
            { key: 'o', label: 'Online now', value: `${online} of ${approved}`, sub: 'approved traders taking work' },
            { key: 'n', label: 'Open orders', value: String(open), sub: 'accepted or in progress' },
            { key: 'u', label: 'Unresolved', value: String(unresolved), sub: 'orders that need the desk', ...(unresolved > 0 ? { tone: 'danger' as const } : {}) },
            { key: 'w', label: 'Reward', value: program.rewardBps === null ? 'none' : `${program.rewardBps} bps`, sub: program.autoAssign ? 'auto-assign on' : 'assigned by the desk' },
          ]}
        />
        <Section title="Traders" count={traders.length} flush>
          <TraderList traders={traders} />
        </Section>
        <Section title="Programme" hint="The defaults every approval starts from. Nothing here stands in for a decision: a reserve or reward stays unset until someone sets it.">
          <ProgramForm program={program} accounts={accounts} canConfigure={can(ctx, 'traders:configure')} />
        </Section>
      </PageBody>
    </Page>
  );
}
