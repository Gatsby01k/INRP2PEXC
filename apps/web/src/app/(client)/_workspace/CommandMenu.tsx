'use client';

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  BankIcon, BellIcon, ClockIcon, DealsIcon, GaugeIcon, GlobeIcon, ReturnIcon, SearchIcon, ShieldIcon, StoreIcon, SwapIcon, TagIcon, UserIcon, UsersIcon,
} from './icons.tsx';
import styles from './command.module.css';

export interface CommandEntry {
  readonly href: string;
  readonly label: string;
  readonly group: string;
  /** A quiet word after the label: whose desk, how many unread. */
  readonly hint?: string;
}

const ICONS: Record<string, typeof SwapIcon> = {
  '/exchange': SwapIcon,
  '/history': ClockIcon,
  '/destinations': BankIcon,
  '/desks': StoreIcon,
  '/desk': GaugeIcon,
  '/desk/deals': DealsIcon,
  '/desk/prices': TagIcon,
  '/desk/clients': UserIcon,
  '/desk/team': UsersIcon,
  '/desk/settings': GlobeIcon,
  '/traders': UsersIcon,
  '/open-account': UserIcon,
  '/notifications': BellIcon,
  '/account': ShieldIcon,
  '/account/team': UsersIcon,
};

/** Loose matching: every word typed must start a word of the entry, so "ban" finds "Bank & wallets" and "dp" nothing. */
function matches(entry: CommandEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${entry.label} ${entry.group} ${entry.hint ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Jump anywhere in the workspace from the keyboard: ⌘K (Ctrl K) or "/" opens it, typing narrows it, the arrows move
 * and Enter goes. It only ever navigates — nothing here commits money — so it needs no confirmation of its own.
 */
export function CommandMenu({ entries }: { entries: readonly CommandEntry[] }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [mac, setMac] = useState(true);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);

  const results = useMemo(() => entries.filter((e) => matches(e, query)), [entries, query]);
  const groups = useMemo(() => {
    const out: {
      group: string;
      items: { entry: CommandEntry; index: number }[];
    }[] = [];
    results.forEach((entry, index) => {
      const g = out.find((x) => x.group === entry.group);
      if (g) g.items.push({ entry, index });
      else out.push({ group: entry.group, items: [{ entry, index }] });
    });
    return out;
  }, [results]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
    trigger.current?.focus();
  }, []);

  const go = useCallback(
    (entry: CommandEntry | undefined) => {
      if (!entry) return;
      setOpen(false);
      setQuery('');
      setActive(0);
      router.push(entry.href);
    },
    [router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === '/' && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <>
      <button ref={trigger} type="button" className={styles.trigger} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <SearchIcon className={styles.triggerIcon} />
        <span className={styles.triggerText}>Search or jump to…</span>
        <kbd className={styles.kbd} aria-hidden="true">
          {mac ? '⌘' : 'Ctrl'} K
        </kbd>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div className={styles.layer} onPointerDown={(e) => e.target === e.currentTarget && close()}>
              <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Search the workspace">
                <div className={styles.field}>
                  <SearchIcon className={styles.fieldIcon} />
                  <input
                    ref={input}
                    className={styles.input}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onInputKey}
                    placeholder="Where to?"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={`${id}-list`}
                    aria-activedescendant={results[active] ? `${id}-${active}` : undefined}
                    aria-autocomplete="list"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <kbd className={styles.kbd}>Esc</kbd>
                </div>
                <ul ref={list} id={`${id}-list`} className={styles.list} role="listbox" aria-label="Places">
                  {groups.map((g) => (
                    <li key={g.group} role="presentation">
                      <span className={styles.group}>{g.group}</span>
                      <ul role="presentation" className={styles.groupList}>
                        {g.items.map(({ entry, index }) => {
                          const Icon = ICONS[entry.href] ?? SwapIcon;
                          return (
                            <li
                              key={`${entry.group}-${entry.href}`}
                              id={`${id}-${index}`}
                              role="option"
                              aria-selected={index === active}
                              data-active={index === active}
                              className={styles.option}
                              onPointerMove={() => setActive(index)}
                              onClick={() => go(entry)}
                            >
                              <span className={styles.optionGlyph} aria-hidden="true">
                                <Icon className={styles.optionIcon} />
                              </span>
                              <span className={styles.optionLabel}>{entry.label}</span>
                              {entry.hint ? <span className={styles.optionHint}>{entry.hint}</span> : null}
                              <ReturnIcon className={styles.optionEnter} />
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                  {results.length === 0 ? <li className={styles.empty}>Nothing in the workspace by that name.</li> : null}
                </ul>
                <div className={styles.foot} aria-hidden="true">
                  <span>
                    <kbd className={styles.kbd}>↑</kbd>
                    <kbd className={styles.kbd}>↓</kbd> to move
                  </span>
                  <span>
                    <kbd className={styles.kbd}>↵</kbd> to open
                  </span>
                  <span>
                    <kbd className={styles.kbd}>/</kbd> or <kbd className={styles.kbd}>{mac ? '⌘' : 'Ctrl'} K</kbd> anywhere
                  </span>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
