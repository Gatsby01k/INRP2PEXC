import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@inrp2p/kernel';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { appendAudit } from '@inrp2p/audit';
import { Accounts, globalImbalance, postJournal } from '@inrp2p/ledger';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type CommandDefinition, executeCommand } from '@inrp2p/commands';
import { DomainError } from '@inrp2p/kernel';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('pipeline');
});
afterAll(async () => t.close());

const actor = { type: 'USER' as const, id: randomUUID(), surface: 'OPERATOR' as const };

interface Payload { tag: string; amount: string }
let handlerRuns = 0;

const postTestJournal: CommandDefinition<Payload, { journalId: string; amount: bigint }> = {
  authorize: async () => {},
  handle: async (ctx, p) => {
    handlerRuns++;
    const amount = Money.parse(p.amount, 'INR');
    const j = await postJournal(ctx, {
      postingKey: `test:${p.tag}:post`, eventType: 'test.posted',
      entries: [
        { account: Accounts.suspenseUnallocated('INR'), direction: 'DR', amount },
        { account: Accounts.fees('INR'), direction: 'CR', amount },
      ],
    });
    await appendAudit(ctx, { action: 'test.posted', entityType: 'ledger_journal', entityId: j.id, after: { amount } });
    await enqueueOutbox(ctx, { type: 'test.posted', aggregateType: 'ledger_journal', aggregateId: j.id, payload: { journalId: j.id } });
    return { journalId: j.id, amount: amount.minor };
  },
};

const countJournals = async (tag: string) => (await t.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `test:${tag}:post`).execute()).length;

describe('command pipeline and idempotent replay (FI-50, FI-52)', () => {
  it('financial commands require an idempotency key', async () => {
    await expect(executeCommand(t.app, postTestJournal, { name: 'test.post', actor, payload: { tag: randomUUID(), amount: '1.00' }, financial: true }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('replaying the same key returns the stored result without re-running side effects', async () => {
    const key = randomUUID();
    const payload = { tag: randomUUID(), amount: '10200000.00' };
    handlerRuns = 0;
    const first = await executeCommand(t.app, postTestJournal, { name: 'test.post', actor, payload, idempotencyKey: key, financial: true });
    const second = await executeCommand(t.app, postTestJournal, { name: 'test.post', actor, payload, idempotencyKey: key, financial: true });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.result.amount).toBe(1_020_000_000n);
    expect(handlerRuns).toBe(1);
    expect(await countJournals(payload.tag)).toBe(1);
    const outbox = await t.app.selectFrom('outbox_event').select('id').where('aggregate_id', '=', first.result.journalId).execute();
    expect(outbox).toHaveLength(1);
  });

  it('reusing a key with a different payload is rejected', async () => {
    const key = randomUUID();
    await executeCommand(t.app, postTestJournal, { name: 'test.post', actor, payload: { tag: randomUUID(), amount: '1.00' }, idempotencyKey: key, financial: true });
    await expect(executeCommand(t.app, postTestJournal, { name: 'test.post', actor, payload: { tag: randomUUID(), amount: '2.00' }, idempotencyKey: key, financial: true }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('concurrent duplicates with one key post exactly once', async () => {
    const key = randomUUID();
    const payload = { tag: randomUUID(), amount: '5.00' };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => executeCommand(t.app, postTestJournal, { name: 'test.post', actor, payload, idempotencyKey: key, financial: true })),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(6);
    expect(fulfilled.filter((r) => !r.value.replayed)).toHaveLength(1);
    expect(await countJournals(payload.tag)).toBe(1);
  });

  it('a failure after writes rolls back journal, audit, outbox and the idempotency claim; the key can then be retried', async () => {
    const key = randomUUID();
    const payload = { tag: randomUUID(), amount: '7.00' };
    const failing: CommandDefinition<Payload, unknown> = {
      authorize: async () => {},
      handle: async (ctx, p) => {
        await postTestJournal.handle(ctx, p);
        throw new DomainError('INVALID_ARGUMENT', 'injected failure after all writes');
      },
    };
    await expect(executeCommand(t.app, failing, { name: 'test.post', actor, payload, idempotencyKey: key, financial: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await countJournals(payload.tag)).toBe(0);
    expect(await t.app.selectFrom('idempotency_key').select('key').where('key', '=', key).execute()).toHaveLength(0);
    const retry = await executeCommand(t.app, postTestJournal, { name: 'test.post', actor, payload, idempotencyKey: key, financial: true });
    expect(retry.replayed).toBe(false);
    expect(await countJournals(payload.tag)).toBe(1);
    expect(await globalImbalance(t.app)).toEqual([]);
  });

  it('authorization failure writes nothing', async () => {
    const key = randomUUID();
    const denied: CommandDefinition<Payload, unknown> = { ...postTestJournal, authorize: async () => { throw new DomainError('FORBIDDEN'); } };
    const payload = { tag: randomUUID(), amount: '1.00' };
    await expect(executeCommand(t.app, denied, { name: 'test.post', actor, payload, idempotencyKey: key, financial: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await countJournals(payload.tag)).toBe(0);
  });
});
