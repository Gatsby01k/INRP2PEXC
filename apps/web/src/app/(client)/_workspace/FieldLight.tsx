'use client';

import { useEffect } from 'react';
import shell from '../shell.module.css';

/**
 * Light on an orange field follows the pointer, as it would across the robot's shell. One listener for the whole
 * workspace: it finds the field under the pointer and tells it where the pointer is; the field's own style draws the
 * light there (`shell.brandField`, `shell.cap`). Nothing moves for a reader who asked for less motion, or on touch.
 */
export function FieldLight() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(hover: hover)').matches) return;
    const fields = `.${shell.brandField}, .${shell.cap}`;
    const move = (e: PointerEvent) => {
      const field = e.target instanceof Element ? e.target.closest<HTMLElement>(fields) : null;
      if (!field) return;
      const box = field.getBoundingClientRect();
      field.style.setProperty('--mx', `${e.clientX - box.left}px`);
      field.style.setProperty('--my', `${e.clientY - box.top}px`);
    };
    document.addEventListener('pointermove', move, { passive: true });
    return () => document.removeEventListener('pointermove', move);
  }, []);
  return null;
}
