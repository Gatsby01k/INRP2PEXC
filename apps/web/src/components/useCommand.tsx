'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StepUpDialog } from '@inrp2p/ui';

export interface ActionFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly stepUp?: true;
  readonly details?: Record<string, unknown>;
}
export type ActionResult<R> = { readonly ok: true; readonly result: R } | ActionFailure;

/** One intent = one idempotency key. Retrying the same intent reuses it; a new press makes a new one. */
export function newIntentKey(): string {
  return crypto.randomUUID();
}

interface Pending<R> {
  readonly run: (key: string) => Promise<ActionResult<R>>;
  readonly key: string;
  readonly summary: string;
  readonly resolve: (r: ActionResult<R>) => void;
}

export interface CommandState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly clearError: () => void;
}

/**
 * Runs a server action for the desk and takes care of the two things every money action needs: one idempotency
 * key per intent (so a double click cannot pay twice), and the step-up prompt when the command answers
 * `STEP_UP_REQUIRED`. The code goes straight to Better Auth's TOTP endpoint; this component never sees a secret
 * and never decides anything — after a successful verification it simply retries the same command with the same
 * key, and the command authorizes itself again.
 */
export function useCommand(): CommandState & {
  run: <R>(summary: string, run: (key: string) => Promise<ActionResult<R>>) => Promise<ActionResult<R>>;
  dialog: React.ReactNode;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [stepUpError, setStepUpError] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState('');
  const [open, setOpen] = useState(false);
  const pending = useRef<Pending<unknown> | null>(null);

  const run = useCallback(
    async <R,>(actionSummary: string, action: (key: string) => Promise<ActionResult<R>>): Promise<ActionResult<R>> => {
      setError(null);
      setBusy(true);
      const key = newIntentKey();
      let out: ActionResult<R>;
      try {
        out = await action(key);
      } finally {
        // Only the call itself is "busy". Waiting for the operator to read an authenticator is not, or the
        // dialog's own confirm button would sit disabled behind the command that raised it.
        setBusy(false);
      }
      if (out.ok) {
        router.refresh();
        return out;
      }
      if (out.stepUp) {
        // Hold the intent — same key — until the operator has verified, then run it again unchanged.
        return await new Promise<ActionResult<R>>((resolve) => {
          pending.current = { run: action as Pending<unknown>['run'], key, summary: actionSummary, resolve: resolve as Pending<unknown>['resolve'] };
          setSummary(actionSummary);
          setCode('');
          setStepUpError(undefined);
          setOpen(true);
        });
      }
      setError(out.message);
      return out;
    },
    [router],
  );

  const cancel = useCallback(() => {
    setOpen(false);
    const p = pending.current;
    pending.current = null;
    p?.resolve({ ok: false, code: 'STEP_UP_CANCELLED', message: 'Verification cancelled; nothing was changed.' });
  }, []);

  const confirm = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    setBusy(true);
    setStepUpError(undefined);
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setStepUpError('That code was not accepted. Try the current one.');
        return;
      }
      const out = await p.run(p.key);
      if (!out.ok && out.stepUp) {
        setStepUpError('Verification did not take effect. Try again.');
        return;
      }
      pending.current = null;
      setOpen(false);
      if (out.ok) router.refresh();
      else setError(out.message);
      p.resolve(out);
    } finally {
      setBusy(false);
    }
  }, [code, router]);

  return {
    busy,
    error,
    clearError: () => setError(null),
    run,
    dialog: (
      <StepUpDialog
        open={open}
        actionSummary={summary}
        code={code}
        onCodeChange={setCode}
        onConfirm={confirm}
        onCancel={cancel}
        busy={busy}
        {...(stepUpError ? { error: stepUpError } : {})}
      />
    ),
  };
}
