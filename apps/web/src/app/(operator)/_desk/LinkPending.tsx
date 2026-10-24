'use client';

import { useLinkStatus } from 'next/link';
import s from './desk.module.css';

/**
 * Inside a link whose page is being read. A tab, a period or a filter changes only the page's own query, so no loading
 * shape replaces the page (the figures on it stay until the new ones are read); this says the click was taken.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span className={s.linkPending} aria-hidden="true" /> : null;
}
