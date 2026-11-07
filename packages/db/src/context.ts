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
  /**
   * Work that takes a row every command wants, kept for the transaction's very end so it is held only until the commit
   * that follows: taken earlier, the row would be held across every lock the handler still takes, and two commands would
   * wait on each other. Each key runs once. Set by the command pipeline.
   */
  readonly atEnd?: Map<string, () => Promise<unknown>>;
}
