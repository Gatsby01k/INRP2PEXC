'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { type SearchHit, searchAction } from '../../../server/actions/search.ts';
import { CommandGlyph, Icon, type IconName } from './icons.tsx';
import { PALETTE_EVENT, isTyping, modalOpen, openShortcuts } from './events.ts';
import type { NavGroup } from './Sidebar.tsx';
import { Kbd } from './ui.tsx';
import c from './palette.module.css';

interface Item {
  readonly id: string;
  readonly group: string;
  readonly icon: IconName;
  readonly label: string;
  readonly detail?: string;
  readonly hint?: ReactNode;
  readonly run: () => void;
}

const KIND_GROUP: Record<SearchHit['kind'], { group: string; icon: IconName }> = {
  trade: { group: 'Trades', icon: 'orders' },
  request: { group: 'Requests and quotes', icon: 'desk' },
  quote: { group: 'Requests and quotes', icon: 'desk' },
  exception: { group: 'Exceptions', icon: 'exceptions' },
  client: { group: 'Clients', icon: 'clients' },
};

/**
 * A ⌘K pressed while a heavy page is still hydrating would otherwise be lost: the palette's own listener only
 * exists once React has mounted it. This one is registered when the module loads — before hydration finishes —
 * and only remembers the request; the palette honours it on mount and then takes over.
 */
let mounted = false;
let requestedBeforeMount = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (mounted || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
    e.preventDefault();
    requestedBeforeMount = true;
  });
}

/**
 * ⌘K / Ctrl+K anywhere on the desk, or "/" (UX_FLOWS §2). One field does three jobs: jump to a section, run a
 * desk-wide action, and find a record by what an operator actually has in hand — a trade reference, a UTR read off
 * a bank statement, a transaction hash from an explorer, a request or case reference, a client's name. Arrow keys
 * move, Enter opens, Escape closes and gives focus back to whatever had it.
 */
