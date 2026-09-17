import { NextResponse } from 'next/server';
import { requireOperatorSession } from '@inrp2p/identity';
import { getRuntime } from '../../../../server/runtime.ts';
import { authErrorResponse } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const rt = getRuntime();
  try {
    const actor = await requireOperatorSession(rt.operatorAuth, rt.appDb, request.headers);
    return NextResponse.json({ userId: actor.userId, roles: actor.roles }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return authErrorResponse(err);
  }
}
