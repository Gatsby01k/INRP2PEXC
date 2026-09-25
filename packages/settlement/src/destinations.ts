import type { Db } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import type { OutboxHandler } from '@inrp2p/outbox';
import { isUuid } from '@inrp2p/kernel';
import { lockTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';

/**
 * SECURITY S8: a destination is never edited, only archived and replaced, so a trade that captured it can tell
 * that it changed. This is where it is told. Every open trade whose frozen payout destination was just archived
 * gets a blocking `CLIENT_BANK_CHANGED` case, so the desk learns it now — not when a payout is refused with
 * `DESTINATION_CHANGED` — and no payout moves until a person has looked at it (RUNBOOKS "payout failed").
 *
 * One system command per archive event, keyed by the event, so a re-delivered event opens nothing twice.
 */
export async function openDestinationChangedCases(
  db: Db,
  input: { eventId: string; destination: 'BANK_ACCOUNT' | 'WALLET'; destinationId: string },
): Promise<number> {
  const out = await executeCommand(
    db,
    {
      authorize: async () => {},
      handle: async (ctx) => {
        const column = input.destination === 'BANK_ACCOUNT' ? 'e.bank_account_id' : 'e.crypto_wallet_id';
        const trades = await ctx.tx
          .selectFrom('trade as t')
          .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
          .select('t.id')
          .where(column, '=', input.destinationId)
          .where('t.lifecycle_state', 'not in', ['COMPLETED', 'CANCELLED'])
          .orderBy('t.id')
          .execute();
        let opened = 0;
        for (const t of trades) {
          await lockTrade(ctx.tx, t.id);
          const c = await openExceptionInTx(ctx, {
            type: 'CLIENT_BANK_CHANGED', subjectType: 'TRADE', subjectId: t.id, tradeId: t.id,
            details: { destination: input.destination, archived_id: input.destinationId },
          });
          if (c.opened) opened += 1;
        }
        return opened;
      },
    },
    {
      name: 'exception.destination_changed',
      actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' },
      payload: { destination: input.destination, destinationId: input.destinationId },
      idempotencyKey: `destination_archived:${input.eventId}`,
      financial: false,
    },
  );
  return out.result;
}

/** Outbox handler for `client.destination_archived`, beside the client's own notification of it. */
export function destinationArchivedHandler(db: Db): OutboxHandler {
  return {
    name: 'settlement_destination_changed',
    handles: (type) => type === 'client.destination_archived',
    run: async (event) => {
      const p = (event.payload ?? {}) as { destination?: unknown; id?: unknown };
      if ((p.destination !== 'BANK_ACCOUNT' && p.destination !== 'WALLET') || typeof p.id !== 'string' || !isUuid(p.id)) {
        throw new Error('client.destination_archived payload is missing destination/id');
      }
      await openDestinationChangedCases(db, { eventId: event.id, destination: p.destination, destinationId: p.id });
    },
  };
}
