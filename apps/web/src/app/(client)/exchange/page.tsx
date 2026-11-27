import { webPushPublicKey } from '@inrp2p/adapters';
import { telegramLinkOf } from '@inrp2p/clients';
import { Money, Rate } from '@inrp2p/kernel';
import { clientHistory, exchangeView } from '@inrp2p/portal';
import { businessNow } from '@inrp2p/quotes';
import { clientPage, workspaceContext, protectionOfRequest } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { ExchangeScreen, type RequestDraft } from './ExchangeScreen.tsx';
import { MarketRate } from './MarketRate.tsx';
import { SwapIcon } from '../_workspace/icons.tsx';
import { StateRing } from '../_workspace/StateRing.tsx';
import { formatIstTime } from '@inrp2p/ui/format';
import { legAmount } from './amounts.ts';
import shell from '../shell.module.css';
import workspace from '../_workspace/workspace.module.css';

export const dynamic = 'force-dynamic';

/**
 * What the home page's quote module hands over: "Get a firm price" there opens this screen with the direction and
 * amount already chosen (`_landing/request.ts`). Only a well-formed USDT amount is taken; anything else is ignored
 * rather than guessed at, and the form simply starts empty.
 */
function draftFrom(params: { direction?: string | string[]; amount?: string | string[] }): RequestDraft | undefined {
  const direction = params.direction === 'buy' ? 'BUY_USDT' : params.direction === 'sell' ? 'SELL_USDT' : undefined;
  const amount = typeof params.amount === 'string' && /^\d{1,15}(\.\d{1,6})?$/.test(params.amount) && /[1-9]/.test(params.amount) ? params.amount : undefined;
  if (!direction && !amount) return undefined;
  return { direction: direction ?? 'SELL_USDT', ...(amount ? { amount } : {}) };
}

/**
 * Exchange (UX_FLOWS F1, F3) — the one screen a client spends time on.
 *
 * A client has at most one live conversation with the desk: a request being priced, or a quote counting down.
 * The server decides which of those it is; the screen only draws it. Everything shown comes from the domain's
 * own client projections, so there is no figure here the desk did not already commit to — and the clock the
 * countdown runs on is the database's, the one acceptance is judged by. Beside it, the client's latest trades.
 */
/**
 * ADR 0033 "Keep looking": a wait that ended offers the same terms again in one tap — the request it names, the client's
 * own, read back into the form (direction, amount, which side was fixed, its price). Anything else is ignored.
 */
async function againDraft(db: Parameters<typeof exchangeView>[0], clientId: string, ref: unknown): Promise<RequestDraft | undefined> {
  if (typeof ref !== 'string' || !/^[A-Z]{1,4}-[0-9A-Z-]{1,30}$/.test(ref)) return undefined;
  const r = await db.selectFrom('trade_request').select(['direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor', 'target_rate_micro'])
    .where('ref', '=', ref).where('client_id', '=', clientId).where('desk_id', 'is', null).executeTakeFirst();
  if (!r) return undefined;
  const amount = r.fixed_side === 'BASE' ? Money.ofMinor(r.requested_base_minor!, 'USDT').toDecimalString() : Money.ofMinor(r.requested_quote_minor!, 'INR').toDecimalString();
  const trim = (d: string) => (d.includes('.') ? d.replace(/0+$/, '').replace(/\.$/, '') : d);
  return {
    direction: r.direction, fixedSide: r.fixed_side, amount: trim(amount),
    ...(r.target_rate_micro !== null ? { targetRate: trim(Rate.ofMicro(r.target_rate_micro, 'CLIENT').toDecimalString()) } : {}),
  };
}

export default async function ExchangePage({ searchParams }: { searchParams: Promise<{ direction?: string | string[]; amount?: string | string[]; again?: string | string[] }> }) {
  const ctx = await clientPage();
  const [view, now, params, recent, protection, who] = await Promise.all([
    exchangeView(ctx.db, ctx.access.clientId),
    businessNow(ctx.db),
    searchParams,
    clientHistory(ctx.db, ctx.access.clientId, { limit: 6, withLanding: true }),
    protectionOfRequest(),
    workspaceContext().then((w) => w.access),
  ]);
  const draft = (await againDraft(ctx.db, ctx.access.clientId, params.again)) ?? draftFrom(params);
  // ADR 0032: a waiting client is told where it will hear of its price — its Telegram, and its email when it has a real one.
  const waiting = view.request?.status === 'OPEN' && view.request.waitingUntil !== null;
  const telegram = waiting ? await telegramLinkOf(ctx.db, ctx.actor.userId) : null;
  const alerts = waiting
    ? { telegram: { on: telegram?.status === 'ACTIVE', username: telegram?.username ?? null }, email: who.email, pushKey: webPushPublicKey(process.env) }
    : undefined;

  // While a request is with the desk, the heading says what it is — "Sell 10,000 USDT" — and where it stands; the page's
  // own name moves to the line above it. With nothing asked yet, the page is simply the Exchange.
  const request = view.request && (view.request.status === 'OPEN' || view.request.status === 'QUOTED') ? view.request : null;
  const quoteLive = view.quote?.status === 'SENT' && view.quote.expiresAt !== null && Date.parse(view.quote.expiresAt) > now.getTime();
  const sell = (view.quote?.direction ?? request?.direction) === 'SELL_USDT';
  const usdt = quoteLive ? legAmount(view.quote!.base.amount, 'USDT') : request?.currency === 'USDT' ? legAmount(request.amount, 'USDT') : null;
  const display = quoteLive || request ? (
    usdt ? (
      <>
        {sell ? 'Sell' : 'Buy'} {usdt} <span className={shell.unit}>USDT</span>
      </>
    ) : (
      <>
        {sell ? 'Sell USDT for' : 'Buy USDT for'} ₹{legAmount(request!.amount, 'INR')}
      </>
    )
  ) : null;
  const status = quoteLive ? (
    <span className={workspace.pill} data-tone="turn" data-size="lg">
      <StateRing state="turn" className={workspace.pillIcon} />
      Firm quote ready
    </span>
  ) : request?.peer?.meeting?.role === 'MAKER' ? (
    <span className={workspace.pill} data-tone="turn" data-size="lg">
      <StateRing state="turn" className={workspace.pillIcon} />
      Your move
    </span>
  ) : request ? (
    <span className={workspace.pill} data-tone="waiting" data-size="lg">
      <StateRing state="wait" className={workspace.pillIcon} />
      {request.peer?.meeting ? 'Waiting for the other client' : request.waitingUntil ? 'Finding a price' : request.gatheringUntil ? 'Gathering prices' : 'With the desk'}
    </span>
  ) : null;
  const sentAt = request ? `request sent ${formatIstTime(new Date(request.createdAt))}` : undefined;

  return (
    <>
      {display ? (
        <PageHead title="Exchange" eyebrow={sentAt} display={display} status={status} aside={<MarketRate />} />
      ) : (
        <PageHead icon={<SwapIcon />} title="Exchange" lede="Firm prices from the desk for USDT against INR. Nothing is committed until you accept." aside={<MarketRate />} />
      )}
      <ExchangeScreen
        view={view}
        canAccept={ctx.access.canAcceptQuotes}
        serverTime={now.toISOString()}
        recent={recent}
        who={{ isAdmin: ctx.access.role === 'CLIENT_ADMIN', protection, email: who.label, clientName: ctx.access.clientName }}
        alerts={alerts}
        {...(draft ? { draft } : {})}
      />
    </>
  );
}
