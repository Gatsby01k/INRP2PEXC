'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StepUpDialog } from '@inrp2p/ui';
import { ConfirmDialog, ConfirmPanel, SecondFactorNeeded } from './Confirm.tsx';
import { type ConfirmFactor, type ConfirmPurpose, confirmFactorsOf, confirmPurposeOf } from './confirm-factors.ts';

/**
 * Tells the desk shell a command went through, so it can say so. A plain DOM event: the hook stays usable on any
 * page, and a page without a listener simply says nothing.
 */
function announce(summary: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('desk:command', { detail: { ok: true, summary } }));
}

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
 *
 * On the client surface the refusal names the factors that would confirm this session (ADR 0026): the person then
 * chooses Telegram, email or their authenticator in the same place, and the same intent goes again once confirmed.
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
  /** A client's step-up: the factors that would confirm it, and what it is for. Null for the desk's TOTP prompt. */
  const [confirmWith, setConfirmWith] = useState<{ factors: ConfirmFactor[]; purpose: ConfirmPurpose } | null>(null);
  /** A client with nothing yet to confirm with: the way to add a second factor, shown in place. */
  const [needsFactor, setNeedsFactor] = useState(false);
  const pending = useRef<Pending<unknown> | null>(null);

  const run = useCallback(
    async <R,>(actionSummary: string, action: (key: string) => Promise<ActionResult<R>>): Promise<ActionResult<R>> => {
      setError(null);
      setBusy(true);
      const key = newIntentKey();
      let out: ActionResult<R>;
      try {
        out = await action(key);
      } catch {
        // The call itself failed: the connection dropped, or this page predates a new release and its action no longer
        // exists on the server. Say so — a click that ends in silence reads as a button that does nothing.
        out = { ok: false, code: 'UNREACHABLE', message: 'This did not reach the server — the page may be out of date. Reload the page and try again; nothing was applied.' };
      } finally {
        // Only the call itself is "busy". Waiting for the operator to read an authenticator is not, or the
        // dialog's own confirm button would sit disabled behind the command that raised it.
        setBusy(false);
      }
      if (out.ok) {
        router.refresh();
        announce(actionSummary);
        return out;
      }
      const factors = confirmFactorsOf(out.details);
      if (out.code === 'MFA_ENROLLMENT_REQUIRED' && factors !== null) {
        setSummary(actionSummary);
        setNeedsFactor(true);
        return out;
      }
      if (out.stepUp) {
        // Hold the intent — same key — until the person has verified, then run it again unchanged.
        return await new Promise<ActionResult<R>>((resolve) => {
          pending.current = { run: action as Pending<unknown>['run'], key, summary: actionSummary, resolve: resolve as Pending<unknown>['resolve'] };
          setSummary(actionSummary);
          setCode('');
          setStepUpError(undefined);
          setConfirmWith(factors && factors.length > 0 ? { factors, purpose: confirmPurposeOf(out.details) } : null);
          setOpen(true);
        });
      }
      setError(out.message);
      return out;
    },
    [router],
  );

  /** The client's panel accepted a code: the same intent again. What to tell the person when it still did not go. */
  const retry = useCallback(async (): Promise<string | null> => {
    const p = pending.current;
    if (!p) return null;
    let out: Awaited<ReturnType<typeof p.run>>;
    try {
      out = await p.run(p.key);
    } catch {
      return 'This did not reach the server — the page may be out of date. Reload the page and try again; nothing was applied.';
    }
    if (!out.ok && out.stepUp) return 'That confirmed something else. Try again.';
    pending.current = null;
    setOpen(false);
    setConfirmWith(null);
    if (out.ok) {
      router.refresh();
      announce(p.summary);
    } else setError(out.message);
    p.resolve(out);
    return null;
  }, [router]);

  const cancel = useCallback(() => {
    setOpen(false);
    setConfirmWith(null);
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
      }).catch(() => null);
      if (!res?.ok) {
        setStepUpError('That code was not accepted. Try the current one.');
        return;
      }
      let out: Awaited<ReturnType<typeof p.run>>;
      try {
        out = await p.run(p.key);
      } catch {
        // Verified, but the command itself never came back: the same intent key makes trying again safe.
        setStepUpError('This did not reach the server — the page may be out of date. Reload the page and try again; nothing was applied.');
        return;
      }
      if (!out.ok && out.stepUp) {
        setStepUpError('Verification did not take effect. Try again.');
        return;
      }
      pending.current = null;
      setOpen(false);
      if (out.ok) {
        router.refresh();
        announce(p.summary);
      } else setError(out.message);
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
      <>
        {confirmWith ? (
          // Mounted only while asked for: the sheet's code and styles load then, not with the page.
          open ? (
            <ConfirmDialog open onCancel={cancel}>
              <ConfirmPanel factors={confirmWith.factors} purpose={confirmWith.purpose} summary={summary} onVerified={retry} onCancel={cancel} />
            </ConfirmDialog>
          ) : null
        ) : (
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
        )}
        {needsFactor ? (
          <ConfirmDialog open onCancel={() => setNeedsFactor(false)}>
            <SecondFactorNeeded summary={summary} onCancel={() => setNeedsFactor(false)} />
          </ConfirmDialog>
        ) : null}
      </>
    ),
  };
}

