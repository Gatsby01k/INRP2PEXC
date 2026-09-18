'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import type { QueueAction, QueueGroup } from '@inrp2p/desk';
import { ActionQueue, EmptyState, type QueueGroupKey, type QueueItem } from '@inrp2p/ui';
import { formatInr, formatUsdt } from '@inrp2p/ui/format';

/** The desk's action hotkeys (UX_FLOWS §6). Each opens the row's panel on the section it names. */
const HOTKEYS: Record<string, string> = { q: 'quote', p: 'payout', u: 'utr', e: 'exception' };

const LABELS: Record<QueueAction, { label: string; shortcut?: string } | null> = {
  QUOTE: { label: 'Quote', shortcut: 'Q' },
  CREATE_PAYOUT: { label: 'Create payout', shortcut: 'P' },
  CONFIRM_INCOMING: { label: 'Confirm INR', shortcut: 'P' },
  RECORD_EVIDENCE: { label: 'Add UTR', shortcut: 'U' },
  CONFIRM_PAYOUT: { label: 'Confirm payout', shortcut: 'U' },
  RESOLVE_EXCEPTION: { label: 'Resolve', shortcut: 'E' },
  COPY_LINK: { label: 'Open quote' },
  NONE: null,
};

const SECTION_FOR: Record<QueueAction, string> = {
  QUOTE: 'quote',
  CREATE_PAYOUT: 'payout',
  CONFIRM_INCOMING: 'payout',
  RECORD_EVIDENCE: 'utr',
  CONFIRM_PAYOUT: 'utr',
  RESOLVE_EXCEPTION: 'exception',
  COPY_LINK: 'quote',
  NONE: 'payout',
};

export function DeskQueue({ groups, economics }: { groups: readonly QueueGroup[]; economics: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const ref = useRef<HTMLDivElement>(null);

  const open = useCallback(
    (rowId: string, section?: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('row', rowId);
      if (section) next.set('do', section);
      else next.delete('do');
      router.push(`?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  // Hotkeys act on the row that has focus, so the desk never needs the mouse (UX_FLOWS §6).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const section = HOTKEYS[e.key.toLowerCase()];
      if (!section || e.metaKey || e.ctrlKey || e.altKey) return;
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('tr[data-row]');
      const id = row?.dataset.rowId;
      if (!id) return;
      e.preventDefault();
      open(id, section);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [open]);

  const uiGroups = groups.map((g) => ({
    key: g.key as QueueGroupKey,
    items: g.rows.map((r): QueueItem => {
      const action = LABELS[r.action];
      const amount = r.baseUsdt
        ? `${r.direction === 'SELL_USDT' ? 'SELL' : 'BUY'} ${formatUsdt(Money.parse(r.baseUsdt, 'USDT'), { unit: true })}`
        : r.quoteInr
          ? `${r.direction === 'SELL_USDT' ? 'SELL' : 'BUY'} ${formatInr(Money.parse(r.quoteInr, 'INR'))}`
          : '—';
      return {
        id: r.id,
        client: r.clientName,
        amount,
        status: r.status,
        ...(economics && r.clientRate ? { asks: `₹${r.clientRate}` } : {}),
        ...(economics && r.routeRate ? { route: `₹${r.routeRate}` } : {}),
        ...(economics && r.margin ? { margin: formatInr(Money.parse(r.margin, 'INR'), { sign: 'always' }) } : {}),
        ...(action ? { action: { ...action, onAction: () => open(r.id, SECTION_FOR[r.action]) } } : {}),
      };
    }),
  }));

  return (
    <div ref={ref} data-testid="desk-queue">
      <ActionQueue
        groups={uiGroups}
        onOpen={(id) => open(id)}
        emptyState={<EmptyState title="Nothing waiting" body="Every trade on the desk is where it should be." />}
      />
    </div>
  );
}
