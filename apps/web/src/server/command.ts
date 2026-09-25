import 'server-only';
import { type DomainError, isDomainError } from '@inrp2p/kernel';
import type { ActorRef, TxContext } from '@inrp2p/db';
import { executeCommand, limitFinancialMutations } from '@inrp2p/commands';
import type { DomainCommand } from '@inrp2p/identity';
import { UnconfiguredChainVerifier } from '@inrp2p/adapters';
import type { SettlementDeps } from '@inrp2p/settlement';
import { type OperatorContext, operatorContext } from './operator.ts';
import { chainForWeb } from './chain.ts';

/**
 * What a server action hands back to the desk. A command either worked or it did not, and when it did not the
 * page needs to know *which* refusal it was: a step-up prompt, a permission it lacks, or a domain rule the
 * operator has to resolve. The message is the domain's own — never a rewritten guess.
 */
export type CommandResult<R> =
  | { readonly ok: true; readonly result: R }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly stepUp?: true; readonly details?: Record<string, unknown> };

/** Failures the desk can act on directly, phrased for an operator rather than for a log. */
const MESSAGES: Record<string, string> = {
  STEP_UP_REQUIRED: 'This action needs your authenticator code.',
  SECOND_APPROVER_REQUIRED: 'This action needs a second approver — someone other than the requester.',
  FORBIDDEN: 'Your role does not allow this action.',
  TRADE_ON_HOLD: 'The trade has an open blocking exception. Resolve it first.',
  OVER_ALLOCATION: 'That is more than this trade still owes.',
  CAPACITY_INSUFFICIENT: 'That account does not have enough capacity left today.',
  DUPLICATE_UTR: 'That bank reference is already recorded against another payment.',
  DUPLICATE_TX_HASH: 'That transaction is already recorded.',
  DUPLICATE_STATEMENT: 'That statement file has already been imported for this account.',
  TRANSFER_NOT_CONFIRMED: 'The chain has not made this transfer final yet.',
  UTR_REQUIRED: 'Record the payment reference before confirming.',
  QUOTE_EXPIRED: 'That quote has expired.',
  ROUTE_RATE_STALE: 'The route rate is too old to quote against — publish a fresh one.',
  ROUTE_RATE_MISSING: 'No route rate exists for that direction yet.',
  NEGATIVE_MARGIN_NOT_PERMITTED: 'That price is below the route rate; sending it needs the negative-margin permission and a reason.',
  DESTINATION_CHANGED: 'The client’s destination changed. Confirm the new one before continuing.',
  IDEMPOTENCY_KEY_REUSED: 'That looks like a different action reusing an earlier key. Reload and try again.',
  IDEMPOTENCY_IN_PROGRESS: 'The same action is already running. Give it a moment.',
  INVALID_TRANSITION: 'The trade has moved on since this screen was drawn. Reload it.',
  STALE_VERSION: 'Someone changed this while you were working. Reload it.',
  RATE_LIMITED: 'Too many actions in a short time. Wait a moment and try again.',
};

export interface RunOptions {
  /** Command name, which is also the idempotency scope (ARCHITECTURE §4). */
  readonly name: string;
  /**
   * Client-supplied idempotency key. The desk generates one per *intent* — per button press, not per retry —
   * so a double click, a lost response or an impatient reload cannot pay a client twice (FI-50).
   */
  readonly idempotencyKey: string;
  readonly financial?: boolean;
}

/**
 * Runs one domain command as the signed-in operator. The app layer contributes nothing to the decision: it
 * supplies the actor and the payload, and the command authorizes itself, locks its own rows and writes its own
 * journal inside one transaction.
 */
export async function runCommand<P, R>(
  build: (ctx: OperatorContext, deps: SettlementDeps) => DomainCommand<P, R>,
  payload: P,
  opts: RunOptions,
): Promise<CommandResult<R>> {
  let ctx: OperatorContext;
  try {
    ctx = await operatorContext();
  } catch (e) {
    return failure(e);
  }
  const ref: ActorRef = { type: 'USER', id: ctx.actor.userId, surface: 'OPERATOR', sessionId: ctx.actor.sessionId };
  try {
    // SECURITY §7: sixty financial mutations per user per minute. Applied here, at the edge a person acts
    // through, rather than in the pipeline — the pipeline is also how the worker and the scanner move money,
    // and throttling those would mean the outbox falling behind exactly when it has work to do. It runs in its
    // own transaction and counts refusals too, so a runaway client cannot spend the limit only on successes.
    if (opts.financial ?? true) await limitFinancialMutations(ctx.db, ref);
    const out = await executeCommand(ctx.db, build(ctx, { chain: chainForWeb() }), {
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

/** Same, for the few flows that need the database handle rather than a single command (refund + cancel, direct payout). */
export async function withOperator<R>(fn: (ctx: OperatorContext, deps: SettlementDeps) => Promise<R>): Promise<CommandResult<R>> {
  try {
    const ctx = await operatorContext();
    // These flows move money too — a refund and cancellation, a direct payout — so they carry the same ceiling
    // as the ones that go through `runCommand`. A limit with an exception in it is a limit with a way around it.
    await limitFinancialMutations(ctx.db, { type: 'USER', id: ctx.actor.userId });
    return { ok: true, result: await fn(ctx, { chain: chainForWeb() }) };
  } catch (e) {
    return failure(e);
  }
}

export function failure(e: unknown): CommandResult<never> {
  if (isDomainError(e)) {
    return {
      ok: false,
      code: e.code,
      message: MESSAGES[e.code] ?? e.message,
      ...(e.code === 'STEP_UP_REQUIRED' ? { stepUp: true as const } : {}),
      ...(Object.keys(e.details).length ? { details: e.details } : {}),
    };
  }
  // Anything unexpected is reported as itself, not dressed up as a domain rule — to the operator as a refusal,
  // and to the log with enough to find it. A database trigger refusing a write (a broken invariant) lands here, and
  // an error nobody can see is one nobody fixes.
  logUnexpected(e);
  return { ok: false, code: 'INTERNAL', message: 'Something went wrong. The action was not applied.' };
}

/**
 * One structured line per unexpected failure. Deliberately not the payload, and not a Postgres error's `detail`
 * (which repeats the offending values — a UTR, an account): the message, the SQLSTATE and constraint name, and the
 * stack are what an engineer needs and none of them carries client data (SECURITY §5).
 */
function logUnexpected(e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  const pg = e as { code?: unknown; constraint?: unknown; table?: unknown };
  console.error(JSON.stringify({
    level: 'error',
    event: 'command.unexpected_error',
    name: err.name,
    message: err.message,
    ...(typeof pg.code === 'string' ? { sqlstate: pg.code } : {}),
    ...(typeof pg.constraint === 'string' ? { constraint: pg.constraint } : {}),
    ...(typeof pg.table === 'string' ? { table: pg.table } : {}),
    stack: err.stack,
  }));
}

/** Used by actions that need a `TxContext` helper inline. */
export type { TxContext, DomainError };
export { UnconfiguredChainVerifier };
