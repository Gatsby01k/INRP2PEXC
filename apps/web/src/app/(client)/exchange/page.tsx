import { exchangeView } from '@inrp2p/portal';
import { businessNow } from '@inrp2p/quotes';
import { clientPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { ExchangeScreen, type RequestDraft } from './ExchangeScreen.tsx';

export const dynamic = 'force-dynamic';

/**
 * What the home page's quote module hands over: "Request quote" there opens this screen with the direction and
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
 * countdown runs on is the database's, the one acceptance is judged by.
 */
export default async function ExchangePage({ searchParams }: { searchParams: Promise<{ direction?: string | string[]; amount?: string | string[] }> }) {
  const ctx = await clientPage();
  const [view, now, params] = await Promise.all([exchangeView(ctx.db, ctx.access.clientId), businessNow(ctx.db), searchParams]);
  const draft = draftFrom(params);

  return (
    <>
      <PageHead title="Exchange" lede="Request a firm quote to sell or buy USDT against INR. The desk prices every trade, and nothing is committed until you accept." />
      <ExchangeScreen view={view} canAccept={ctx.access.canAcceptQuotes} serverTime={now.toISOString()} {...(draft ? { draft } : {})} />
    </>
  );
}
