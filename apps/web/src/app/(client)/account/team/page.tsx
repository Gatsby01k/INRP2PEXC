import { clientTeam } from '@inrp2p/clients';
import { memberPage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { TeamScreen } from './TeamScreen.tsx';
import { UsersIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/** The account's team: who can act for it, and the invitations waiting (ADR 0020 §2.11). */
export default async function TeamPage() {
  const ctx = await memberPage();
  const team = await clientTeam(ctx.db, ctx.member.clientId, ctx.actor.userId);
  return (
    <>
      <PageHead icon={<UsersIcon />} eyebrow="Account" title="Team" lede="The people who act for your account, and what each of them can do." />
      <TeamScreen members={team.members} invites={team.invites} isAdmin={ctx.member.role === 'CLIENT_ADMIN'} clientName={ctx.member.clientName} />
    </>
  );
}
