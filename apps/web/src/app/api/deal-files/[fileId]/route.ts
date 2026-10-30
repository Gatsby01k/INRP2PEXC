import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { isDomainError } from '@inrp2p/kernel';
import { chatSideOf, dealFile } from '@inrp2p/settlement';
import { workspaceContext } from '../../../../server/client.ts';
import { can, operatorContext } from '../../../../server/operator.ts';
import { getRuntime } from '../../../../server/runtime.ts';
import { surfaceForHost } from '../../../../server/surface.ts';
import { authErrorResponse } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';

const NOT_FOUND = () => NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: { 'cache-control': 'no-store' } });

/**
 * A file attached in a P2P deal's chat (ADR 0023): a receipt, a screenshot. Never a public URL: each read authorizes
 * its reader first — on the client app, a person of the trade's client or of its trader; on the desk, INRP2P's people
 * who work cases — and anyone else is told the file does not exist. The bytes are served only if they still hash to
 * what was recorded when they were attached; a picture under a sandbox that runs nothing, a PDF as a download.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fileId)) return NOT_FOUND();
  const rt = getRuntime();
  const surface = surfaceForHost((await headers()).get('host'), rt.hosts);
  try {
    // Who is asking, before anything about the file is read.
    let clientUserId: string | null = null;
    if (surface === 'OPERATOR') {
      if (!can(await operatorContext(), 'exception:open')) return NOT_FOUND();
    } else if (surface === 'CLIENT') {
      clientUserId = (await workspaceContext()).actor.userId;
    } else return NOT_FOUND();
    const file = await dealFile(rt.appDb, { fileId });
    if (!file) return NOT_FOUND();
    if (clientUserId && !(await chatSideOf(rt.appDb, { tradeId: file.tradeId, userId: clientUserId }))) return NOT_FOUND();
    const pdf = file.type === 'application/pdf';
    return new NextResponse(new Uint8Array(file.body), {
      headers: {
        'content-type': file.type,
        'content-disposition': `${pdf ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'content-length': String(file.body.byteLength),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
        'x-inrp2p-sha256': file.sha256,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    if (isDomainError(err) && err.code === 'FILE_INTEGRITY') {
      return NextResponse.json({ error: err.code, message: 'This file does not match what was attached. It has not been served.' }, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
    return authErrorResponse(err);
  }
}
