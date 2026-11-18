import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusGlyph } from '@inrp2p/ui';
import { MarkArt } from '../../../components/MarkArt.tsx';
import b from './book.module.css';

/**
 * The book's stateless parts: a party's tile, the hero (one orange field and the figures beside it), figure cells,
 * step rails, sheets of eyebrowed groups and rows with a mark. Server-renderable; client components use them too.
 */

/** "Acme Pay" → AP, "Thangella Sivaprasad" → TS, "Konkan Liquidity LLP" → KL. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^(private|pvt|limited|ltd|llp|inc|the|and|of)$/i.test(w));
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0]?.slice(0, 2) ?? '··');
  return letters.toUpperCase();
}

export function Monogram({ name, size = 40, tone }: { name: string; size?: number; tone?: 'field' | 'ink' | 'quiet' }) {
  return (
    <span className={b.mono} style={{ ['--size' as string]: `${size}px` }} {...(tone ? { 'data-tone': tone } : {})} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** A party in a table: its tile, its name (a link) and one line of what it is. */
export function Who({ name, sub, href, tone, size = 36 }: { name: string; sub?: ReactNode; href?: string; tone?: 'ink' | 'quiet'; size?: number }) {
  return (
    <span className={b.who}>
      <Monogram name={name} size={size} {...(tone ? { tone } : {})} />
      <span className={b.whoText}>
        {href ? (
          <Link href={href} className={b.whoName}>
            {name}
          </Link>
        ) : (
          <span className={b.whoName}>{name}</span>
        )}
        {sub ? <span className={b.whoSub}>{sub}</span> : null}
      </span>
    </span>
  );
}

/* ── Hero ───────────────────────────────────────────────────────────────────────────────────────── */

export function Hero({
  eyebrow,
  corner,
  figure,
  sub,
  foot,
  side,
  stages,
  stopped = false,
  label,
}: {
  eyebrow: ReactNode;
  corner?: ReactNode;
  figure: ReactNode;
  sub?: ReactNode;
  foot?: ReactNode;
  side: ReactNode;
  stages: 0 | 1 | 2 | 3;
  stopped?: boolean;
  label: string;
}) {
  return (
    <section className={b.hero} aria-label={label}>
      <div className={b.field} {...(stopped ? { 'data-state': 'stopped' } : {})}>
        <MarkArt className={b.fieldArt} stages={stages} hub={false} />
        <div className={b.fieldTop}>
          <span className={b.eyebrow}>{eyebrow}</span>
          {corner}
        </div>
        <div className={b.figure}>
          <p className={b.figureValue}>{figure}</p>
          {sub ? <p className={b.figureSub}>{sub}</p> : null}
        </div>
        {foot}
      </div>
      <div className={b.side}>{side}</div>
    </section>
  );
}

/** White meter on the orange field: `parts` stack from the left, as shares of 100. */
export function FieldMeter({ parts, label }: { parts: readonly { value: number; kind?: 'locked' }[]; label: string }) {
  let left = 0;
  return (
    <div className={b.fieldMeter} role="img" aria-label={label}>
      {parts.map((p, i) => {
        const width = Math.max(0, Math.min(100 - left, p.value));
        const el = <span key={i} {...(p.kind ? { 'data-part': p.kind } : {})} style={{ left: `${left}%`, width: `${width}%` }} />;
        left += width;
        return el;
      })}
    </div>
  );
}

/* ── Figure cells ───────────────────────────────────────────────────────────────────────────────── */

export interface StatItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  readonly tone?: 'danger' | 'warning' | 'success' | 'muted';
  readonly meter?: { readonly value: number; readonly tone?: 'brand' | 'success' | 'warning'; readonly label: string };
}

