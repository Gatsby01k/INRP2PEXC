import { NextResponse } from 'next/server';
import { getRuntime } from '../../../../server/runtime.ts';
import { surfaceForHost } from '../../../../server/surface.ts';

async function handle(request: Request): Promise<Response> {
  const rt = getRuntime();
  const surface = surfaceForHost(request.headers.get('host'), rt.hosts);
  if (surface === 'OPERATOR') return rt.operatorAuth.handler(request);
  if (surface === 'CLIENT') return rt.clientAuth.handler(request);
  return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
}

export const GET = handle;
export const POST = handle;
