'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { formatCountdown } from '@inrp2p/ui/format';
import type { LiveDeal as Deal } from '../../../server/live-deal.ts';
import { Digits } from './Odometer.tsx';
import shell from '../shell.module.css';

/** How often the bar looks again while it is being looked at; it also looks on every move between pages. */
const POLL_MS = 30_000;

/** A reference as the bar has room for it: its kind and its number, without the date in the middle. */
const shortRef = (ref: string) => ref.replace(/-\d{6}-/, '-');

/**
 * The deal waiting on you, growing out of the robot's island in the bar on every page: its reference, the move, and
 * the time left lit and counting down digit by digit — one tap to the deal. It reads after the page has drawn (`/api/client/live`), so no page waits for it, and it
 * draws nothing when nothing waits on you or when you are already on that deal's page.
 */
export function LiveDeal() {
  const pathname = usePathname();
  const [deal, setDeal] = useState<(Deal & { readonly offset: number }) | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/client/live', { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        const { deal: next } = (await res.json()) as { deal: Deal | null };
        // The countdown runs on the server's clock: the offset between the two is taken once per read.
        if (alive) setDeal(next ? { ...next, offset: Date.parse(next.now) - Date.now() } : null);
      } catch {
        // A missed read leaves the bar as it was; the next one tries again.
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    document.addEventListener('visibilitychange', read);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [pathname]);

  const timed = Boolean(deal?.dueBy);
  useEffect(() => {
    if (!timed) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [timed]);

  if (!deal || pathname === deal.href) return null;
  const left = deal.dueBy ? Date.parse(deal.dueBy) - (now + deal.offset) : null;
  const time = left !== null && left > 0 ? formatCountdown(left) : null;
  const label = `Your move: ${deal.move} on ${deal.ref}${time ? `, ${time} left` : ''}${deal.more > 0 ? `, and ${deal.more} more waiting on you` : ''}`;
  return (
    <Link href={deal.href} className={shell.liveDeal} aria-label={label} title={label}>
      <span className={shell.liveDealRef}>{shortRef(deal.ref)}</span>
      <span className={shell.liveDealWord}>{deal.move}</span>
      {time ? <Digits text={time} down className={`${shell.liveDealTime} ${shell.led}`} /> : null}
      {deal.more > 0 ? <span className={shell.liveDealMore}>+{deal.more}</span> : null}
    </Link>
  );
}
