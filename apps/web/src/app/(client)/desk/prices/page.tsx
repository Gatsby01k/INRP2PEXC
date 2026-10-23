import { redirect } from 'next/navigation';
import { deskPricing, deskWorkspace } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { DeskHead } from '../_ui/DeskHead.tsx';
import { DeskStatus } from '../_ui/DeskStatus.tsx';
import { PricesEditor } from './PricesEditor.tsx';
import { TagIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/** The desk's prices: what it pays a client for USDT and what it asks for it, with limits and how long they hold. */
export default async function DeskPricesPage() {
  const ctx = await memberPage();
  const ws = await deskWorkspace(ctx.db, ctx.actor.userId);
  if (!ws.desk) redirect('/desk');
  const pricing = await deskPricing(ctx.db, ctx.actor.userId);
  return (
    <>
      <DeskHead icon={<TagIcon />} title="Prices" status={<DeskStatus status={ws.desk.status} />} lede="Clients on your page are priced at these, instantly. Deal links carry their own rate." />
      <PricesEditor pricing={pricing} canCommit={ws.canCommit} />
    </>
  );
}
