import { redirect } from 'next/navigation';
import { invitesForUser } from '@inrp2p/clients';
import { workspacePage } from '../../../server/client.ts';
import { safeReturnPath } from '../../../server/surface.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { OpenAccount } from './OpenAccount.tsx';
import { UserIcon } from '../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * Opening an account (D-17): a person who signed in with the workspace code and has no account yet names it and
 * opens it — no operator admits them. Anyone who already has an account goes where it lives.
 */
export default async function OpenAccountPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const ctx = await workspacePage();
  // Someone who came from a desk's page or a deal link goes back there once the account exists.
  const next = safeReturnPath((await searchParams).next);
  if (ctx.access.kind === 'MEMBER') redirect(next ?? (ctx.access.member.exchangeAccess ? '/exchange' : '/traders'));
  return (
    <>
      <PageHead icon={<UserIcon />} title="Open your account" lede="Name the account you will trade under. The Exchange opens the moment it exists." />
      <OpenAccount email={ctx.access.email} invites={await invitesForUser(ctx.db, ctx.actor.userId)} {...(next ? { next } : {})} />
    </>
  );
}
