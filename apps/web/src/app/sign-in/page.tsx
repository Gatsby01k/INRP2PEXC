import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getImageProps } from 'next/image';
import mark from '../../../../../brand/inrp2p-mark.png';
import { getRuntime } from '../../server/runtime.ts';
import { publicOrigin } from '../../server/site.ts';
import { safeReturnPath, surfaceForHost } from '../../server/surface.ts';
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
 * arrives in from the home page's "Open workspace"; the desk's is one card on the brand's paper — the mark, the name,
 * the form. Neither says anything about the business before a session exists.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (await isClientHost()) {
    // The way back is the public site's; the way in for someone new is this page itself (D-17). Signed in, the person
    // goes on to where they were headed — a desk's page or a deal link — when the proxy remembered it.
    const next = safeReturnPath((await searchParams).next);
    return <WorkspaceGateway home={await publicOrigin()} {...(next ? { next } : {})} />;
  }

  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 44, height: 44 });
  return (
    <main className={styles.page}>
      <div className={styles.backdrop} aria-hidden="true">
        <span className={styles.glow} />
      </div>
      <div className={styles.card}>
        <div className={styles.brand}>
          <img {...markProps} className={styles.mark} />
          <span className={styles.brandText}>
            <span className={styles.brandName}>INRP2P</span>
            <span className={styles.brandSub}>Operator desk</span>
          </span>
        </div>
        <div className={styles.intro}>
          <h1 className={styles.title}>Sign in to the desk</h1>
          <p className={styles.body}>Operator access. Every action you take here is recorded against your account.</p>
        </div>
        <SignInForm />
      </div>
    </main>
  );
}
