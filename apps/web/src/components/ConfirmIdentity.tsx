'use client';

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArcLoader, OtpInput } from '@inrp2p/ui';
import type { ConfirmFactor, ConfirmPurpose } from './confirm-factors.ts';
import styles from './confirm.module.css';

/**
 * Confirming a sensitive change on the client surface (ADR 0026): a code from the person's Telegram, their email or
 * their authenticator — whichever of them the server said would confirm *this* session (`details.factors`: never the one
 * the session was opened with). The code goes straight to Better Auth (`/step-up/*`, `/two-factor/verify-totp`); this
 * component decides nothing and never sees a secret but the code it is typing. Once a code is accepted the same intent is
 * sent again by the caller (`onVerified`), with the same key.
 *
 * Quick on a phone: the factor the person used last is chosen first, its code is sent the moment the panel opens, and a
 * full code is checked as soon as it is typed or pasted.
 */
const NAME: Record<ConfirmFactor, string> = { TELEGRAM: 'Telegram', EMAIL: 'Email', TOTP: 'Authenticator' };
const PREFERRED = 'inrp2p.confirm.factor';
const RESEND_AFTER_MS = 30_000;

function preferred(factors: readonly ConfirmFactor[]): ConfirmFactor {
  try {
    const p = window.localStorage.getItem(PREFERRED);
    if (p && (factors as readonly string[]).includes(p)) return p as ConfirmFactor;
  } catch {
    // Storage blocked: the server's order.
  }
  return factors[0]!;
}

