'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type ConfirmFactor, type ConfirmPurpose, confirmFactorsOf, confirmPurposeOf } from '../../../components/confirm-factors.ts';
import { newIntentKey } from '../../../components/useCommand.tsx';

export type GuardedOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly stepUp?: true; readonly details?: Record<string, unknown> };

/**
 * One sensitive change, asked for once: a single idempotency key for the intent, and — when the command answers that it
 * must be confirmed — the factors that would confirm it (ADR 0026), after which the very same intent is sent again. The
 * component draws the confirmation (`confirmWith`, `ConfirmPanel`); this keeps the key, the retry and the refusals straight.
 */
export function useGuarded(send: (key: string) => Promise<GuardedOutcome>) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWith, setConfirmWith] = useState<{ factors: ConfirmFactor[]; purpose: ConfirmPurpose } | null>(null);
  const [needsFactor, setNeedsFactor] = useState(false);
  const [done, setDone] = useState(false);

  const settle = (out: GuardedOutcome): boolean => {
    if (out.ok) {
      setConfirmWith(null);
      setDone(true);
      router.refresh();
      return true;
    }
    const factors = confirmFactorsOf(out.details);
    if (out.stepUp && factors && factors.length > 0) {
      setConfirmWith({ factors, purpose: confirmPurposeOf(out.details) });
      return false;
    }
    if (out.code === 'MFA_ENROLLMENT_REQUIRED') {
      setNeedsFactor(true);
      return false;
    }
    setError(out.message || 'That could not be done. Try again.');
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

  /** A code was accepted: the same intent again. Returns what the confirmation panel should say if it still did not go. */
  const retry = async (): Promise<string | null> => {
    try {
      const out = await send(key.current ?? newIntentKey());
      if (!out.ok && out.stepUp) return 'That confirmed something else. Try again.';
      if (!out.ok) return out.message || 'That could not be done. Try again.';
      settle(out);
      return null;
    } catch {
      return 'The connection dropped before an answer came. Try again — it will not happen twice.';
    }
  };

  const reset = useCallback(() => {
    key.current = null;
    setError(null);
    setConfirmWith(null);
    setNeedsFactor(false);
    setDone(false);
  }, []);

  return { busy, error, confirmWith, needsFactor, done, run, retry, reset };
}
