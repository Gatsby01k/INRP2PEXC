'use server';

import { revalidatePath } from 'next/cache';
import type { DirectionValue, FixedSideValue } from '@inrp2p/db';
import { claimDeskDealLink, requestDeskQuote } from '@inrp2p/quotes';
import type { CommandResult } from '../command.ts';
import { runClientCommand } from '../client.ts';

/**
 * A client's deal with an independent desk (docs/adr/0020-desks.md), as server actions: ask a desk's page for a firm price,
 * or take a deal link a desk sent. Both run as the signed-in client user; the client is the membership's, never the
 * browser's. Accepting the price is the ordinary in-app acceptance (`acceptQuoteAction`).
 */

/** The desk's own wording is right for its client — except where it would tell the client about the desk's internals. */
const DESK_WORDING: ReadonlySet<string> = new Set(['DESK_NOT_LIVE', 'DESK_CLIENT_BLOCKED', 'DESK_LINK_UNAVAILABLE', 'INVALID_AMOUNT', 'NOT_FOUND']);

/** What a client is told when the desk cannot fill this deal now: not why (its TRX, its capacity), only what to try. */
const CANNOT_FILL = 'This desk cannot take this deal right now. Try a smaller amount, or come back a little later.';

function phrased<R>(out: CommandResult<R>): CommandResult<R> {
  if (out.ok) return out;
  if (out.code === 'NETWORK_BUDGET_INSUFFICIENT' || out.code === 'CAPACITY_INSUFFICIENT' || out.code === 'TRADER_CAPACITY_INSUFFICIENT') return { ...out, message: CANNOT_FILL };
  if (out.code === 'EXCHANGE_NOT_ENABLED') return { ...out, message: 'This account cannot deal yet. Ask INRP2P to open the Exchange for it.' };
  return out;
}

export async function requestDeskPriceAction(
  input: { handle: string; direction: DirectionValue; fixedSide: FixedSideValue; amount: string; bankAccountId?: string | null; walletId?: string | null },
  key: string,
): Promise<CommandResult<{ quoteId: string }>> {
  const out = await runClientCommand((ctx, deps) => requestDeskQuote(ctx.actor, deps), input, { name: 'desk_deal.request_quote', idempotencyKey: key, keepMessages: DESK_WORDING });
  if (out.ok) revalidatePath(`/desks/${encodeURIComponent(input.handle)}`);
  return phrased(out.ok ? { ok: true, result: { quoteId: out.result.quoteId } } : out);
}

export async function takeDeskLinkAction(input: { token: string; bankAccountId?: string | null; walletId?: string | null }, key: string): Promise<CommandResult<{ quoteId: string }>> {
  const out = await runClientCommand((ctx, deps) => claimDeskDealLink(ctx.actor, deps), input, { name: 'desk_deal_link.claim', idempotencyKey: key, keepMessages: DESK_WORDING });
  if (out.ok) revalidatePath(`/d/${encodeURIComponent(input.token)}`);
  return phrased(out.ok ? { ok: true, result: { quoteId: out.result.quoteId } } : out);
}
