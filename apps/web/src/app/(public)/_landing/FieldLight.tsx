'use client';

import { useEffect } from 'react';

/**
 * Light on an orange field follows the pointer, as it would across the robot's shell (the workspace does the same,
 * `(client)/_workspace/FieldLight.tsx`). One listener for the page: it finds the field under the pointer and tells it
 * where the pointer is (`--mx`, `--my`); the field's own style draws the light there. Nothing moves for a reader who
 * asked for less motion, or on touch.
 */
export function FieldLight() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(hover: hover)').matches) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      frame = 0;
      const e = last;
      if (!e) return;
      const field = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-field-light]') : null;
      if (!field) return;
      const box = field.getBoundingClientRect();
      field.style.setProperty('--mx', `${e.clientX - box.left}px`);
      field.style.setProperty('--my', `${e.clientY - box.top}px`);
      field.setAttribute('data-lit', '');
    };
    const move = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    document.addEventListener('pointermove', move, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move);
    };
  }, []);
  return null;
}
