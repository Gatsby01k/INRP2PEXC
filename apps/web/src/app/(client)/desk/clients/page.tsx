import { redirect } from 'next/navigation';
import { deskClients } from '@inrp2p/quotes';
import { deskWorkspace } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { DeskHead } from '../_ui/DeskHead.tsx';
import { DeskStatus } from '../_ui/DeskStatus.tsx';
import { ClientsScreen } from './ClientsScreen.tsx';

export const dynamic = 'force-dynamic';

/** The desk's clients: who deals with it, how much, and on what terms — its own limit and note for each. */
export default async function DeskClientsPage() {
  const ctx = await memberPage();
  const ws = await deskWorkspace(ctx.db, ctx.actor.userId);
  if (!ws.desk) redirect('/desk');
  const clients = await deskClients(ctx.db, ws.desk.id);
  return (
    <>
      <DeskHead title="Clients" status={<DeskStatus status={ws.desk.status} />} lede="Everyone who came to your desk through your page or a link. They are yours: no other desk sees them." />
      <ClientsScreen clients={clients} canCommit={ws.canCommit} />
    </>
  );
}