export function Stats({ items, label }: { items: readonly StatItem[]; label: string }) {
  return (
    <dl className={b.stats} aria-label={label}>
      {items.map((s) => (
        <div key={s.key} className={b.stat} {...(s.tone ? { 'data-tone': s.tone } : {})}>
          <dt className={b.statLabel}>{s.label}</dt>
          <dd className={b.statValue}>{s.value}</dd>
          {s.sub ? <dd className={b.statSub}>{s.sub}</dd> : null}
          {s.meter ? (
            <dd style={{ margin: 0 }}>
              <MiniMeter value={s.meter.value} label={s.meter.label} {...(s.meter.tone ? { tone: s.meter.tone } : {})} />
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

export function MiniMeter({ value, tone, label }: { value: number; tone?: 'brand' | 'success' | 'warning'; label: string }) {
  return (
    <span className={b.miniMeter} role="img" aria-label={label} {...(tone ? { 'data-tone': tone } : {})} style={{ display: 'block' }}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

/* ── Steps ──────────────────────────────────────────────────────────────────────────────────────── */

export type StepState = 'done' | 'now' | 'pending' | 'blocked';

const GLYPH = { done: 'done', now: 'partial', pending: 'pending', blocked: 'closed' } as const;

export function Steps({ items, label }: { items: readonly { key: string; name: ReactNode; sub?: ReactNode; state: StepState }[]; label: string }) {
  return (
    <ol className={b.steps} aria-label={label}>
      {items.map((s) => (
        <li key={s.key} className={b.step} data-state={s.state}>
          <span className={b.stepName}>
            <StatusGlyph state={GLYPH[s.state]} />
            {s.name}
          </span>
          {s.sub ? <span className={b.stepSub}>{s.sub}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/* ── Sheets, groups, rows, facts ────────────────────────────────────────────────────────────────── */

export function Sheet({ title, count, hint, actions, children, id, label, flush = false }: { title?: ReactNode; count?: number; hint?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string; label?: string; flush?: boolean }) {
  return (
    <section className={b.sheet} {...(id ? { id } : {})} {...(label ? { 'aria-label': label } : {})}>
      {title ? (
        <div className={b.sheetHead}>
          <div style={{ minWidth: 0 }}>
            <h2 className={b.sheetTitle}>
              {title}
              {count !== undefined ? <span>{count}</span> : null}
            </h2>
            {hint ? <p className={b.sheetHint}>{hint}</p> : null}
          </div>
          {actions ? <div className={b.rowEnd}>{actions}</div> : null}
        </div>
      ) : null}
      {flush ? children : <div className={b.sheetBody}>{children}</div>}
    </section>
  );
}

export function Group({ title, count, hint, children, id, label }: { title: ReactNode; count?: number; hint?: ReactNode; children: ReactNode; id?: string; label?: string }) {
  return (
    <div className={b.group} {...(id ? { id } : {})} role="group" aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
      <div className={b.groupHead}>
        <h3 className={b.groupTitle}>
          {title}
          {count !== undefined ? <span>{count}</span> : null}
        </h3>
        {hint ? <span className={b.groupHint}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function Facts({ items, align, label }: { items: readonly { key?: string; label: ReactNode; value: ReactNode }[]; align?: 'left'; label?: string }) {
  return (
    <dl className={b.facts} {...(align ? { 'data-align': align } : {})} {...(label ? { 'aria-label': label } : {})}>
      {items.map((i, n) => (
        <div key={i.key ?? n} style={{ display: 'contents' }}>
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A TRON address as people check one: the first six and the last six, the whole in a tooltip and to copy. */
export const shortAddress = (address: string): string => (address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address);

/** The IFSC inside a bank's one-line detail ("HDFC Bank HDFC0001234 ••••8219"). */
export const ifscOf = (detail: string): string => /\b[A-Z]{4}0[A-Z0-9]{6}\b/.exec(detail)?.[0] ?? '';

/** "HDFC Bank HDFC0001234 ••••8219" → its bank, IFSC and last four, to draw the account as a bank's app does. */
export function bankParts(detail: string): { bank: string; ifsc: string; last4: string } {
  const ifsc = ifscOf(detail);
  const last4 = /••••\s?(\w+)/.exec(detail)?.[1] ?? '';
  const bank = (ifsc ? detail.slice(0, detail.indexOf(ifsc)) : detail.replace(/••••.*$/, '')).trim();
  return { bank: bank || 'Bank account', ifsc, last4 };
}

/**
 * A browser and its system in the words people use ("Chrome · Android", "Safari · iPhone"), from a user agent. A guess
 * from a string the browser sends: good enough to tell two devices apart, never evidence of anything.
 */
export function deviceOf(userAgent: string | null): string {
  if (!userAgent) return 'device not recorded';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Telegram/i.test(ua)
          ? 'Telegram'
          : /Firefox\/|FxiOS/.test(ua)
            ? 'Firefox'
            : /Chrome\/|CriOS/.test(ua)
              ? 'Chrome'
              : /Safari\//.test(ua)
                ? 'Safari'
                : /curl|node|python|okhttp|axios|Go-http/i.test(ua)
                  ? 'a script'
                  : 'a browser';
  const system = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return system ? `${browser} · ${system}` : browser;
}

export { b as bookStyles };
