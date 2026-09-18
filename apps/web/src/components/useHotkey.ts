'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Makes a panel's advertised letter shortcut real. The `<kbd>` hint on a button is a promise to the operator, and
 * a hint that does nothing is worse than no hint at all.
 *
 * The binding lives on the panel, so it fires only while focus is inside it, and it stands aside while the
 * operator is typing or holding a modifier — a shortcut must never fire in the middle of an amount or a UTR.
 * Pass `null` while the action is unavailable; the key then does nothing rather than half of something.
 */
/** Controls where a letter is a letter. A checkbox or a button is not one of them, so a shortcut still works there. */
const TEXT_ENTRY = new Set(['text', 'password', 'email', 'number', 'search', 'tel', 'url', 'date', 'time', 'datetime-local', 'month', 'week']);

function isTyping(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && TEXT_ENTRY.has((el as HTMLInputElement).type.toLowerCase());
}

export function useHotkey(scope: RefObject<HTMLElement | null>, key: string, run: (() => void) | null): void {
  useEffect(() => {
    const el = scope.current;
    if (!el || !run) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== key.toLowerCase()) return;
      if (isTyping(e.target as HTMLElement | null)) return;
      e.preventDefault();
      run();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [scope, key, run]);
}
