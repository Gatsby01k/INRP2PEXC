import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import type { ActorRef, Db } from '@inrp2p/db';
import { executeCommand, limitFinancialMutations } from '@inrp2p/commands';
import { type ClientActor, type DomainCommand, hasFreshStepUp, requireClientSession } from '@inrp2p/identity';
import { type PortalAccess, type WorkspaceAccess, portalAccess, workspaceAccess } from '@inrp2p/portal';
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

/**
 * Page-level variant, for the Exchange's own pages. An expired or missing session goes to sign in; someone signed in
 * without the Exchange — a trader applicant, or a client that provides capacity only — goes to Traders, which is
 * the whole of their workspace. The server decides from what the account is, never from where it came in.
 */
export async function clientPage(): Promise<ClientContext> {
  try {
    return await clientContext();
  } catch (e) {
    if (isDomainError(e) && SIGN_IN_CODES.includes(e.code)) redirect('/sign-in');
    if (isDomainError(e, 'EXCHANGE_NOT_ENABLED')) redirect('/traders');
    throw e;
  }
}

/**
 * Anyone who may hold a client session: a member of a client (with or without the Exchange) or a person who
 * verified their email to apply as a trader and has no client yet. The workspace frame and the Traders pages use
 * this; everything that touches the Exchange uses `clientContext`.
 */
export interface WorkspaceContext {
  readonly actor: ClientActor;
  readonly db: Db;
  readonly access: WorkspaceAccess;
}

export async function workspaceContext(): Promise<WorkspaceContext> {
  const rt = getRuntime();
  const actor = await requireClientSession(rt.clientAuth, rt.appDb, await headers());
  return { actor, db: rt.appDb, access: await workspaceAccess(rt.appDb, actor.userId) };
}

export async function workspacePage(): Promise<WorkspaceContext> {
  try {
    return await workspaceContext();
  } catch (e) {
    if (isDomainError(e) && SIGN_IN_CODES.includes(e.code)) redirect('/sign-in');
    throw e;
  }
}

/** A member of a client, with or without the Exchange — notifications and a working trader's pages. */
export async function memberPage(): Promise<WorkspaceContext & { readonly member: PortalAccess }> {
  const ctx = await workspacePage();
  if (ctx.access.kind !== 'MEMBER') redirect('/traders');
  return { ...ctx, member: ctx.access.member };
}

/**
 * Runs one domain command as the signed-in client user. As on the desk, the app layer contributes nothing to the
 * decision: the command authorizes itself against the membership, locks its own rows and writes its own journal.
 */
export async function runClientCommand<P, R>(
  build: (ctx: ClientContext, deps: QuoteDeps) => DomainCommand<P, R>,
  payload: P,
  opts: { name: string; idempotencyKey: string; financial?: boolean; keepMessages?: ReadonlySet<string> },
): Promise<CommandResult<R>> {
  let ctx: ClientContext;
  try {
    ctx = await clientContext();
  } catch (e) {
    return failure(e, opts.keepMessages);
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
    return failure(e, opts.keepMessages);
  }
}

/**
 * Runs a Traders command as the signed-in person, member of a client or not: trader commands authorize against the
 * trader membership themselves (and `trader.apply` accepts a person with no client yet), so the Exchange's gate
 * does not apply here.
 */
export async function runWorkspaceCommand<P, R>(
  build: (ctx: WorkspaceContext, deps: QuoteDeps) => DomainCommand<P, R>,
  payload: P,
  opts: { name: string; idempotencyKey: string; financial?: boolean; keepMessages?: ReadonlySet<string> },
): Promise<CommandResult<R>> {
  let ctx: WorkspaceContext;
  try {
    ctx = await workspaceContext();
  } catch (e) {
    return failure(e, opts.keepMessages);
  }
  const ref: ActorRef = { type: 'USER', id: ctx.actor.userId, surface: 'CLIENT', sessionId: ctx.actor.sessionId };
  try {
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
    return failure(e, opts.keepMessages);
  }
}

/** A read as a member of a client, Exchange or not (notifications). */
export async function withMember<R>(fn: (ctx: WorkspaceContext, member: PortalAccess) => Promise<R>): Promise<CommandResult<R>> {
  try {
    const ctx = await workspaceContext();
    if (ctx.access.kind !== 'MEMBER') return { ok: false, code: 'FORBIDDEN', message: 'This account is not linked to a client yet.' };
    return { ok: true, result: await fn(ctx, ctx.access.member) };
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
