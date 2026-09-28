'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, CommandGlyph } from './icons.tsx';
import { COMMAND_EVENT, type CommandEventDetail, SHORTCUTS_EVENT, isTyping, modalOpen } from './events.ts';
import type { NavGroup } from './Sidebar.tsx';
import { Kbd } from './ui.tsx';
import c from './palette.module.css';

/**
 * The desk's global keys, and the sheet that lists them (`?`).
 *
 * `g` then a letter jumps to a section — the same two keys every time, shown next to each item in the palette and
 * in the sheet. Nothing here fires while someone is typing, holding a modifier, or answering a dialog: a shortcut
 * must never land in the middle of an amount, a UTR or an authenticator code.
 */
export function GlobalKeys({ groups }: { groups: readonly NavGroup[] }) {
  const router = useRouter();
  const [help, setHelp] = useState(false);
  const pendingG = useRef<number | null>(null);

  useEffect(() => {
    const entries = groups.flatMap((g) => g.entries);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTyping(e.target as Element) || modalOpen()) return;
      if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
        return;
      }
      const k = e.key.toLowerCase();
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const to = entries.find((x) => x.key === k);
        if (to) {
          e.preventDefault();
          router.push(to.href);
        }
        return;
      }
      // `g` starts a jump only outside a focused row, where the row's own letters (Q, P, U, E) belong.
      if (k === 'g' && !(e.target as HTMLElement | null)?.closest('tr[data-row]')) {
        pendingG.current = window.setTimeout(() => {
          pendingG.current = null;
        }, 1200);
      }
    };
    const onHelp = () => setHelp(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(SHORTCUTS_EVENT, onHelp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(SHORTCUTS_EVENT, onHelp);
    };
  }, [groups, router]);

  return help ? <ShortcutSheet groups={groups} onClose={() => setHelp(false)} /> : null;
}

function Row({ label, keys }: { label: string; keys: ReactNode }) {
  return (
    <div className={c.helpRow}>
      <span>{label}</span>
      <span className={c.helpKeys}>{keys}</span>
    </div>
  );
}

function ShortcutSheet({ groups, onClose }: { groups: readonly NavGroup[]; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const restore = useRef<Element | null>(null);
  useEffect(() => {
    restore.current = document.activeElement;
    close.current?.focus();
    return () => {
      if (restore.current instanceof HTMLElement) restore.current.focus();
    };
  }, []);
  return (
    <div className={c.scrim} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className={c.sheet}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        style={{ width: 'min(760px, 100%)' }}
      >
        <div className={c.helpHead}>
          <h2 className={c.helpTitle}>Keyboard shortcuts</h2>
          <button ref={close} type="button" className={c.option} style={{ minHeight: 32 }} onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className={c.helpBody}>
          <div className={c.helpGroup}>
            <h3 className={c.helpGroupTitle}>Anywhere</h3>
            <Row
              label="Search, jump, act"
              keys={
                <>
                  <Kbd>
                    <CommandGlyph size={10} />K
                  </Kbd>
                  or <Kbd>/</Kbd>
                </>
              }
            />
            <Row label="This sheet" keys={<Kbd>?</Kbd>} />
            <Row label="Close a panel or dialog" keys={<Kbd>Esc</Kbd>} />
            <h3 className={c.helpGroupTitle} style={{ marginTop: 12 }}>
              Lists and the queue
            </h3>
            <Row
              label="Move between rows"
              keys={
                <>
                  <Kbd label="Up">
                    <Icon name="arrowUp" size={10} />
                  </Kbd>
                  <Kbd label="Down">
                    <Icon name="arrowDown" size={10} />
                  </Kbd>
                  or <Kbd>J</Kbd>
                  <Kbd>K</Kbd>
                </>
              }
            />
            <Row label="Open the row" keys={<Kbd>Enter</Kbd>} />
            <Row label="Quote a request" keys={<Kbd>Q</Kbd>} />
            <Row label="Payout / confirm client funds" keys={<Kbd>P</Kbd>} />
            <Row label="Record or confirm a reference" keys={<Kbd>U</Kbd>} />
            <Row label="Resolve an exception" keys={<Kbd>E</Kbd>} />
          </div>
          <div className={c.helpGroup}>
            <h3 className={c.helpGroupTitle}>Go to</h3>
            {groups
              .flatMap((g) => g.entries)
              .map((e) => (
                <Row
                  key={e.href}
                  label={e.label}
                  keys={
                    <>
                      <Kbd>G</Kbd>
                      <Kbd>{e.key.toUpperCase()}</Kbd>
                    </>
                  }
                />
              ))}
            <h3 className={c.helpGroupTitle} style={{ marginTop: 12 }}>
              In a panel
            </h3>
            <Row label="Send the quote" keys={<Kbd>Q</Kbd>} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A quiet confirmation after a command went through ("Payout confirmed · L-…"). Refusals are not toasted: they are
 * shown where the action was taken, next to the thing that has to change.
 */
export function Toaster() {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const next = useRef(0);
  useEffect(() => {
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent<CommandEventDetail>).detail;
      if (!detail?.ok) return;
      const id = ++next.current;
      setToasts((t) => [...t.slice(-2), { id, text: detail.summary }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    };
    window.addEventListener(COMMAND_EVENT, onDone);
    return () => window.removeEventListener(COMMAND_EVENT, onDone);
  }, []);
  return (
    <div className={c.toasts} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={c.toast}>
          <Icon name="check" size={14} className={c.toastIcon} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Keeps a live page live: it re-reads the page from the server every `seconds` while the tab is visible — never
 * while someone is typing or a dialog is open, so it cannot pull the ground out from under an action in progress.
 * The server re-renders from the system of record; nothing is cached here.
 */
export function LiveRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (isTyping(document.activeElement) || modalOpen()) return;
      router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [router, seconds]);
  return null;
}
