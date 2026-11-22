import { randomUUID } from 'node:crypto';
import type { ActorRef, Db, TxContext } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

/**
 * Runs one scanner step through the command pipeline. `key` is the natural identity of the step — for a
 * detection that is the chain event itself (`tron:{txHash}:{logIndex}`), so a rescan of the same block replays
 * the stored result instead of doing the work again (FI-50).
 *
 * A financial step without a natural identity still claims a fresh key, as FI-50 requires of every financial
 * mutation. A non-financial one without a natural identity (a balance reading, the cursor's progress) claims none: a
 * key nobody can ever present again replays nothing, and claiming it cost two writes to `idempotency_key` every
 * reading, every minute — the bulk of that table. The step itself, its transaction and its audit event are unchanged.
 */
export function systemStep<P extends Record<string, unknown>, R>(
  db: Db,
  name: string,
  payload: P,
  handle: (ctx: TxContext) => Promise<R>,
  opts: { key?: string; financial?: boolean; actor?: ActorRef } = {},
): Promise<{ result: R; replayed: boolean }> {
  return executeCommand(
    db,
    { authorize: async () => {}, handle },
    { name, actor: opts.actor ?? SYSTEM, payload, idempotencyKey: opts.key ?? (opts.financial ? randomUUID() : null), financial: opts.financial ?? false },
  ).then((o) => ({ result: o.result, replayed: o.replayed }));
}
