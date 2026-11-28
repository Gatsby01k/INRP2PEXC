'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Hint } from '../_workspace/Hint.tsx';
import { MoreIcon, PlusIcon } from '../_workspace/icons.tsx';
import { StateRing, type RingState } from '../_workspace/StateRing.tsx';
import styles from './destinations.module.css';

/**
 * The pieces every list on Bank & wallets is made of: a group with its heading, a card per account, UPI ID or wallet —
 * its mark, who it is, the figure that identifies it, what it can do — the tile that adds one, and the menu with what
 * is done to one less often (archive, limits). Shared with the trader's settlement page, which shows the same UPI IDs.
 */

export function Group({ id, title, count, note, action, children }: { id: string; title: string; count: number; note: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={styles.group} aria-labelledby={id}>
      <div className={styles.groupHead}>
        <div className={styles.groupText}>
          <div className={styles.groupTitleRow}>
            <h2 id={id} className={styles.groupTitle}>
              {title}
            </h2>
            {count > 0 ? (
              <span className={styles.count}>{count}</span>
            ) : null}
            {/* What the group is for, one tap away: the tiles say what is in it. */}
            <Hint label={`About ${title}`}>{note}</Hint>
          </div>
        </div>
        {action}
      </div>
      <ul className={styles.grid}>{children}</ul>
    </section>
  );
}

/** One account, UPI ID or wallet. `tint` is its own colour — the bank's, UPI's, Tether's — as a wash in the corner. */
export function Instrument({ tint, state, children }: { tint: string; state?: string | undefined; children: React.ReactNode }) {
  return (
    <li className={styles.instrument} data-state={state} style={{ ['--tint' as string]: tint }}>
      {children}
    </li>
  );
}

export function InstrumentTop({ mark, title, sub, tag }: { mark: React.ReactNode; title: React.ReactNode; sub: React.ReactNode; tag?: React.ReactNode }) {
  return (
    <div className={styles.top}>
      {mark}
      <span className={styles.who}>
        <span className={styles.title}>{title}</span>
        <span className={styles.sub}>{sub}</span>
      </span>
      {tag}
    </div>
  );
}

export type Tone = 'success' | 'brand' | 'warning' | 'danger' | 'muted';

/** Each state's ring, from the same family as every status in the workspace (`StateRing`). */
const TAG_RING: Record<Tone, RingState> = {
  success: 'done',
  brand: 'live',
  warning: 'check',
  danger: 'hold',
  muted: 'hold',
};

/** What state one is in, in a word — with a glyph or a dot, never colour alone. */
export function Tag({ tone, children, icon }: { tone: Tone; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <span className={styles.tag} data-tone={tone}>
      {icon ?? <StateRing state={TAG_RING[tone]} />}
      {children}
    </span>
  );
}

/** The tile that adds one more: at the end of the list, or the whole list when there is none yet. */
export function AddTile({ title, note, marks, onClick }: { title: string; note?: React.ReactNode; marks?: React.ReactNode; onClick: () => void }) {
  return (
    <li className={styles.addCell}>
      <button type="button" className={styles.addTile} onClick={onClick}>
        <span className={styles.addPlus} aria-hidden="true">
          <PlusIcon />
        </span>
        <span className={styles.addText}>
          <span className={styles.addTitle}>{title}</span>
          {note ? <span className={styles.addNote}>{note}</span> : null}
        </span>
        {marks ? (
          <span className={styles.addMarks} aria-hidden="true">
            {marks}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** A list with nothing in it, for someone who cannot add: who can. */
export function NoneYet({ children }: { children: React.ReactNode }) {
  return <li className={styles.none}>{children}</li>;
}

export interface MenuItem {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly onSelect: () => void;
  readonly tone?: 'danger';
}

/** What is done to one less often, behind its "more" button: a small menu, closed by Escape or a click elsewhere. */
export function CardMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div className={styles.menuBox} ref={box}>
      <button
        ref={trigger}
        type="button"
        className={styles.more}
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className={styles.menu} role="menu" id={menuId} aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              data-tone={item.tone}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
