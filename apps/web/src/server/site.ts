import 'server-only';
import { headers } from 'next/headers';
import { getRuntime } from './runtime.ts';
import { optionalEnv } from './env.ts';

/**
 * The origin the public site is served from, used for canonical URLs, the sitemap and the structured data.
 *
 * It is taken from configuration, never from the request's own `Host` header. A canonical URL built from
 * whatever host a request arrived with is how a site ends up telling a search engine that its content also
 * lives at someone else's domain, and a sitemap built that way says the same thing to anyone who asks for it.
 */
export async function publicOrigin(): Promise<string> {
  const configured = optionalEnv('PUBLIC_BASE_URL');
  if (configured) return configured.replace(/\/+$/, '');
  const host = getRuntime().hosts.publicHost;
  // http only for a local harness, which binds a port and has no certificate; a named host is always https.
  const scheme = host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${host}`;
}

/** The client app's origin, where every call to action on the public site leads. */
export function appOrigin(): string {
  const configured = optionalEnv('CLIENT_BASE_URL');
  if (configured) return configured.replace(/\/+$/, '');
  const host = getRuntime().hosts.appHost;
  const scheme = host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${host}`;
}

/** The per-request CSP nonce the proxy generated, for the one inline script the site serves (its JSON-LD). */
export async function requestNonce(): Promise<string | undefined> {
  return (await headers()).get('x-inrp2p-nonce') ?? undefined;
}
