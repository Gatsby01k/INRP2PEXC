'use client';

import { type ReactNode, useEffect, useState, ViewTransition } from 'react';

/**
 * Moving between pages, the work settles out and the next page rises in (app.css `.ix-page`) — but only once the page
 * is live. On a full load the page streams in and must be shown the frame it arrives (ADR 0021 §4.5); an animated
 * boundary there would have React reveal it through a view transition, frames later. So the boundary is always here
 * (the tree never changes shape, nothing remounts) and animates nothing until the first page has hydrated.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  return <ViewTransition default={live ? 'ix-page' : 'none'}>{children}</ViewTransition>;
}
