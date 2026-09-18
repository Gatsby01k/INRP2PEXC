'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CommandBar, type CommandResult } from '@inrp2p/ui';
import { type SearchHit, searchAction } from '../server/actions/search.ts';
import styles from './CommandBarHost.module.css';

/**
 * ⌘K anywhere on the desk (UX_FLOWS §2). Typing searches trade references, UTRs, transaction hashes and client
 * names; Enter opens what is selected. Escape closes it and gives focus back to whatever had it.
 */
export function CommandBarHost() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [, startTransition] = useTransition();
  const restoreTo = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Opened by ⌘K, so focus goes with it — otherwise the operator's next keystroke lands nowhere.
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
        restoreTo.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onQueryChange = useCallback((q: string) => {
    setQuery(q);
    startTransition(async () => {
      setHits(await searchAction(q));
    });
  }, []);

  if (!open) return null;
  const results: CommandResult[] = hits.map((h) => ({ id: h.id, kind: h.kind === 'trade' ? 'trade' : 'client', label: h.label, detail: h.detail }));

  return (
    <div className={styles.scrim} onMouseDown={() => setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label="Command bar" className={styles.sheet} onMouseDown={(e) => e.stopPropagation()}>
        <CommandBar
          inputRef={input}
          query={query}
          onQueryChange={onQueryChange}
          results={results}
          onSelect={(r) => {
            const hit = hits.find((h) => h.id === r.id);
            if (!hit) return;
            setOpen(false);
            router.push(hit.href);
          }}
        />
      </div>
    </div>
  );
}
