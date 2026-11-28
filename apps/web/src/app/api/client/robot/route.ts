import { NextResponse } from 'next/server';
import { requireClientSession } from '@inrp2p/identity';
import { workspaceAccess } from '@inrp2p/portal';
import { getRuntime } from '../../../../server/runtime.ts';
import { authErrorResponse } from '../../../../server/http.ts';
import { robotBriefFor } from '../../../../server/robot.ts';

export const dynamic = 'force-dynamic';

/**
 * What the robot in the masthead says to the signed-in person (ADR 0034): read after the page has drawn, so no page
 * waits for it, and again when the person comes back to the tab or moves to another page.
 */
export async function GET(request: Request) {
  const rt = getRuntime();
  try {
    const actor = await requireClientSession(rt.clientAuth, rt.appDb, request.headers);
    const brief = await robotBriefFor(rt.appDb, await workspaceAccess(rt.appDb, actor.userId));
    return NextResponse.json({ brief }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return authErrorResponse(err);
  }
}
