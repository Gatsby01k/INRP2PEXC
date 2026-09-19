import 'server-only';
import { createDb, createPool, type Db } from '@inrp2p/db';
import { createClientAuth, createOperatorAuth, type ClientAuth, type OperatorAuth } from '@inrp2p/identity';
import { envFlag, optionalEnv, requiredEnv as required } from './env.ts';
import { clientOtpSender } from './client-otp.ts';
import type { HostConfig } from './surface.ts';

/**
 * Session cookies are `Secure` everywhere a real person signs in. The one exception is an end-to-end run against
 * a plain-HTTP localhost server, which cannot receive a Secure cookie at all. The switch is explicit, loud, and
 * refused outright in production, so it can never be the reason a desk session leaks over http.
 */
function useSecureCookies(): boolean {
  const insecure = envFlag('INRP2P_ALLOW_INSECURE_COOKIES');
  if (!insecure) return true;
  if ((optionalEnv('INRP2P_ENV') ?? '').toLowerCase() === 'production') {
    throw new Error('INRP2P_ALLOW_INSECURE_COOKIES must never be set in production');
  }
  return false;
}

interface Runtime {
  hosts: HostConfig;
  appDb: Db;
  operatorAuth: OperatorAuth;
  clientAuth: ClientAuth;
}

let runtime: Runtime | undefined;

/** Lazily constructed server runtime (pools and Better Auth instances). */
export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const databaseUrl = required('DATABASE_URL');
  const appDb = createDb(createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-web', int8: 'bigint' }));
  const authDb = createDb(createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-web-auth', int8: 'number' }));
  const hosts: HostConfig = { deskHost: required('DESK_HOST'), appHost: required('APP_HOST'), publicHost: required('PUBLIC_HOST') };
  const secure = useSecureCookies();
  const operatorAuth = createOperatorAuth({
    authDb, appDb, secret: required('OPERATOR_AUTH_SECRET'),
    baseURL: optionalEnv('OPERATOR_BASE_URL') ?? `https://${hosts.deskHost}`,
    useSecureCookies: secure,
  });
  const clientAuth = createClientAuth({
    authDb, appDb, secret: required('CLIENT_AUTH_SECRET'),
    baseURL: optionalEnv('CLIENT_BASE_URL') ?? `https://${hosts.appHost}`,
    useSecureCookies: secure,
    otpSender: clientOtpSender(),
  });
  runtime = { hosts, appDb, operatorAuth, clientAuth };
  return runtime;
}

/**
 * The origin a shareable quote link is written with (D-01). It is the public host, never the client host: a link
 * is opened by whoever holds it, and the page it opens must not sit on an origin that carries a client's cookie.
 */
export function quoteLinkBase(): string {
  return optionalEnv('CLIENT_LINK_BASE') ?? `https://${getRuntime().hosts.publicHost}`;
}

/** The origin the client product is served from, used where an email needs an absolute link back into it. */
export function clientBase(): string {
  return optionalEnv('CLIENT_BASE_URL') ?? `https://${getRuntime().hosts.appHost}`;
}
