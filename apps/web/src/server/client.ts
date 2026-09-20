import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import type { ActorRef, Db } from '@inrp2p/db';
import { executeCommand, limitFinancialMutations } from '@inrp2p/commands';
import { type ClientActor, type DomainCommand, hasFreshStepUp, requireClientSession } from '@inrp2p/identity';
import { type PortalAccess, portalAccess } from '@inrp2p/portal';
import type { QuoteDeps } from '@inrp2p/quotes';
import { getRuntime } from './runtime.ts';
import { quoteDepsForWeb } from './quotes.ts';
import { failure, type CommandResult } from './command.ts';

export interface ClientContext {
  readonly actor: ClientActor;
  readonly db: Db;
  /** Who this user is to the exchange: their client, their role, and whether they may decide on a quote (D-01). */
  readonly access: PortalAccess;
  /** True when this session verified TOTP inside the step-up window (SECURITY §2.2) — needed to add a destination. */
  readonly stepUpFresh: boolean;
}

/**
 * The client user behind the current request.
 *
 * The proxy has already refused anonymous and idle sessions on the client host; this reads the session again
 * inside the page or action for the same reason the desk does — a page that trusts routing alone is one mistake
 * away from showing someone else's trades. The client id comes from the membership, never from the URL.
 */
export async function clientContext(): Promise<ClientContext> {
  const rt = getRuntime();
  const actor = await requireClientSession(rt.clientAuth, rt.appDb, await headers());
  return {
    actor,
    db: rt.appDb,
    access: await portalAccess(rt.appDb, actor.userId),
    stepUpFresh: await hasFreshStepUp(rt.appDb, actor.sessionId),
  };
}

const SIGN_IN_CODES = ['UNAUTHENTICATED', 'SESSION_IDLE_TIMEOUT', 'SESSION_SURFACE_MISMATCH'];

/** Page-level variant: an expired or missing session sends the client to sign in rather than showing an error. */
export async function clientPage(): Promise<ClientContext> {
  try {
    return await clientContext();
  } catch (e) {
    if (isDomainError(e) && SIGN_IN_CODES.includes(e.code)) redirect('/sign-in');
    throw e;
  }
}

/**
 * Runs one domain command as the signed-in client user. As on the desk, the app layer contributes nothing to the
 * decision: the command authorizes itself against the membership, locks its own rows and writes its own journal.
 */
export async function runClientCommand<P, R>(
  build: (ctx: ClientContext, deps: QuoteDeps) => DomainCommand<P, R>,
  payload: P,
  opts: { name: string; idempotencyKey: string; financial?: boolean },
): Promise<CommandResult<R>> {
  let ctx: ClientContext;
  try {
    ctx = await clientContext();
  } catch (e) {
    return failure(e);
  }
  const ref: ActorRef = { type: 'USER', id: ctx.actor.userId, surface: 'CLIENT', sessionId: ctx.actor.sessionId };
  try {
    // The same ceiling as the desk's (SECURITY §7). A client acts through this runner and no other.
    if (opts.financial ?? true) await limitFinancialMutations(ctx.db, ref);
    const out = await executeCommand(ctx.db, build(ctx, quoteDepsForWeb()), {
      name: opts.name,
      actor: ref,
      payload,
      idempotencyKey: opts.idempotencyKey,
      financial: opts.financial ?? true,
    });
    return { ok: true, result: out.result };
  } catch (e) {
    return failure(e);
  }
}

/** Same, for reads and for the few flows that need the database handle rather than a single command. */
export async function withClient<R>(fn: (ctx: ClientContext) => Promise<R>): Promise<CommandResult<R>> {
  try {
    return { ok: true, result: await fn(await clientContext()) };
  } catch (e) {
    return failure(e);
  }
}
