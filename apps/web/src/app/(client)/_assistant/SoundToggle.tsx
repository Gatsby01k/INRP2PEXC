'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { setSoundEnabled, soundEnabled, subscribeSound, wireSoundUnlock } from './sound.ts';

function SpeakerIcon({ on, className }: { on: boolean; className?: string | undefined }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z" />
      {on ? <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /> : <path d="m16 9.5 5 5m0-5-5 5" />}
    </svg>
  );
}

/**
 * The workspace's one sound control. Pressed means on. The choice is remembered on this device; until it is made,
 * sound follows the platform's reduced-motion preference (`sound.ts`).
 */
export function SoundToggle({ className, iconClassName, labelClassName }: { className?: string | undefined; iconClassName?: string | undefined; labelClassName?: string | undefined }) {
  const on = useSyncExternalStore(subscribeSound, soundEnabled, () => false);
  useEffect(() => wireSoundUnlock(), []);
  return (
    <button type="button" className={className} aria-pressed={on} onClick={() => setSoundEnabled(!on)} title={on ? 'Sounds on — click to mute' : 'Sounds off — click to turn on'}>
      <SpeakerIcon on={on} className={iconClassName} />
      <span className={labelClassName}>Sound</span>
    </button>
  );
}