function remember(factor: ConfirmFactor): void {
  try {
    window.localStorage.setItem(PREFERRED, factor);
  } catch {
    // Storage blocked: chosen again next time.
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null } | null> {
  try {
    const res = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return null;
  }
}

function sendProblem(res: Awaited<ReturnType<typeof post>>, factor: ConfirmFactor): string {
  if (res?.status === 429) return 'Too many codes in a short time. Wait a few minutes, or choose another way.';
  if (factor === 'TELEGRAM') {
    return res?.json?.code === 'TELEGRAM_BLOCKED'
      ? 'Telegram didn’t deliver it: the INRP2P bot may be blocked. Open it in Telegram and press Start, or choose another way.'
      : 'Telegram didn’t take the code just now. Try again, or choose another way.';
  }
  return 'We couldn’t send the code just now. Try again in a moment.';
}

export interface ConfirmPanelProps {
  readonly factors: readonly ConfirmFactor[];
  /** What is being confirmed, said in the code's message (a fixed sentence on the server). */
  readonly purpose?: ConfirmPurpose;
  /** What happens once confirmed, as the page names it: "Withdraw 500 USDT". */
  readonly summary: string;
  /** Called once a code is accepted: sends the intent again. Returns what to tell the person if it still failed. */
  readonly onVerified: () => Promise<string | null>;
  readonly onCancel?: () => void;
  /** Inside a sheet that has its own title: the panel leaves out its heading. */
  readonly embedded?: boolean;
}

export function ConfirmPanel({ factors, purpose = 'CHANGE', summary, onVerified, onCancel, embedded = false }: ConfirmPanelProps) {
  const id = useId();
  const [factor, setFactor] = useState<ConfirmFactor>(() => factors[0]!);
  const [code, setCode] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the error is about the code typed (the field shows it) or about sending one (it does not). */
  const [codeWrong, setCodeWrong] = useState(false);
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const tried = useRef('');
  const input = useRef<HTMLInputElement>(null);
  const sentFor = useRef<ConfirmFactor | null>(null);

  const send = useCallback(
    async (f: ConfirmFactor) => {
      if (f === 'TOTP') return;
      setBusy('send');
      setError(null);
      setTo(null);
      const res = await post('/step-up/send', { channel: f, purpose });
      setBusy(null);
      if (!res?.ok) {
        setCodeWrong(false);
        setError(sendProblem(res, f));
        return;
      }
      setTo(typeof res.json?.to === 'string' ? res.json.to : null);
      setResendAt(Date.now() + RESEND_AFTER_MS);
      input.current?.focus();
    },
    [purpose],
  );

  // The remembered factor, chosen once the panel is on screen; its code goes at once. Only once: a re-render with the
  // same factors must not undo the person's own choice, nor send another code.
  useEffect(() => {
    if (sentFor.current !== null) return;
    const first = preferred(factors);
    sentFor.current = first;
    setFactor(first);
    if (first === 'TOTP') input.current?.focus();
    else void send(first);
  }, [factors, send]);

  useEffect(() => {
    if (resendAt === 0) return;
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= resendAt) window.clearInterval(t);
    }, 500);
    setNow(Date.now());
    return () => window.clearInterval(t);
  }, [resendAt]);

  const choose = (f: ConfirmFactor) => {
    if (f === factor || busy) return;
    setFactor(f);
    setCode('');
    tried.current = '';
    setError(null);
    setTo(null);
    setResendAt(0);
    sentFor.current = f;
    void send(f);
    if (f === 'TOTP') window.setTimeout(() => input.current?.focus(), 0);
  };

  const verify = async (value: string) => {
    if (busy || value.length !== 6) return;
    tried.current = value;
    setBusy('verify');
    setError(null);
    const res = factor === 'TOTP' ? await post('/two-factor/verify-totp', { code: value }) : await post('/step-up/verify', { code: value });
    if (!res?.ok) {
      setBusy(null);
      setCodeWrong(res !== null && res.status !== 429);
      setError(
        res === null
          ? 'The connection dropped. Try again — nothing was changed.'
          : res.status === 429
            ? 'Too many tries. Wait a few minutes, then send a new code.'
            : factor === 'TOTP'
              ? 'That code wasn’t accepted. Enter the one your app shows now.'
              : 'That code wasn’t accepted. Check the latest one, or send a new code.',
      );
      input.current?.select();
      return;
    }
    remember(factor);
    const problem = await onVerified();
    setBusy(null);
    if (problem) {
      setCodeWrong(false);
      setError(problem);
    }
  };

  const change = (next: string) => {
    setCode(next);
    if (error) setError(null);
    if (next.length === 6 && next !== tried.current) void verify(next);
  };

  const wait = Math.ceil((resendAt - now) / 1000);
  const where =
    factor === 'TOTP'
      ? 'Enter the six-digit code your authenticator app shows now.'
      : busy === 'send'
        ? `Sending a code to your ${factor === 'TELEGRAM' ? 'Telegram' : 'email'}…`
        : to
          ? `We sent a code to ${to}${factor === 'TELEGRAM' ? ' in Telegram' : ''}.`
          : `We send a six-digit code to your ${factor === 'TELEGRAM' ? 'Telegram' : 'email'}.`;

  return (
    <div className={styles.panel}>
      {embedded ? null : (
        <div className={styles.head}>
          <span className={styles.badge} aria-hidden="true">
            <ShieldGlyph />
          </span>
          <div>
            <h2 className={styles.title} id={`${id}-title`}>
              Confirm it’s you
            </h2>
            <p className={styles.summary}>{summary}</p>
          </div>
        </div>
      )}

      {factors.length > 1 ? (
        <div className={styles.choice} role="radiogroup" aria-label="Confirm with">
          {factors.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={f === factor} className={styles.option} data-on={f === factor || undefined} disabled={busy !== null} onClick={() => choose(f)}>
              {NAME[f]}
            </button>
          ))}
        </div>
      ) : null}

      <p className={styles.where} id={`${id}-where`} aria-live="polite">
        {where}
      </p>

      <OtpInput
        label={factor === 'TOTP' ? 'Authenticator code' : factor === 'TELEGRAM' ? 'Code from Telegram' : 'Code from your email'}
        value={code}
        onChange={change}
        invalid={Boolean(error) && codeWrong}
        inputRef={input}
        describedBy={`${id}-where${error ? ` ${id}-error` : ''}`}
      />

      {error ? (
        <p className={styles.error} id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.actions}>
        {onCancel ? (
          <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy === 'verify'}>
            Cancel
          </button>
        ) : null}
        <button type="button" className={styles.primary} disabled={busy !== null || code.length !== 6} aria-busy={busy === 'verify' || undefined} onClick={() => void verify(code)}>
          {busy === 'verify' ? <ArcLoader size="sm" tone="inherit" label="" /> : null}
          Confirm
        </button>
      </div>

      {factor === 'TOTP' ? null : (
        <p className={styles.resend}>
          {wait > 0 ? (
            <span>
              New code in <span className="ix-num">{wait}s</span>
            </span>
          ) : (
            <button type="button" className={styles.link} disabled={busy !== null} onClick={() => void send(factor)}>
              Send a new code
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** Nothing yet confirms a second time: the person signed in with their email and has no other factor. */
export function SecondFactorNeeded({ onCancel, summary }: { onCancel?: () => void; summary: string }) {
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.badge} aria-hidden="true">
          <ShieldGlyph />
        </span>
        <div>
          <h2 className={styles.title}>Add a second way to confirm</h2>
          <p className={styles.summary}>{summary}</p>
        </div>
      </div>
      <p className={styles.where}>
        A change like this is confirmed somewhere other than where you signed in. Add a second way — your email, Telegram or an authenticator app — in Account & security, then try again.
      </p>
      <div className={styles.actions}>
        {onCancel ? (
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Not now
          </button>
        ) : null}
        <a className={styles.primary} href="/account#sign-in">
          Open Account & security
        </a>
      </div>
    </div>
  );
}

function ShieldGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M10 2.5 4 4.8v4.6c0 3.7 2.6 6.7 6 8.1 3.4-1.4 6-4.4 6-8.1V4.8L10 2.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m7.2 10 2 2 3.8-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The panel as its own modal: centred on a desktop, rising from the bottom on a phone. Escape cancels. */
export function ConfirmDialog({ open, children, onCancel }: { open: boolean; children: ReactNode; onCancel: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
    };
  }, [open, onCancel]);
  if (!open || !host) return null;
  return createPortal(
    <div className={styles.scrim} onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="dialog" aria-modal="true" aria-label="Confirm it’s you" className={styles.dialog}>
        {children}
      </div>
    </div>,
    host,
  );
}
