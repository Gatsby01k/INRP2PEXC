import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusGlyph, type GlyphState } from '@inrp2p/ui';
import { Icon, type IconName } from './icons.tsx';
import s from './desk.module.css';

/**
 * The desk's stateless building blocks. They render on the server and in client components alike, carry no data
 * logic, and exist so every page is assembled from the same few parts — one page frame, one section, one KPI
 * band, one chip — instead of a hundred local variations of them.
 */

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand' | 'muted' | 'ink';

/* ── Page frame ─────────────────────────────────────────────────────────────────────────────────── */

export interface Crumb {
  readonly href: string;
  readonly label: string;
}

export function PageHeader({
  title,
  meta,
  actions,
  tabs,
  crumbs,
  badge,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  crumbs?: readonly Crumb[];
  badge?: ReactNode;
}) {
  return (
    <header className={s.header}>
      <div className={s.headerMain}>
        <div className={s.titleBlock}>
          {crumbs?.length ? (
            <nav className={s.eyebrow} aria-label="Breadcrumb">
              {crumbs.map((c) => (
                <span key={c.href} className={s.row}>
                  <Link href={c.href}>{c.label}</Link>
                  <Icon name="chevronRight" size={12} />
                </span>
              ))}
            </nav>
          ) : null}
          <div className={s.titleRow}>
            <h1 className={s.title}>{title}</h1>
            {badge}
            {meta ? <span className={s.meta}>{meta}</span> : null}
          </div>
        </div>
        {actions ? <div className={s.headerActions}>{actions}</div> : null}
      </div>
      {tabs}
    </header>
  );
}

export function Page({ children, fixed = false }: { children: ReactNode; fixed?: boolean }) {
  return <div className={cx(s.page, fixed && s.pageFixed)}>{children}</div>;
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className={s.body}>{children}</div>;
}

export function Columns({ children, even = false }: { children: ReactNode; even?: boolean }) {
  return <div className={even ? s.columnsEven : s.columns}>{children}</div>;
}

export function Stack({ children, tight = false }: { children: ReactNode; tight?: boolean }) {
  return <div className={tight ? s.stackTight : s.stack}>{children}</div>;
}

/* ── Tabs (links) ───────────────────────────────────────────────────────────────────────────────── */

export interface TabItem {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
  readonly tone?: 'danger' | 'brand';
  readonly current: boolean;
}