export function CommandPalette({ groups }: { groups: readonly NavGroup[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Results carry the query they answer, so a list is never shown (or opened) for text the operator has since changed.
  const [result, setResult] = useState<{ readonly q: string; readonly hits: readonly SearchHit[] }>({ q: '', hits: [] });
  const [active, setActive] = useState(0);
  // Enter pressed before the answer arrived: the query it was pressed on, opened as soon as that answer lands.
  const enterOn = useRef<string | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const seq = useRef(0);

  const show = useCallback(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setResult({ q: '', hits: [] });
    enterOn.current = null;
    setActive(0);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    restore.current?.focus();
  }, []);

  useEffect(() => {
    mounted = true;
    if (requestedBeforeMount) {
      requestedBeforeMount = false;
      show();
    }
    return () => {
      mounted = false;
    };
  }, [show]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) close();
        else show();
      } else if (e.key === '/' && !open && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target as Element) && !modalOpen()) {
        e.preventDefault();
        show();
      }
    };
    const onOpen = () => show();
    window.addEventListener('keydown', onKey);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, [open, show, close]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Search as the operator types, latest answer wins: a slow response for "IX-2" must not overwrite "IX-26".
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) return;
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      void searchAction(q)
        .catch(() => [] as SearchHit[])
        .then((res) => {
          if (seq.current === mine) setResult({ q, hits: res });
        });
    }, 120);
    return () => window.clearTimeout(t);
  }, [query, open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const trimmed = query.trim();
  const searching = trimmed.length >= 2 && result.q !== trimmed;
  const hits = useMemo(() => (result.q === trimmed ? result.hits : []), [result, trimmed]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const nav: Item[] = groups
      .flatMap((g) => g.entries)
      .filter((e) => q === '' || e.label.toLowerCase().includes(q))
      .map((e) => ({
        id: `nav:${e.href}`,
        group: 'Jump to',
        icon: e.icon,
        label: e.label,
        ...(e.count ? { detail: `${e.count} ${e.tone === 'alert' ? 'open' : 'waiting'}` } : {}),
        hint: (
          <>
            <Kbd>G</Kbd>
            <Kbd>{e.key.toUpperCase()}</Kbd>
          </>
        ),
        run: () => go(e.href),
      }));
    const actionList: Item[] = [
      { id: 'act:shortcuts', group: 'Actions', icon: 'keyboard', label: 'Show keyboard shortcuts', hint: <Kbd>?</Kbd>, run: () => (setOpen(false), openShortcuts()) },
      { id: 'act:new-request', group: 'Actions', icon: 'plus', label: 'New request for a client…', detail: 'Opens the client book', run: () => go('/clients') },
      { id: 'act:refresh', group: 'Actions', icon: 'refresh', label: 'Refresh this page', run: () => (setOpen(false), router.refresh()) },
    ];
    const actions = actionList.filter((a) => q === '' || a.label.toLowerCase().includes(q));
    const found: Item[] = hits.map((h) => ({
      id: `${h.kind}:${h.id}`,
      group: KIND_GROUP[h.kind].group,
      icon: KIND_GROUP[h.kind].icon,
      label: h.label,
      detail: h.detail,
      run: () => go(h.href),
    }));
    // Records first once there is something to find: a reference typed in is almost always a record wanted.
    return q.length >= 2 ? [...found, ...nav, ...actions] : [...nav, ...actions];
  }, [groups, hits, query, go, router]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  // The answer to a query Enter was already pressed on: open its first entry, as Enter would have.
  useEffect(() => {
    if (enterOn.current === null || searching) return;
    const wanted = enterOn.current;
    enterOn.current = null;
    if (wanted === trimmed) items[0]?.run();
  }, [searching, trimmed, items]);

  if (!open) return null;

  const grouped: { group: string; items: { item: Item; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const g = grouped.find((x) => x.group === item.group);
    if (g) g.items.push({ item, index });
    else grouped.push({ group: item.group, items: [{ item, index }] });
  });
  const activeItem = items[active];

  return (
    <div className={c.scrim} onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Command bar" className={c.sheet} onMouseDown={(e) => e.stopPropagation()}>
        <div className={c.field}>
          <Icon name="search" size={16} className={c.fieldIcon} />
          <input
            ref={input}
            className={c.input}
            role="combobox"
            aria-label="Search trades, UTRs, transaction hashes, references or clients"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeItem ? `${listId}-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            placeholder="Trade ref, UTR, tx hash, RQ/QT/EX ref, client — or a page"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (searching) enterOn.current = trimmed;
                else activeItem?.run();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          {searching ? <span className={c.searching}>Searching…</span> : null}
        </div>

        {searching && items.length === 0 ? (
          <div className={c.nothing} role="status">
            <p>Looking up “{trimmed}”…</p>
          </div>
        ) : items.length > 0 ? (
          <ul id={listId} role="listbox" aria-label="Results" className={c.list}>
            {grouped.map((g) => (
              <li key={g.group} role="presentation">
                <span className={c.groupLabel} aria-hidden="true">
                  {g.group}
                </span>
                <ul role="group" aria-label={g.group} className={c.groupList}>
                  {g.items.map(({ item, index }) => (
                    <li
                      key={item.id}
                      id={`${listId}-${item.id}`}
                      role="option"
                      aria-selected={index === active}
                      className={c.option}
                      onMouseMove={() => setActive(index)}
                      onClick={() => item.run()}
                    >
                      <Icon name={item.icon} size={16} className={c.optionIcon} />
                      <span className={c.optionText}>
                        <span className={c.optionLabel}>{item.label}</span>
                        {item.detail ? <span className={c.optionDetail}>{item.detail}</span> : null}
                      </span>
                      {item.hint ? <span className={c.optionHint}>{item.hint}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <div className={c.nothing} role="status">
            <p>Nothing matches “{query.trim()}”.</p>
            <p className={c.nothingHint}>References, UTRs and transaction hashes match exactly; client names match from the start.</p>
          </div>
        )}

        <footer className={c.foot}>
          <span>
            <Kbd label="Up">
              <Icon name="arrowUp" size={10} />
            </Kbd>
            <Kbd label="Down">
              <Icon name="arrowDown" size={10} />
            </Kbd>{' '}
            move
          </span>
          <span>
            <Kbd>Enter</Kbd> open
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
          <span className={c.footRight}>
            <Kbd>
              <CommandGlyph size={10} />K
            </Kbd>{' '}
            anywhere
          </span>
        </footer>
      </div>
    </div>
  );
}
