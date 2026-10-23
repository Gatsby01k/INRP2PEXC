import { notFound, redirect } from 'next/navigation';
import { clientDestinations, hasAuthenticator } from '@inrp2p/portal';
import { businessNow, clientDeskState } from '@inrp2p/quotes';
import { deskByHandle, deskPage } from '@inrp2p/traders';
import { workspacePage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { DeskStatus } from '../../desk/_ui/DeskStatus.tsx';
import { DeskDealScreen } from './DeskDealScreen.tsx';
import { StoreIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

type Params = { direction?: string | string[]; fixed?: string | string[]; amount?: string | string[] };

/** What the desk's public page hands over: a direction, a fixed side and an amount — taken only when well formed. */
function startFrom(p: Params) {
  const direction = p.direction === 'SELL_USDT' || p.direction === 'BUY_USDT' ? p.direction : null;
  const fixed = p.fixed === 'QUOTE' ? ('QUOTE' as const) : ('BASE' as const);
  const amount = typeof p.amount === 'string' && /^\d{1,15}(\.\d{1,6})?$/.test(p.amount) && /[1-9]/.test(p.amount) ? p.amount : '';
  return { direction, fixed, amount } as const;
}

/**
 * A deal with an independent desk, in the client's workspace (ADR 0020): its live prices, the amount, where the money
 * lands, then a firm price held for a minute. A person who signed in from the desk's page with no account yet opens
 * one first and comes back here. A draft desk, or no desk, is "not found".
 */
export default async function ClientDeskPage({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<Params> }) {
  const { handle } = await params;
  const query = await searchParams;
  const ctx = await workspacePage();
  if (ctx.access.kind !== 'MEMBER') {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
    redirect(`/open-account?next=${encodeURIComponent(`/desks/${encodeURIComponent(handle)}${qs ? `?${qs}` : ''}`)}`);
  }
  const member = ctx.access.member;
  const [page, desk] = await Promise.all([deskPage(ctx.db, handle), deskByHandle(ctx.db, handle)]);
  if (!page || !desk) notFound();
  const [state, destinations, authenticator, now] = await Promise.all([
    clientDeskState(ctx.db, member.clientId, desk.id),
    clientDestinations(ctx.db, member.clientId),
    hasAuthenticator(ctx.db, ctx.actor.userId),
    businessNow(ctx.db),
  ]);
  const live = (s: string) => s === 'ACTIVE' || s === 'PENDING_REVIEW';
  const banks = destinations.banks.filter((b) => b.status === 'ACTIVE').map((b) => ({ id: b.id, name: `${b.bankName} •••• ${b.last4}`, meta: b.holderName }));
  const wallets = destinations.wallets
    .filter((w) => w.status === 'ACTIVE' && w.purpose !== 'SOURCE')
    .map((w) => ({ id: w.id, name: w.label, meta: `TRC20 · ${w.address.slice(0, 4)}…${w.address.slice(-4)}` }));

  return (
    <>
      <PageHead icon={<StoreIcon />} eyebrow="Desk" title={page.displayName} status={<DeskStatus status={page.status} />} lede="An independent desk on INRP2P. Its prices are its own; every deal settles through INRP2P’s escrow." />
      <DeskDealScreen
        desk={{ handle: page.handle, displayName: page.displayName, about: page.about, live: page.status === 'LIVE', prices: page.prices, completedDeals: page.record.completedDeals }}
        blocked={state.relation?.status === 'BLOCKED'}
        maxDeal={state.relation?.maxDeal ?? null}
        liveQuote={state.liveQuote}
        deals={state.deals}
        banks={banks}
        wallets={wallets}
        anyWallet={destinations.wallets.some((w) => live(w.status))}
        who={{ canAccept: member.canAcceptQuotes, isAdmin: member.role === 'CLIENT_ADMIN', hasAuthenticator: authenticator, email: ctx.access.email, clientName: member.clientName }}
        start={startFrom(query)}
        now={now.toISOString()}
      />
    </>
  );
}
