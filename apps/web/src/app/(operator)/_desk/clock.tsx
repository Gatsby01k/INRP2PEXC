'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { age, ageShort, countdown } from './format.ts';

/**
 * The desk's clock is the business clock: the page is given `inrp2p_now()` as it rendered, and only the time that
 * has passed **since** is taken from the browser. Ages and countdowns therefore agree with the server that decides
 * expiry (quotes, capacity days), a skewed laptop clock cannot make a quote look live that the server has already
 * expired, and the first render is identical on the server and in the browser.
 */
const Clock = createContext<number | null>(null);

export function ClockProvider({ serverNow, children }: { serverNow: string; children: ReactNode }) {
  const base = new Date(serverNow).getTime();
  const [now, setNow] = useState(base);
  useEffect(() => {
    const mountedAt = Date.now();
    setNow(base);
    const id = window.setInterval(() => setNow(base + (Date.now() - mountedAt)), 1000);
    return () => window.clearInterval(id);
  }, [base]);
  return <Clock.Provider value={now}>{children}</Clock.Provider>;
}

export function useDeskNow(): number {
  const now = useContext(Clock);
  return now ?? 0;
}

/** Elapsed time since `at`: "12 min", or "12m" when `short`. */
export function Age({ at, short = false }: { at: string; short?: boolean }) {
  const now = useDeskNow();
  return <time dateTime={at}>{short ? ageShort(at, now) : age(at, now)}</time>;
}

/** "12 min ago", or "just now" — never "just now ago". */
export function Ago({ at }: { at: string }) {
  const now = useDeskNow();
  const text = age(at, now);
  return <time dateTime={at}>{text === 'just now' ? text : `${text} ago`}</time>;
}

/** Time left until `to`, as mm:ss. `warnBelow` seconds turns the text to the warning tone — never a flash. */
export function Countdown({ to, warnBelow = 30, expiredLabel = 'expired' }: { to: string; warnBelow?: number; expiredLabel?: string }) {
  const now = useDeskNow();
  const { text, seconds } = countdown(to, now);
  const style = seconds === 0 ? { color: 'var(--text-muted)' } : seconds <= warnBelow ? { color: 'var(--status-warning)' } : undefined;
  return (
    <time dateTime={to} style={{ fontVariantNumeric: 'tabular-nums', ...style }}>
      {seconds === 0 ? expiredLabel : text}
    </time>
  );
}