export function LinkTabs({ items, label }: { items: readonly TabItem[]; label: string }) {
  return (
    <nav className={s.tabs} aria-label={label}>
      {items.map((t) => (
        <Link key={t.href} href={t.href} className={s.tab} scroll={false} {...(t.current ? { 'aria-current': 'page' as const } : {})}>
          {t.label}
          {t.count !== undefined ? (
            <span className={s.tabCount} {...(t.tone && t.count > 0 ? { 'data-tone': t.tone } : {})}>
              {t.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export function Segmented({ items, label }: { items: readonly { href: string; label: string; current: boolean }[]; label: string }) {
  return (
    <nav className={s.segmented} aria-label={label}>
      {items.map((t) => (
        <Link key={t.href} href={t.href} className={s.segment} scroll={false} {...(t.current ? { 'aria-current': 'page' as const } : {})}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/* ── Sections ───────────────────────────────────────────────────────────────────────────────────── */

export function Section({
  title,
  count,
  hint,
  actions,
  children,
  flush = false,
  footer,
  tone,
  id,
  testId,
  label,
}: {
  title?: ReactNode;
  count?: number | string;
  hint?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  footer?: ReactNode;
  tone?: 'danger' | 'brand';
  id?: string;
  testId?: string;
  label?: string;
}) {
  return (
    <section className={s.section} {...(tone ? { 'data-tone': tone } : {})} {...(id ? { id } : {})} {...(testId ? { 'data-testid': testId } : {})} {...(label ? { 'aria-label': label } : {})}>
      {title ? (
        <div className={s.sectionHead}>
          <div className={s.stackTight} style={{ gap: 2 }}>
            <h2 className={s.sectionTitle}>
              {title}
              {count !== undefined ? <span className={s.sectionCount}>{count}</span> : null}
            </h2>
            {hint ? <p className={s.sectionHint}>{hint}</p> : null}
          </div>
          {actions ? <div className={s.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {children !== undefined ? <div className={cx(s.sectionBody, flush && s.flush)}>{children}</div> : null}
      {footer ? <div className={s.sectionFoot}>{footer}</div> : null}
    </section>
  );
}

/* ── KPI band ───────────────────────────────────────────────────────────────────────────────────── */

export interface KpiItem {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  readonly tone?: 'warning' | 'danger' | 'success' | 'muted';
  readonly href?: string;
  readonly size?: 'lg';
  readonly key?: string;
}

export function KpiBand({ items, label }: { items: readonly KpiItem[]; label: string }) {
  return (
    <dl className={s.kpis} aria-label={label}>
      {items.map((k, i) => {
        const inner = (
          <>
            <dt className={s.kpiLabel}>{k.label}</dt>
            <dd className={s.kpiValue} style={{ margin: 0 }}>
              {k.value}
            </dd>
            {k.sub ? <dd className={s.kpiSub} style={{ margin: 0 }}>{k.sub}</dd> : null}
          </>
        );
        const attrs = { ...(k.tone ? { 'data-tone': k.tone } : {}), ...(k.size ? { 'data-size': k.size } : {}) };
        return k.href ? (
          <Link key={k.key ?? i} href={k.href} className={s.kpi} {...attrs}>
            {inner}
          </Link>
        ) : (
          <div key={k.key ?? i} className={s.kpi} {...attrs}>
            {inner}
          </div>
        );
      })}
    </dl>
  );
}

/* ── Chips and tags ─────────────────────────────────────────────────────────────────────────────── */

export function Chip({ tone = 'neutral', glyph, icon, children, title }: { tone?: Tone; glyph?: GlyphState; icon?: IconName; children: ReactNode; title?: string }) {
  return (
    <span className={s.chip} {...(tone !== 'neutral' ? { 'data-tone': tone } : {})} {...(title ? { title } : {})}>
      {glyph ? <StatusGlyph state={glyph} /> : null}
      {icon ? <Icon name={icon} size={10} /> : null}
      {children}
    </span>
  );
}

/** SELL / BUY, always from the client's side of the trade (PRODUCT §3). Words, not colour, carry the meaning. */
export function Side({ direction }: { direction: string }) {
  return (
    <span className={s.dir} data-side={direction} title={direction === 'SELL_USDT' ? 'Client sells USDT, receives INR' : 'Client buys USDT, pays INR'}>
      {direction === 'SELL_USDT' ? 'SELL' : 'BUY'}
    </span>
  );
}

export function Kbd({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <kbd className={s.kbd} {...(label ? { 'aria-label': label } : {})}>
      {children}
    </kbd>
  );
}

export function Ref({ children }: { children: ReactNode }) {
  return <span className={s.ref}>{children}</span>;
}

/** A trade lifecycle as a chip, with the hold overlay (D-04): an exception is the primary status when on hold. */
export function LifecycleChip({ state, hold }: { state: string; hold?: boolean }) {
  if (hold) return <Chip tone="danger" glyph="partial">On hold</Chip>;
  switch (state) {
    case 'COMPLETED':
      return <Chip tone="success" glyph="done">Completed</Chip>;
    case 'CANCELLED':
      return <Chip tone="muted" glyph="closed">Cancelled</Chip>;
    case 'AWAITING_FIRST_LEG':
      return <Chip glyph="pending">Awaiting funds</Chip>;
    case 'FIRST_LEG_DETECTED':
      return <Chip glyph="partial">Funds detected</Chip>;
    case 'FIRST_LEG_CONFIRMED':
      return <Chip tone="brand" glyph="partial">Funds confirmed</Chip>;
    case 'SETTLING':
      return <Chip glyph="partial">Settling</Chip>;
    case 'PARTIALLY_SETTLED':
      return <Chip glyph="partial">Partially settled</Chip>;
    default:
      return <Chip>{state.toLowerCase().replace(/_/g, ' ')}</Chip>;
  }
}

const LEG_STATUS: Record<string, { label: string; tone: Tone; glyph: GlyphState }> = {
  PENDING: { label: 'Pending', tone: 'neutral', glyph: 'pending' },
  PROCESSING: { label: 'In flight', tone: 'brand', glyph: 'partial' },
  COMPLETED: { label: 'Confirmed', tone: 'success', glyph: 'done' },
  FAILED: { label: 'Failed', tone: 'danger', glyph: 'closed' },
  CANCELLED: { label: 'Cancelled', tone: 'muted', glyph: 'closed' },
};

export function LegStatusChip({ status }: { status: string }) {
  const s0 = LEG_STATUS[status] ?? { label: status.toLowerCase(), tone: 'neutral' as const, glyph: 'pending' as const };
  return (
    <Chip tone={s0.tone} glyph={s0.glyph}>
      {s0.label}
    </Chip>
  );
}

/* ── Key / value, notices, empties ─────────────────────────────────────────────────────────────── */

export function KeyValues({ items, split = false, label }: { items: readonly { label: ReactNode; value: ReactNode; strong?: boolean; key?: string }[]; split?: boolean; label?: string }) {
  return (
    <dl className={s.kv} {...(split ? { 'data-align': 'split' } : {})} {...(label ? { 'aria-label': label } : {})}>
      {items.map((i, n) => (
        <div key={i.key ?? n} style={{ display: 'contents' }}>
          <dt>{i.label}</dt>
          <dd className={i.strong ? s.kvStrong : undefined}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ tone, icon, children, role }: { tone?: 'warning' | 'danger' | 'success' | 'brand'; icon?: IconName; children: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <p className={s.notice} {...(tone ? { 'data-tone': tone } : {})} {...(role ? { role } : {})}>
      {icon ? <Icon name={icon} size={14} /> : null}
      <span>{children}</span>
    </p>
  );
}

export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty} role="status">
      <Icon name="inbox" size={20} className={s.muted} />
      <p className={s.emptyTitle}>{title}</p>
      {body ? <p className={s.emptyBody}>{body}</p> : null}
      {action}
    </div>
  );
}

/* ── Meters ─────────────────────────────────────────────────────────────────────────────────────── */

export function Meter({ parts, label, size }: { parts: readonly { value: number; tone: 'success' | 'flight' | 'ink' | 'brand' | 'warning' | 'danger' }[]; label: string; size?: 'sm' }) {
  return (
    <div className={s.meter} role="img" aria-label={label} {...(size ? { 'data-size': size } : {})}>
      {parts.map((p, i) => (
        <span key={i} className={s.meterPart} data-tone={p.tone} style={{ width: `${Math.max(0, Math.min(100, p.value))}%` }} />
      ))}
    </div>
  );
}

export function Legend({ items }: { items: readonly { tone: 'success' | 'flight' | 'ink' | 'brand' | 'empty'; label: ReactNode }[] }) {
  return (
    <div className={s.legend}>
      {items.map((i, n) => (
        <span key={n}>
          <span className={s.legendKey} data-tone={i.tone} aria-hidden="true" />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/* ── Timeline ───────────────────────────────────────────────────────────────────────────────────── */

export function Timeline({ events }: { events: readonly { key: string; title: ReactNode; meta?: ReactNode; time: ReactNode; tone?: 'success' | 'danger' | 'warning' | 'neutral' }[] }) {
  return (
    <ol className={s.timeline}>
      {events.map((e) => (
        <li key={e.key} className={s.event}>
          <span className={s.eventDot} {...(e.tone && e.tone !== 'neutral' ? { 'data-tone': e.tone } : {})} aria-hidden="true" />
          <span className={s.eventText}>
            <span>{e.title}</span>
            {e.meta ? <span className={s.eventMeta}>{e.meta}</span> : null}
          </span>
          <span className={s.eventTime}>{e.time}</span>
        </li>
      ))}
    </ol>
  );
}

export { cx, s as deskStyles };
