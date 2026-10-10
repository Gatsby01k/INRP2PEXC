import { redirect } from 'next/navigation';
import { workspacePage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { OpenAccount } from './OpenAccount.tsx';

export const dynamic = 'force-dynamic';

/**
 * Opening an account (D-17): a person who signed in with the workspace code and has no account yet names it and
 * opens it — no operator admits them. Anyone who already has an account goes where it lives.
 */
export default async function OpenAccountPage() {
  const ctx = await workspacePage();
  if (ctx.access.kind === 'MEMBER') redirect(ctx.access.member.exchangeAccess ? '/exchange' : '/traders');
  return (
    <>
      <PageHead eyebrow="Workspace" title="Open your account" lede="Name the account you will trade under. The Exchange opens as soon as it exists." />
      <OpenAccount email={ctx.access.email} />
    </>
  );
}
