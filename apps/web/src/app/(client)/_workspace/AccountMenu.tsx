'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SoundToggle } from '../_assistant/SoundToggle.tsx';
import { ChevronDownIcon, ShieldIcon, SignOutIcon } from './icons.tsx';
import styles from './account-menu.module.css';

/**
 * Who is signed in, and the few things that belong to them rather than to a page: their account and its security,
 * whether the workspace plays its sounds, and signing out. A disclosure button and a short list of links — the menu closes on Escape, on a click outside,
 * and when one of its links is followed.
 */
export function AccountMenu({ name, email, role, hasAccount }: { name: string; email: string; role: string | null; hasAccount: boolean }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const initial = name.trim().charAt(0).toUpperCase() || '·';

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const signOut = async () => {
    setLeaving(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } finally {
      router.push('/sign-in');
      router.refresh();
    }
  };

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={button}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initial}
        </span>
        <span className={styles.triggerName}>{name}</span>
        <ChevronDownIcon className={styles.chevron} />
        <span className="ix-visually-hidden">Account menu</span>
      </button>
      <div id={`${id}-menu`} className={styles.menu} data-open={open || undefined} hidden={!open}>
        <div className={styles.who}>
          <span className={styles.avatarLarge} aria-hidden="true">
            {initial}
          </span>
          <span className={styles.whoText}>
            <span className={styles.whoName}>{name}</span>
            <span className={styles.whoMeta}>
              {email}
              {role ? ` · ${role}` : ''}
            </span>
          </span>
        </div>
        <ul className={styles.items}>
          {hasAccount ? (
            <li>
              <Link className={styles.item} href="/account" onClick={() => setOpen(false)}>
                <ShieldIcon className={styles.itemIcon} />
                Account & security
              </Link>
            </li>
          ) : null}
          <li>
            <SoundToggle className={styles.item} iconClassName={styles.itemIcon} labelClassName={styles.itemLabel} />
          </li>
          <li>
            <button type="button" className={styles.item} onClick={() => void signOut()} disabled={leaving}>
              <SignOutIcon className={styles.itemIcon} />
              {leaving ? 'Signing out…' : 'Sign out'}
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}
