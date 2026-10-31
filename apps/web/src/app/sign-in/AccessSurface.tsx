'use client';

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArcLoader } from '@inrp2p/ui';
import { robotCues } from '../(public)/_landing/robot/cues.ts';
import { startClientAccessAction, startTraderAccessAction } from '../../server/actions/trader-access.ts';
import { CodeField } from './CodeField.tsx';
import { CODE_LENGTH, CODE_MINUTES, RESEND_AFTER_SECONDS, clock, looksLikeEmail, maskEmail } from './access.ts';
import styles from './gateway.module.css';

type Stage = 'EMAIL' | 'CODE';
type Busy = 'send' | 'resend' | 'verify' | 'telegram' | null;

/**
 * Log In with Telegram, when the server has it set up (ADR 0026): `preferred` when this device signed in with Telegram
 * last, so it is offered first; `error` when Telegram sent the person back here without a session.
 */
export interface TelegramOffer {
  readonly preferred: boolean;
  readonly error?: string;
}

/** The address this device last signed in with, offered again so a returning person only presses Continue. */
const REMEMBERED_EMAIL = 'inrp2p.sign-in.email';

function rememberedEmail(): string {
  try {
    return window.localStorage.getItem(REMEMBERED_EMAIL) ?? '';
  } catch {
    return '';
  }
}

function rememberEmail(email: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_EMAIL, email);
  } catch {
    // Private mode or storage blocked: the person types it next time.
  }
}

/** What Telegram's answer means to the person, in words. Anything not named here is "didn't finish". */
function telegramMessage(error: string): string {
  if (error === 'signup_disabled' || error === 'account_not_linked') {
    return 'This Telegram isn’t connected to an INRP2P account yet. Sign in with your email, then connect Telegram in Account & security.';
  }
  if (error === 'access_denied') return 'Telegram sign-in was cancelled. Try again, or use your email.';
  return 'Telegram sign-in didn’t finish. Try again, or use your email.';
}

/** Telegram's paper plane in its disc, drawn in the button's own colour. */
function TelegramGlyph({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.14" />
      <path d="M14.6 6.1 4.9 9.8c-.5.2-.5.9 0 1l2.3.8 1 3c.1.4.6.5.9.2l1.4-1.3 2.4 1.8c.4.3.9.1 1-.4l1.6-7.9c.1-.6-.4-1.1-.9-.9Zm-2.1 2.1-3.9 3.6-.2 1.6-.6-2 4.4-3.4c.2-.1.4.1.3.2Z" fill="currentColor" />
    </svg>
  );
}

/** Something the visitor has to act on. `field` when it is about what they typed, so the field shows it too. */
interface Problem {
  readonly message: string;
  readonly field: boolean;
}

const MESSAGES = {
  email: 'Enter your full email, like name@example.com.',
  unsent: 'We couldn’t send a code just now. Try again in a moment.',
  unchecked: 'We couldn’t check the code just now. Try again in a moment.',
  tooMany: 'Too many attempts. Wait a few minutes, then try again.',
  refused: 'That code wasn’t accepted. Check it, or send a new one.',
  resent: 'A new code is on its way.',
} as const;

const ORDER: Record<Stage, number> = { EMAIL: 0, CODE: 1 };

/**
 * One state of the surface. Both are always drawn in the same place, so the surface keeps its size and position
 * while its contents change; the one not in use waits above or below, invisible and inert (unreachable by pointer,
 * keyboard and screen reader alike).
 */
function Face({ face, stage, children }: { face: Stage; stage: Stage; children: ReactNode }) {
  const at = ORDER[face] < ORDER[stage] ? 'before' : ORDER[face] > ORDER[stage] ? 'after' : 'active';
  return (
    <div className={styles.face} data-place={at} inert={at !== 'active'}>
      {children}
    </div>
  );
}

