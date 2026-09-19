'use server';

import { acceptQuoteViaLink, rejectQuoteViaLink, requestLinkOtp } from '@inrp2p/quotes';
import { type CommandResult, failure } from '../command.ts';
import { getRuntime } from '../runtime.ts';
import { quoteDepsForWeb } from '../quotes.ts';
import { callerIpHash } from '../link.ts';

/**
 * The three things the quote link page can do, and nothing else.
 *
 * Opening the link is a read. Asking for a code names a recipient the server already knows and sends the code
 * only to that person's verified address. Deciding needs the code. No path here accepts a quote because the
 * browser said so, and no session substitutes for the code (D-01, D-15).
 */
export async function requestLinkOtpAction(input: { token: string; clientUserId: string }): Promise<CommandResult<{ challengeId: string; destination: string; expiresAt: string }>> {
  try {
    const rt = getRuntime();
    return { ok: true, result: await requestLinkOtp(rt.appDb, quoteDepsForWeb(), { ...input, ipHash: await callerIpHash() }) };
  } catch (e) {
    return failure(e);
  }
}

export async function acceptViaLinkAction(
  input: { token: string; challengeId: string; code: string },
  key: string,
): Promise<CommandResult<{ tradeRef: string; quoteRef: string }>> {
  try {
    const rt = getRuntime();
    const out = await acceptQuoteViaLink(rt.appDb, quoteDepsForWeb(), { ...input, idempotencyKey: key });
    return { ok: true, result: { tradeRef: out.tradeRef, quoteRef: out.quoteRef } };
  } catch (e) {
    return failure(e);
  }
}

export async function rejectViaLinkAction(input: { token: string; challengeId: string; code: string }, key: string): Promise<CommandResult<{ status: 'REJECTED' }>> {
  try {
    const rt = getRuntime();
    return { ok: true, result: await rejectQuoteViaLink(rt.appDb, quoteDepsForWeb(), { ...input, idempotencyKey: key }) };
  } catch (e) {
    return failure(e);
  }
}
