'use client';

import { useEffect, useState } from 'react';

/**
 * The server's business clock, carried forward in the browser: the page is rendered with the database's own "now"
 * — the clock acceptance is judged by — and this keeps counting from it at the browser's pace, so a countdown
 * agrees with the server however far the device's own clock is off. Ticks once a second while `ticking`.
 */
export function useServerClock(serverTime: string, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.parse(serverTime));
  useEffect(() => {
    const skew = Date.parse(serverTime) - Date.now();
    setNow(Date.now() + skew);
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now() + skew), 1000);
    return () => window.clearInterval(id);
  }, [serverTime, ticking]);
  return now;
}
