import { randomUUID } from 'node:crypto';
import type { ActorRef, Db, TxContext } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';

export const SYSTEM_ACTOR: ActorRef = { type: 'SYSTEM', id: null, surface: 'SYSTEM' };

/** Runs `fn` as a financial command through the real pipeline (idempotency + transaction). */
export async function inCommand<R>(db: Db, name: string, fn: (ctx: TxContext) => Promise<R>, key: string = randomUUID()): Promise<R> {
  const out = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => fn(ctx) }, { name, actor: SYSTEM_ACTOR, payload: { key }, idempotencyKey: key, financial: true });
  return out.result;
}