function Arrow({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 8h9.5 M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** POSTs to one of Better Auth's own endpoints on this host. A network failure is `null`, never a throw. */
async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
}

/** What each door opens, said in three lines under its action. */
const CLIENT_PERKS = ['Escrow on every deal', 'One firm price for the whole amount', 'Rupees bank to bank, from your own account'] as const;
const TRADER_PERKS = ['Your own page and deal links', 'Your prices, your clients', 'INRP2P’s orders come to you too'] as const;

function Tick() {
  return (
    <svg className={styles.tick} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The workspace's access surface: client sign-in (SECURITY §2.2), and since D-17 (2026-10-10) the way a new client
 * opens their own account — the same email and the same code.
 *
 * Before the first code it asks the server to make sure the address has a sign-in identity (never more than that —
 * see `startClientAccessAction`); both code steps are Better Auth's own endpoints — `email-otp/send-verification-otp`,
 * then `sign-in/email-otp` — and nothing here decides anything about access. Someone new lands on `/open-account`,
 * where the account is opened; a client lands in the Exchange. The code step is shown after any accepted request,
 * whether or not the address is known, and a refused code says the same thing whatever was wrong with it, so the
 * surface never tells a stranger which addresses are real. Expiry, attempts and rate limits are the server's; the surface only
 * reports a refusal, and paces its own "resend" inside the server's allowance.
 *
 * Validation is the surface's own, next to the field it concerns, never the browser's bubble.
 */
/**
 * `TRADER` is the same surface for "Open your exchange": before the first code is sent it asks the server to make sure
 * the address has a sign-in identity (never more than that — see `startTraderAccessAction`), and once the code is
 * taken it opens Traders, where the application starts. The code, its limits and its refusals are the same.
 */
export function AccessSurface({ mode = 'SIGN_IN', next, telegram = null }: { mode?: 'SIGN_IN' | 'TRADER'; next?: string; telegram?: TelegramOffer | null }) {
  const trader = mode === 'TRADER';
  // A new trader starts with their email; a returning one signs in on the workspace's door, where Telegram is offered.
  const offerTelegram = !trader && telegram !== null;
  const telegramFirst = offerTelegram && telegram.preferred;
  const router = useRouter();
  const id = useId();
  const ids = {
    email: `${id}-email`,
    emailMessage: `${id}-email-message`,
    emailNote: `${id}-email-note`,
    code: `${id}-code`,
    codeMessage: `${id}-code-message`,
    sentTo: `${id}-sent-to`,
    telegramMessage: `${id}-telegram-message`,
  };
  const [stage, setStage] = useState<Stage>('EMAIL');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [emailProblem, setEmailProblem] = useState<Problem | null>(null);
  const [codeProblem, setCodeProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [telegramProblem, setTelegramProblem] = useState<string | null>(telegram?.error ? telegramMessage(telegram.error) : null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  // Guards that must hold within one event, before React has rendered the state that says so.
  const inFlight = useRef(false);
  const tried = useRef('');
  const address = email.trim();

  // The resend clock runs only on the code step, and stops once it reaches zero.
  useEffect(() => {
    if (stage !== 'CODE') return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= resendAt) window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 250);
    tick();
    return () => window.clearInterval(timer);
  }, [stage, resendAt]);
  const waitSeconds = (resendAt - now) / 1000;

  // Focus follows the step: the field the visitor needs next. On arrival, everywhere but a touch screen — a phone's
  // keyboard should open when the visitor taps, not cover the page before they have read it.
  const arrived = useRef(false);
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      // The address this device signed in with last is offered again; Telegram first for whoever used it last.
      const known = rememberedEmail();
      if (known) setEmail((typed) => typed || known);
      if (!telegramFirst && !window.matchMedia('(pointer: coarse)').matches) emailInput.current?.focus();
      return;
    }
    (stage === 'CODE' ? codeInput : emailInput).current?.focus();
  }, [stage]);

  // The robot glances at the surface while the visitor is on its action, as it does at the home page's.
  const onAction = useRef({ hover: false, focus: false });
  const markAction = (key: 'hover' | 'focus', on: boolean) => {
    onAction.current[key] = on;
    robotCues.setFocus(onAction.current.hover || onAction.current.focus ? 'cta' : 'none');
  };
  useEffect(() => () => robotCues.setFocus('none'), []);
  const actionHandlers = {
    onPointerEnter: () => markAction('hover', true),
    onPointerLeave: () => markAction('hover', false),
    onFocus: () => markAction('focus', true),
    onBlur: () => markAction('focus', false),
  };

  // The robot follows the same moments the visitor sees: it reads what they type, waits with them while a request
  // is out, is pleased when the code is taken and concerned when something is refused. It is told, never asked:
  // nothing here waits on it, and the surface works the same when it never loads.
  const sendCode = async (mode: 'send' | 'resend') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(mode);
    setNotice(null);
    if (mode === 'send') setEmailProblem(null);
    else setCodeProblem(null);
    robotCues.emit({ kind: 'wait', on: true });
    if (mode === 'send') {
      const started = await (trader ? startTraderAccessAction : startClientAccessAction)({ email: address }).catch(() => null);
      if (!started?.ok) {
        inFlight.current = false;
        setBusy(null);
        robotCues.emit({ kind: 'wait', on: false });
        setEmailProblem(
          started?.code === 'INVALID_EMAIL' ? { message: MESSAGES.email, field: true } : { message: started?.code === 'RATE_LIMITED' ? MESSAGES.tooMany : MESSAGES.unsent, field: false },
        );
        robotCues.emit({ kind: 'problem' });
        return;
      }
    }
    const res = await post('/email-otp/send-verification-otp', { email: address, type: 'sign-in' });
    inFlight.current = false;
    setBusy(null);
    robotCues.emit({ kind: 'wait', on: false });
    if (!res?.ok) {
      const problem = { message: res?.status === 429 ? MESSAGES.tooMany : MESSAGES.unsent, field: false };
      if (mode === 'send') setEmailProblem(problem);
      else setCodeProblem(problem);
      robotCues.emit({ kind: 'problem' });
      return;
    }
    // A new code replaces the last one on the server, so whatever was typed for it is cleared too.
    setResendAt(Date.now() + RESEND_AFTER_SECONDS * 1000);
    setCode('');
    tried.current = '';
    if (mode === 'send') {
      setStage('CODE');
    } else {
      setNotice(MESSAGES.resent);
      codeInput.current?.focus();
    }
  };

  const verify = async (otp: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    tried.current = otp;
    setBusy('verify');
    setCodeProblem(null);
    setNotice(null);
    robotCues.emit({ kind: 'wait', on: true });
    const res = await post('/sign-in/email-otp', { email: address, otp });
    robotCues.emit({ kind: 'wait', on: false });
    if (res?.ok) {
      rememberEmail(address);
      robotCues.emit({ kind: 'submitted' });
      // Still busy: the surface stays as it is until the workspace replaces it. The server routes by what the
      // account is: a client with the Exchange lands there, someone new on opening their account, a trader in Traders.
      router.push(next ?? (trader ? '/traders' : '/exchange'));
      router.refresh();
      return;
    }
    inFlight.current = false;
    setBusy(null);
    robotCues.emit({ kind: 'problem' });
    setCodeProblem(
      res === null ? { message: MESSAGES.unchecked, field: false } : res.status === 429 ? { message: MESSAGES.tooMany, field: false } : { message: MESSAGES.refused, field: true },
    );
    // Selected, so the next digit typed starts the code again rather than joining the refused one.
    codeInput.current?.select();
  };

  // Telegram's own sign-in: Better Auth makes the request (its state and PKCE), Telegram asks the person to confirm, and
  // the callback lands them where they were going — or back here with what went wrong. The surface stays busy meanwhile.
  const startTelegram = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('telegram');
    setTelegramProblem(null);
    robotCues.emit({ kind: 'wait', on: true });
    const back = `/sign-in${next ? `?${new URLSearchParams({ next }).toString()}` : ''}`;
    const res = await post('/sign-in/social', { provider: 'telegram', callbackURL: next ?? '/exchange', errorCallbackURL: back, disableRedirect: true });
    const json = (await res?.json().catch(() => null)) as { url?: unknown } | null;
    if (res?.ok && typeof json?.url === 'string') {
      window.location.assign(json.url);
      return;
    }
    inFlight.current = false;
    setBusy(null);
    robotCues.emit({ kind: 'wait', on: false });
    robotCues.emit({ kind: 'problem' });
    setTelegramProblem(res?.status === 429 ? MESSAGES.tooMany : 'Telegram isn’t answering just now. Try again, or use your email.');
  };

  const telegramButton = offerTelegram ? (
    <div className={styles.telegramBlock}>
      <button
        type="button"
        className={telegramFirst ? styles.action : styles.telegram}
        disabled={busy !== null}
        aria-busy={busy === 'telegram' || undefined}
        aria-describedby={telegramProblem ? ids.telegramMessage : undefined}
        onClick={() => void startTelegram()}
        {...(telegramFirst ? actionHandlers : {})}
      >
        {busy === 'telegram' ? (
          <span className={styles.actionIcon} aria-hidden="true">
            <ArcLoader size="sm" tone="inherit" label="" />
          </span>
        ) : (
          <TelegramGlyph className={styles.telegramGlyph} />
        )}
        <span>Continue with Telegram</span>
        {telegramFirst ? <span className={styles.lastUsed}>Last used</span> : null}
      </button>
      {telegramProblem ? (
        <p id={ids.telegramMessage} className={styles.message} role="alert">
          {telegramProblem}
        </p>
      ) : null}
    </div>
  ) : null;

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!looksLikeEmail(address)) {
      setEmailProblem({ message: MESSAGES.email, field: true });
      robotCues.emit({ kind: 'problem' });
      emailInput.current?.focus();
      return;
    }
    void sendCode('send');
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (busy || code.length !== CODE_LENGTH) return;
    void verify(code);
  };

  const changeCode = (next: string) => {
    setCode(next);
    setNotice(null);
    robotCues.emit({ kind: 'value' });
    if (codeProblem?.field) setCodeProblem(null);
    // A complete code is checked at once — typed, pasted or offered by the keyboard — and only once as it stands.
    if (next.length === CODE_LENGTH && next !== tried.current) void verify(next);
  };

  const changeEmail = () => {
    setStage('EMAIL');
    setCode('');
    tried.current = '';
    setCodeProblem(null);
    setNotice(null);
  };

  const busyLabel = busy === 'verify' ? 'Checking the code' : busy === 'telegram' ? 'Opening Telegram' : 'Sending a code';

  return (
    <section className={styles.surface} aria-label={trader ? 'Open your exchange' : 'Workspace sign-in'} data-robot-target="panel">
      <p className={styles.product}>{trader ? 'Step one of three' : 'INRP2P Exchange'}</p>

      <div className={styles.faces} data-robot-target="cta">
        <Face face="EMAIL" stage={stage}>
          <form className={`${styles.form} ${styles.emailForm}`} noValidate onSubmit={submitEmail}>
            <h2 className={styles.heading}>{trader ? 'Start with your email.' : 'Sign in or open an account.'}</h2>
            {telegramFirst ? (
              <>
                {telegramButton}
                <p className={styles.or}>or use your email</p>
              </>
            ) : null}
            <div className={styles.field} data-invalid={emailProblem?.field || undefined}>
              <label htmlFor={ids.email} className={styles.label}>
                Email
              </label>
              <input
                id={ids.email}
                ref={emailInput}
                className={styles.input}
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailProblem) setEmailProblem(null);
                  robotCues.emit({ kind: 'value' });
                }}
                aria-invalid={emailProblem?.field || undefined}
                aria-describedby={`${ids.emailMessage} ${ids.emailNote}`}
              />
              <p id={ids.emailMessage} className={styles.message} role="alert">
                {emailProblem?.message}
              </p>
            </div>
            <div className={styles.lower}>
              <button
                type="submit"
                className={styles.action}
                data-tone={telegramFirst ? 'quiet' : undefined}
                disabled={address === '' || busy !== null}
                aria-busy={busy === 'send' || undefined}
                {...(telegramFirst ? {} : actionHandlers)}
              >
                <span>Continue</span>
                {busy === 'send' ? (
                  <span className={styles.actionIcon} aria-hidden="true">
                    <ArcLoader size="sm" tone="inherit" label="" />
                  </span>
                ) : (
                  <Arrow className={styles.actionIcon} />
                )}
              </button>
              <p id={ids.emailNote} className={styles.note}>
                {trader
                  ? 'We send a 6-digit code. Then you tell us what you can provide; your exchange opens once INRP2P approves you.'
                  : 'We send a 6-digit code. No password to remember.'}
              </p>
              {/* The other way in, where Telegram is set up; otherwise what the code opens, in three lines. */}
              {offerTelegram && !telegramFirst ? (
                <>
                  <p className={styles.or}>or</p>
                  {telegramButton}
                </>
              ) : null}
              {offerTelegram ? null : (
                <ul className={styles.perks}>
                  {(trader ? TRADER_PERKS : CLIENT_PERKS).map((perk) => (
                    <li key={perk} className={styles.perk}>
                      <Tick />
                      {perk}
                    </li>
                  ))}
                </ul>
              )}
              {/* The other door, for whoever came in by the wrong one. */}
              <a className={styles.door} href={trader ? '/sign-in' : '/become-a-trader'}>
                <span className={styles.doorText}>
                  <span className={styles.doorQuestion}>{trader ? 'Here to buy or sell USDT?' : 'Run an exchange or have liquidity?'}</span>
                  <span className={styles.doorAction}>{trader ? 'Sign in or open an account' : 'Open your exchange'}</span>
                </span>
                <Arrow className={styles.doorIcon} />
              </a>
            </div>
          </form>
        </Face>

        <Face face="CODE" stage={stage}>
          <form className={styles.form} noValidate onSubmit={submitCode}>
            <div className={styles.headingGroup}>
              <h2 className={styles.heading}>Check your email.</h2>
              <p id={ids.sentTo} className={styles.sentTo}>
                <span className="ix-visually-hidden">We sent a code to {address}</span>
                <span aria-hidden="true">{maskEmail(address)}</span>
              </p>
            </div>
            <div className={styles.field} data-invalid={codeProblem?.field || undefined}>
              <label htmlFor={ids.code} className={styles.label}>
                Verification code
              </label>
              <CodeField
                id={ids.code}
                value={code}
                onChange={changeCode}
                invalid={Boolean(codeProblem?.field)}
                describedBy={`${ids.codeMessage} ${ids.sentTo}`}
                inputRef={codeInput}
              />
              {/* A refusal is an alert; a notice is shown here and spoken by the polite region below. */}
              <p id={ids.codeMessage} className={styles.message}>
                <span role="alert">{codeProblem?.message}</span>
                {!codeProblem && notice ? <span className={styles.notice}>{notice}</span> : null}
              </p>
            </div>
            <div className={styles.lower}>
              <button type="submit" className={styles.action} disabled={code.length !== CODE_LENGTH || busy !== null} aria-busy={busy === 'verify' || undefined} {...actionHandlers}>
                <span>Verify</span>
                {busy === 'verify' ? (
                  <span className={styles.actionIcon} aria-hidden="true">
                    <ArcLoader size="sm" tone="inherit" label="" />
                  </span>
                ) : (
                  <Arrow className={styles.actionIcon} />
                )}
              </button>
              <div className={styles.codeLinks}>
                {waitSeconds > 0 ? (
                  <span className={styles.wait}>
                    Resend in <span className="ix-num">{clock(waitSeconds)}</span>
                  </span>
                ) : (
                  <button type="button" className={styles.textButton} disabled={busy !== null} onClick={() => void sendCode('resend')}>
                    Resend code
                  </button>
                )}
                <button type="button" className={styles.textButton} disabled={busy === 'verify'} onClick={changeEmail}>
                  Use another email
                </button>
              </div>
              <p className={styles.note}>The code expires {CODE_MINUTES} minutes after it is sent.</p>
            </div>
          </form>
        </Face>
      </div>

      {/* What is happening while a button is busy, and what just happened, for anyone who cannot see it. */}
      <p className="ix-visually-hidden" aria-live="polite">
        {busy ? `${busyLabel}…` : (notice ?? '')}
      </p>
    </section>
  );
}
