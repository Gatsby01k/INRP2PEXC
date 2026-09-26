import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ONBOARDING } from '../../content/site.ts';
import { getRuntime } from '../../server/runtime.ts';
import { onboardingHref, publicOrigin } from '../../server/site.ts';
import { surfaceForHost } from '../../server/surface.ts';
import { SignInForm } from './SignInForm.tsx';
import { WorkspaceGateway } from './WorkspaceGateway.tsx';
import styles from './sign-in.module.css';

export const dynamic = 'force-dynamic';

async function isClientHost(): Promise<boolean> {
  return surfaceForHost((await headers()).get('host'), getRuntime().hosts) === 'CLIENT';
}

export async function generateMetadata(): Promise<Metadata> {
  return (await isClientHost()) ? { title: 'Workspace access — INRP2P Exchange' } : {};
}

/**
 * Sign-in, for whichever product this host serves.
 *
 * The desk and the client app are two products with two authentication schemes — password plus authenticator
 * (SECURITY §2.1) and a code to a known address (§2.2) — and they never share a session. One page renders both
 * because the host already decides which is which. The client's is the workspace gateway, the room a client
 * arrives in from the home page's "Open workspace"; the desk's is a plain card. Neither says anything about the
 * business before a session exists.
 */
export default async function SignInPage() {
  if (await isClientHost()) {
    // The way back and the way in for someone who is not a client yet are the public site's; an onboarding address
    // that is not configured is not offered (server/site.ts).
    return <WorkspaceGateway home={await publicOrigin()} onboarding={onboardingHref()} unlinked={ONBOARDING.unlinked} />;
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>INRP2P Desk</h1>
        <p className={styles.body}>Operator access. Every action you take here is recorded against your account.</p>
        <SignInForm />
      </div>
    </main>
  );
}
