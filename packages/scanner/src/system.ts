import { randomUUID } from 'node:crypto';
import type { Db, TxContext } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

/**
 * Runs one scanner step through the command pipeline. `key` is the natural identity of the step — for a
 * detection that is the chain event itself (`tron:{txHash}:{logIndex}`), so a rescan of the same block replays
 * the stored result instead of doing the work again (FI-50).
 */
export function systemStep<P extends Record<string, unknown>, R>(
  db: Db,
  name: string,
  payload: P,
  handle: (ctx: TxContext) => Promise<R>,
  opts: { key?: string; financial?: boolean } = {},
): Promise<{ result: R; replayed: boolean }> {
  return executeCommand(
    db,
    { authorize: async () => {}, handle },
    { name, actor: SYSTEM, payload, idempotencyKey: opts.key ?? randomUUID(), financial: opts.financial ?? false },
  ).then((o) => ({ result: o.result, replayed: o.replayed }));
}
