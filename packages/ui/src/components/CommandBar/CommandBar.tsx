import { useId, useState, type KeyboardEvent } from 'react';
import { cx } from '../../cx.ts';
import styles from './CommandBar.module.css';

export interface CommandResult {
  id: string;
  kind: 'trade' | 'utr' | 'tx' | 'client';
  label: string;
  detail?: string;
}

const KIND: Record<CommandResult['kind'], string> = { trade: 'Trade', utr: 'UTR', tx: 'Tx', client: 'Client' };

/** Command-K search by trade ref, UTR, tx hash or client. Combobox + listbox semantics with arrow-key selection. */
export function CommandBar({ query, onQueryChange, results, onSelect }: { query: string; onQueryChange: (q: string) => void; results: readonly CommandResult[]; onSelect: (r: CommandResult) => void }) {
  const listId = useId();
  const [active, setActive] = useState(0);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && results[active]) {
      onSelect(results[active]!);
    }
  };
  const activeId = results[active] ? `${listId}-${results[active]!.id}` : undefined;
  return (
    <div className={styles.root}>
      <div className={styles.field}>
        <input
          className={styles.input}
          role="combobox"
          aria-label="Search trades, UTRs, transaction hashes or clients"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeId}
          value={query}
          placeholder="Trade ref, UTR, tx hash or client"
          onChange={(e) => {
            setActive(0);
            onQueryChange(e.target.value);
          }}
          onKeyDown={onKey}
        />
        <kbd className={styles.kbd}>
          {/* ⌘ (U+2318) is not in Geist Mono; drawn as SVG so it renders identically everywhere. */}
          <svg className={styles.kbdIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
          </svg>
          <span aria-hidden="true">K</span>
          <span className="ix-visually-hidden">Command K</span>
        </kbd>
      </div>
      {results.length > 0 ? (
        <ul id={listId} role="listbox" className={styles.list} aria-label="Results">
          {results.map((r, i) => (
            <li
              key={r.id}
              id={`${listId}-${r.id}`}
              role="option"
              aria-selected={i === active}
              className={cx(styles.option, i === active && styles.active)}
              onMouseEnter={() => setActive(i)}
              onClick={() => onSelect(r)}
            >
              <span className={styles.kind}>{KIND[r.kind]}</span>
              <span className={cx(styles.label, 'ix-num')}>{r.label}</span>
              {r.detail ? <span className={styles.detail}>{r.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
