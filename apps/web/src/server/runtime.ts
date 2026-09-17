import 'server-only';
import { createDb, createPool, type Db } from '@inrp2p/db';
import { createClientAuth, createOperatorAuth, type ClientAuth, type OperatorAuth } from '@inrp2p/identity';
import type { HostConfig } from './surface.ts';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
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
  const operatorAuth = createOperatorAuth({ authDb, appDb, secret: required('OPERATOR_AUTH_SECRET'), baseURL: `https://${hosts.deskHost}` });
  const clientAuth = createClientAuth({
    authDb, appDb, secret: required('CLIENT_AUTH_SECRET'), baseURL: `https://${hosts.appHost}`,
    otpSender: {
      // Transactional email adapter arrives with notifications; refusing to run silently is safer than logging codes.
      send: async () => {
        throw new Error('email OTP delivery adapter is not configured');
      },
    },
  });
  runtime = { hosts, appDb, operatorAuth, clientAuth };
  return runtime;
}
