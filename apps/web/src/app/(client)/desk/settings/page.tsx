import { redirect } from 'next/navigation';
import { deskPriceViews, deskWorkspace } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { publicOrigin } from '../../../../server/site.ts';
import { DeskHead } from '../_ui/DeskHead.tsx';
import { DeskStatus } from '../_ui/DeskStatus.tsx';
import { DeskSettings } from './DeskSettings.tsx';
import { GlobeIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/** The desk's page: how clients see it, its name and description, its address, and whether it takes deals. */
export default async function DeskSettingsPage() {
  const ctx = await memberPage();
  const ws = await deskWorkspace(ctx.db, ctx.actor.userId);
  if (!ws.desk) redirect('/desk');
  const prices = await deskPriceViews(ctx.db, ws.desk.id);
  const host = (await publicOrigin()).replace(/^https?:\/\//, '');
  return (
    <>
      <DeskHead icon={<GlobeIcon />} title="Page" status={<DeskStatus status={ws.desk.status} />} lede="What a client sees at your address, and whether your desk is taking deals." />
      <DeskSettings desk={ws.desk} prices={prices} host={host} canAdmin={ws.canAdmin} approved={ws.traderStatus === 'APPROVED'} />
    </>
  );
}
