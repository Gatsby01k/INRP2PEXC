import { NextResponse } from 'next/server';
import { requireClientSession } from '@inrp2p/identity';
import { workspaceAccess } from '@inrp2p/portal';
import { getRuntime } from '../../../../server/runtime.ts';
import { authErrorResponse } from '../../../../server/http.ts';
import { liveDeal } from '../../../../server/live-deal.ts';

export const dynamic = 'force-dynamic';

/**
 * The deal waiting on the signed-in person, for the workspace's bar (`LiveDeal`). Read by the bar after the page has
 * drawn, so the page's own frame never waits for it. Someone with no client yet has none.
 */
export async function GET(request: Request) {
  const rt = getRuntime();
  try {
    const actor = await requireClientSession(rt.clientAuth, rt.appDb, request.headers);
    const access = await workspaceAccess(rt.appDb, actor.userId);
    const deal = access.kind === 'MEMBER' ? await liveDeal(rt.appDb, access.member, actor.userId) : null;
    return NextResponse.json({ deal }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return authErrorResponse(err);
  }
}
