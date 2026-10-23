import { redirect } from 'next/navigation';
import { clientTeam } from '@inrp2p/clients';
import { deskWorkspace } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { TeamScreen } from '../../account/team/TeamScreen.tsx';
import { DeskHead } from '../_ui/DeskHead.tsx';
import { DeskStatus } from '../_ui/DeskStatus.tsx';

export const dynamic = 'force-dynamic';

/** The desk's team: the account's people, seen from the desk (ADR 0020 §2.11). */
export default async function DeskTeamPage() {
  const ctx = await memberPage();
  const ws = await deskWorkspace(ctx.db, ctx.actor.userId);
  if (!ws.desk) redirect('/desk');
  const team = await clientTeam(ctx.db, ctx.member.clientId, ctx.actor.userId);
  return (
    <>
      <DeskHead title="Team" status={<DeskStatus status={ws.desk.status} />} lede="The people who run your desk with you. Operators work deals; administrators run the desk." />
      <TeamScreen members={team.members} invites={team.invites} isAdmin={ws.canAdmin} clientName={ws.desk.displayName} />
    </>
  );
}
