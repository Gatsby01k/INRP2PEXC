import 'server-only';
import { requiredEnv } from './env.ts';
import type { HostConfig } from './surface.ts';

let hosts: HostConfig | undefined;

/**
 * The three host names, and nothing else. This is all the proxy needs: it runs at the edge, in whichever region is
 * nearest the person, so its module graph holds no database client, no pool and no Better Auth instance (whose start-up
 * alone reads the schema) — not even unused.
 */
export function hostConfig(): HostConfig {
  hosts ??= { deskHost: requiredEnv('DESK_HOST'), appHost: requiredEnv('APP_HOST'), publicHost: requiredEnv('PUBLIC_HOST') };
  return hosts;
}
