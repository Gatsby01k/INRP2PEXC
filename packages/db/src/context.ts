import type { Tx } from './kysely.ts';

export type ActorType = 'USER' | 'SYSTEM' | 'CLIENT_LINK';
export type Surface = 'OPERATOR' | 'CLIENT' | 'PUBLIC' | 'SYSTEM';

export interface ActorRef {
  readonly type: ActorType;
  readonly id: string | null;
  readonly surface: Surface;
  readonly sessionId?: string | undefined;
}

/**
 * The transactional context every domain mutation receives from the command pipeline.
 * Financial primitives (ledger, outbox) require it, so they cannot run outside a command.
 */
export interface TxContext {
  readonly tx: Tx;
  readonly actor: ActorRef;
  readonly correlationId: string;
  /** Present for every financial mutation (FI-50). */
  readonly idempotencyKey: string | null;
  readonly commandName: string;
}
