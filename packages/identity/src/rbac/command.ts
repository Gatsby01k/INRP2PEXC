import type { TxContext } from '@inrp2p/db';
import { authorizeOperator, type AuthorizationDecision, type OperatorActor } from './authorize.ts';
import type { Permission } from './matrix.ts';

/** Structural command definition consumed by `@inrp2p/commands` executeCommand. */
export interface DomainCommand<P, R> {
  readonly authorize: (ctx: TxContext, payload: P) => Promise<void>;
  readonly handle: (ctx: TxContext, payload: P) => Promise<R>;
}

/**
 * An operator command guarded by one matrix permission (with step-up / second approver as the matrix says),
 * checked inside the command transaction before any lock or write (SECURITY §3).
 */
export function operatorCommand<P, R>(
  actor: OperatorActor,
  permission: Permission,
  handle: (ctx: TxContext, payload: P, decision: AuthorizationDecision) => Promise<R>,
): DomainCommand<P, R> {
  let decision: AuthorizationDecision | undefined;
  return {
    authorize: async (ctx) => {
      decision = await authorizeOperator(ctx.tx, actor, permission);
    },
    handle: async (ctx, payload) => {
      if (!decision) throw new Error(`operator command ${permission} executed without authorization`);
      return handle(ctx, payload, decision);
    },
  };
}

/** Actor id recorded in created_by / archived_by columns. */
export function actorLabel(ctx: TxContext): string {
  return ctx.actor.id ?? 'SYSTEM';
}
