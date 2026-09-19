import { headers } from 'next/headers';
import { getRuntime } from '../../server/runtime.ts';
import { surfaceForHost } from '../../server/surface.ts';
import { SignInForm } from './SignInForm.tsx';
import { ClientSignInForm } from './ClientSignInForm.tsx';
import styles from './sign-in.module.css';

export const dynamic = 'force-dynamic';

/**
 * Sign-in, for whichever product this host serves.
 *
 * The desk and the client app are two products with two authentication schemes — password plus authenticator
 * (SECURITY §2.1) and a code to a known address (§2.2) — and they never share a session. One page renders both
 * because the host already decides which is which; the form it shows is the only thing that differs, and neither
 * one says anything about the business before a session exists.
 */
export default async function SignInPage() {
  const surface = surfaceForHost((await headers()).get('host'), getRuntime().hosts);
  const client = surface === 'CLIENT';

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{client ? 'INRP2P Exchange' : 'INRP2P Desk'}</h1>
        <p className={styles.body}>
          {client
            ? 'Sign in with your work email. We send a six-digit code to the address the desk has on file for you.'
            : 'Operator access. Every action you take here is recorded against your account.'}
        </p>
        {client ? <ClientSignInForm /> : <SignInForm />}
      </div>
    </main>
  );
}
