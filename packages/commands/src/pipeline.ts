import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import { type ActorRef, type Db, type IsolationLevel, type TxContext, withTransaction } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';

export interface CommandRequest<P> {
  /** Stable command name, also the idempotency scope, e.g. `ledger.post_test_journal`. */
  readonly name: string;
  readonly actor: ActorRef;
  readonly payload: P;
  readonly idempotencyKey?: string | null;
  readonly correlationId?: string;
  /** Financial commands must carry an idempotency key (FI-50). */
  readonly financial: boolean;
  readonly isolation?: IsolationLevel;
}

export interface CommandDefinition<P, R> {
  /** Authorization inside the transaction (RBAC + MFA/step-up), before any lock or write. */
  readonly authorize: (ctx: TxContext, payload: P) => Promise<void>;
  readonly handle: (ctx: TxContext, payload: P) => Promise<R>;
}

export interface CommandOutcome<R> {
  readonly result: R;
  /** True when the stored result of an earlier identical request was returned. */
  readonly replayed: boolean;
  readonly correlationId: string;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const src = v as Record<string, unknown>;
      if (typeof (src as { toJSON?: unknown }).toJSON === 'function') return v;
      return Object.fromEntries(Object.keys(src).sort().map((k) => [k, src[k]]));
    }
    return v;
  });
}

export function requestHash(name: string, actor: ActorRef, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ name, actor: actor.id, payload })).digest('hex');
}

const bigintReviver = (_k: string, v: unknown): unknown =>
  v && typeof v === 'object' && '$bigint' in (v as Record<string, unknown>) ? BigInt((v as { $bigint: string }).$bigint) : v;

/**
 * The single mutation pipeline (ARCHITECTURE §4):
 * BEGIN → claim idempotency key → authorize → handler (locks, state, ledger, audit, outbox) →
 * store result → COMMIT. Any failure rolls back all of it, including the idempotency claim.
 */
export async function executeCommand<P, R>(db: Db, def: CommandDefinition<P, R>, req: CommandRequest<P>): Promise<CommandOutcome<R>> {
  const correlationId = req.correlationId ?? randomUUID();
  const key = req.idempotencyKey ?? null;
  if (req.financial && !key) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', `${req.name} is a financial mutation`);
  const hash = requestHash(req.name, req.actor, req.payload);

  return withTransaction(
    db,
    async (tx) => {
      if (key) {
        const claimed = await tx
          .insertInto('idempotency_key')
          .values({ scope: req.name, key, request_hash: hash, actor_id: req.actor.id, status: 'PENDING', response: null, completed_at: null })
          .onConflict((oc) => oc.columns(['scope', 'key']).doNothing())
          .returning('key')
          .executeTakeFirst();
        if (!claimed) {
          // A concurrent attempt either committed (row visible, COMPLETED) or is still running.
          const existing = await tx
            .selectFrom('idempotency_key')
            .select(['request_hash', 'status', 'response', 'actor_id'])
            .where('scope', '=', req.name)
            .where('key', '=', key)
            .forShare()
            .executeTakeFirstOrThrow();
          if (existing.request_hash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', `${req.name}:${key}`);
          if (existing.status !== 'COMPLETED') throw new DomainError('IDEMPOTENCY_IN_PROGRESS', `${req.name}:${key}`);
          const stored = JSON.parse(JSON.stringify(existing.response), bigintReviver) as { result: R };
          return { result: stored.result, replayed: true, correlationId };
        }
      }

      const ctx: TxContext = { tx, actor: req.actor, correlationId, idempotencyKey: key, commandName: req.name };
      await sql`set local statement_timeout = '30s'`.execute(tx);
      await def.authorize(ctx, req.payload);
      const result = await def.handle(ctx, req.payload);

      if (key) {
        await tx
          .updateTable('idempotency_key')
          .set({ status: 'COMPLETED', response: canonicalJson({ result }), completed_at: sql<Date>`statement_timestamp()` })
          .where('scope', '=', req.name)
          .where('key', '=', key)
          .execute();
      }
      return { result, replayed: false, correlationId };
    },
    req.isolation ? { isolation: req.isolation } : {},
  );
}

export { appendAudit };
