'use client';

import { useEffect, useRef, useState } from 'react';
import { Led } from '../led/Led.tsx';
import styles from './closing.module.css';

/**
 * The closing robot's visor (docs/ROBOT_BEHAVIOUR.md): whose move it is now, running across it — and hearts, beating,
 * while the visitor is on the call to action beside it, the way the hero robot grows fond of its own. Pointer and
 * keyboard count the same. Decorative: the words are the button's.
 */
export function ClosingVisor({ text }: { text: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const [fond, setFond] = useState(false);

  useEffect(() => {
    const cta = host.current?.closest('section')?.querySelector<HTMLElement>('[data-closing-cta]');
    if (!cta) return;
    const on = { hover: false, focus: false };
    const update = (e: Event) => {
      if (e.type === 'pointerenter' || e.type === 'pointerleave') on.hover = e.type === 'pointerenter' && (e as PointerEvent).pointerType === 'mouse';
      if (e.type === 'focus' || e.type === 'blur') on.focus = e.type === 'focus' && cta.matches(':focus-visible');
      setFond(on.hover || on.focus);
    };
    const types = ['pointerenter', 'pointerleave', 'focus', 'blur'] as const;
    for (const type of types) cta.addEventListener(type, update);
    return () => {
      for (const type of types) cta.removeEventListener(type, update);
    };
  }, []);

  return (
    <span ref={host} className={styles.visorLeds} data-fond={fond ? '' : undefined}>
      {fond ? <Led key="fond" text="♥ ♥" pitch={7} rows={15} className={styles.visorLed} /> : <Led key="words" text={text} mode="marquee" pitch={7} rows={15} speed={14} className={styles.visorLed} />}
    </span>
  );
}
