'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Ends the desk session through Better Auth, which audits the logout and clears the cookie. */
export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="ix-linkish"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        } finally {
          router.push('/sign-in');
          router.refresh();
        }
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
