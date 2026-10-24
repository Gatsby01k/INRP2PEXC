'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { newIntentKey } from '../../../components/useCommand.tsx';

export type GuardedOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly stepUp?: true; readonly details?: Record<string, unknown> };

/**
 * One sensitive change, asked for once: a single idempotency key for the intent, and — when the command answers that
 * the authenticator is needed — a code asked for in place, after which the very same intent is sent again. The
 * component draws the code field (`needsCode`); this keeps the key, the retry and the refusals straight.
 */
export function useGuarded(send: (key: string) => Promise<GuardedOutcome>) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [done, setDone] = useState(false);

  const settle = (out: GuardedOutcome): boolean => {
    if (out.ok) {
      setNeedsCode(false);
      setDone(true);
      router.refresh();
      return true;
    }
    if (out.stepUp) {
      setNeedsCode(true);
      return false;
    }
    setError(out.code === 'MFA_ENROLLMENT_REQUIRED' ? 'Set up an authenticator first — Account & security.' : out.message || 'That could not be done. Try again.');
    return false;
  };

  const run = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    key.current ??= newIntentKey();
    try {
      return settle(await send(key.current));
    } catch {
      setError('The connection dropped before an answer came. Try again — it will not happen twice.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (code: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => null);
      if (!res?.ok) {
        setError('That code was not accepted. Enter the one your app shows now.');
        return false;
      }
      return settle(await send(key.current ?? newIntentKey()));
    } catch {
      setError('The connection dropped before an answer came. Try again — it will not happen twice.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reset = useCallback(() => {
    key.current = null;
    setError(null);
    setNeedsCode(false);
    setDone(false);
  }, []);

  return { busy, error, needsCode, done, run, confirm, reset };
}
