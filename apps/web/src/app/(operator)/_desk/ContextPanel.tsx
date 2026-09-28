'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons.tsx';
import { Kbd } from './ui.tsx';
import p from './panel.module.css';

/**
 * The right-hand context panel (UX_FLOWS §2): opened from a row, it keeps the list beside it. Escape closes it
 * (unless a dialog above it, or a field being typed in, owns the key), and "Open record" goes to the full page.
 */
export function ContextPanel({
  refLabel,
  title,
  subtitle,
  badges,
  closeHref,
  recordHref,
  children,
  testId,
  label,
}: {
  refLabel: string;
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  closeHref: string;
  recordHref?: string;
  children: ReactNode;
  testId: string;
  label: string;
}) {
  const router = useRouter();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      router.push(closeHref, { scroll: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeHref, router]);

  return (
    <aside ref={panel} className={p.panel} aria-label={label} data-testid={testId}>
      <header className={p.head}>
        <div className={p.headText}>
          <span className={p.ref}>{refLabel}</span>
          <h2 className={p.title}>{title}</h2>
          {subtitle ? <span className={p.subtitle}>{subtitle}</span> : null}
          {badges ? <span className={p.badges}>{badges}</span> : null}
        </div>
        <div className={p.headActions}>
          {recordHref ? (
            <Link href={recordHref} className={p.open}>
              Open record
              <Icon name="arrowUpRight" size={14} />
            </Link>
          ) : null}
          <Link href={closeHref} scroll={false} className={p.close} aria-label="Close panel" title="Close (Esc)">
            <Icon name="close" size={16} />
          </Link>
        </div>
      </header>
      <div className={p.body}>{children}</div>
      <footer className={p.foot}>
        <Kbd>Esc</Kbd> close
      </footer>
    </aside>
  );
}

/** A titled block inside a panel or a record column. */
export function PanelSection({ title, aside, children, testId, tone }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; testId?: string; tone?: 'danger' }) {
  return (
    <section className={p.section} {...(testId ? { 'data-testid': testId } : {})} {...(tone ? { 'data-tone': tone } : {})}>
      {title ? (
        <div className={p.sectionHead}>
          <h3 className={p.sectionTitle}>{title}</h3>
          {aside ? <span className={p.sectionAside}>{aside}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
