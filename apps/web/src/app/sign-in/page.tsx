import { SignInForm } from './SignInForm.tsx';
import styles from './sign-in.module.css';

export const dynamic = 'force-dynamic';

/**
 * The desk sign-in (SECURITY §2.1): password, then the authenticator code. It is the only page on the desk host
 * that renders without a session, and it shows nothing about the business — not a client name, not a figure.
 */
export default function SignInPage() {
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
