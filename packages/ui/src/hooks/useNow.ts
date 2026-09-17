import { useEffect, useState } from 'react';

/**
 * Display clock for countdowns. The server decides expiry; this only drives rendering.
 * Pass a fixed `now` (stories, tests, SSR) to disable ticking.
 */
export function useNow(fixed?: Date, intervalMs = 250): Date {
  const [now, setNow] = useState(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed) {
      setNow(fixed);
      return;
    }
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [fixed, intervalMs]);
  return now;
}
