/**
 * The shell's few cross-component signals, as DOM events: the palette and the shortcut sheet can be opened from
 * anywhere (a sidebar button, a key, an empty state) without every caller holding a reference to them, and a
 * finished command can announce itself without the command hook knowing a toast exists.
 */
export const PALETTE_EVENT = 'desk:palette';
export const SHORTCUTS_EVENT = 'desk:shortcuts';
export const COMMAND_EVENT = 'desk:command';

export interface CommandEventDetail {
  readonly ok: boolean;
  readonly summary: string;
}

export const openPalette = (): void => {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
};

export const openShortcuts = (): void => {
  window.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT));
};

export const announceCommand = (detail: CommandEventDetail): void => {
  window.dispatchEvent(new CustomEvent<CommandEventDetail>(COMMAND_EVENT, { detail }));
};

/** True while a person is typing: a letter there is a letter, never a shortcut. */
export function isTyping(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type.toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(type);
}

/** True while a modal dialog (the step-up prompt, the palette) owns the keyboard. */
export const modalOpen = (): boolean => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
