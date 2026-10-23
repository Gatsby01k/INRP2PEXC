import { redirect } from 'next/navigation';
import { deskDealLinks } from '@inrp2p/quotes';
import { currentFeePolicy, deskDeals, deskPriceViews, deskWorkspace } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { DeskHead } from '../_ui/DeskHead.tsx';
import { DeskStatus } from '../_ui/DeskStatus.tsx';
import { NewDealSheet } from '../_ui/NewDealSheet.tsx';
import { DealsScreen } from './DealsScreen.tsx';

export const dynamic = 'force-dynamic';

const TABS = ['open', 'done', 'links'] as const;
type Tab = (typeof TABS)[number];

/** The desk's deals: open (a price a client holds, or settling), done, and the links it sent. */
export default async function DeskDealsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await memberPage();
  const ws = await deskWorkspace(ctx.db, ctx.actor.userId);
  if (!ws.desk) redirect('/desk');
  const { tab: raw } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'open';
  const data = tab === 'links' ? await deskDeals(ctx.db, ctx.actor.userId, 'open') : await deskDeals(ctx.db, ctx.actor.userId, tab);
  const links = tab === 'links' ? await deskDealLinks(ctx.db, ws.desk.id) : null;
  const prices = await deskPriceViews(ctx.db, ws.desk.id);
  const fee = await currentFeePolicy(ctx.db);
  return (
    <>
      <DeskHead
        title="Deals"
        status={<DeskStatus status={ws.desk.status} />}
        lede="Every deal your clients made with your desk — from your page and from your links."
        aside={<NewDealSheet deskName={ws.desk.displayName} feeBps={fee.ownDealBps} prices={prices} status={ws.desk.status} canCommit={ws.canCommit} />}
      />
      <DealsScreen tab={tab} deals={data.deals} periods={data.periods} links={links} now={data.now} canCommit={ws.canCommit} />
    </>
  );
}
