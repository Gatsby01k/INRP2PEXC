import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { executeCommand } from '@inrp2p/commands';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';

/**
 * A question the robot passes to a person (ADR 0034 §2.8): it could not answer it by its rules, the model was off or
 * judged it a person's, or the person asked for one. One open case per person — a second question joins the first, so
 * the desk reads a conversation, not a pile — with what the robot knew when it passed it on. The desk's answer reaches
 * the asker where they asked; a case is closed without one only with a reason.
 */
const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

export interface OpenCaseInput {
  readonly userId: string | null;
  readonly clientId: string | null;
  readonly channel: 'APP' | 'TELEGRAM';
  readonly telegramChatId: string | null;
  readonly question: string;
  readonly context: Record<string, unknown>;
}

export async function openCase(db: Db, input: OpenCaseInput): Promise<{ readonly id: string; readonly ref: string; readonly joined: boolean }> {
  const question = input.question.trim().slice(0, 1000);
  if (!question) throw new DomainError('INVALID_ARGUMENT', 'empty question');
  const out = await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      if (input.userId) {
        const open = await ctx.tx.selectFrom('robot_case').select(['id', 'ref', 'question']).where('user_id', '=', input.userId).where('status', '=', 'OPEN').forUpdate().executeTakeFirst();
        if (open) {
          const joined = `${open.question}\n— ${question}`;
          await ctx.tx.updateTable('robot_case')
            .set({ question: joined.length > 2000 ? joined.slice(joined.length - 2000) : joined, context: JSON.stringify(input.context), channel: input.channel, telegram_chat_id: input.telegramChatId === null ? null : BigInt(input.telegramChatId), updated_at: sql<Date>`inrp2p_now()` })
            .where('id', '=', open.id).execute();
          await appendAudit(ctx, { action: 'robot.case_joined', entityType: 'robot_case', entityId: open.id, after: { ref: open.ref, channel: input.channel } });
          return { id: open.id, ref: open.ref, joined: true };
        }
      }
      const row = await ctx.tx.insertInto('robot_case')
        .values({ user_id: input.userId, client_id: input.clientId, channel: input.channel, telegram_chat_id: input.telegramChatId === null ? null : BigInt(input.telegramChatId), question, context: JSON.stringify(input.context) })
        .returning(['id', 'ref']).executeTakeFirstOrThrow();
      await appendAudit(ctx, { action: 'robot.case_opened', entityType: 'robot_case', entityId: row.id, after: { ref: row.ref, channel: input.channel, user_id: input.userId } });
      return { id: row.id, ref: row.ref, joined: false };
    },
  }, { name: 'robot.case_open', actor: SYSTEM, payload: { userId: input.userId, channel: input.channel }, idempotencyKey: null, financial: false });
  return out.result;
}

/** `robot.answer_case` (`robot:answer`): a person at INRP2P answers; the answer reaches the asker, and the case closes. */
export function answerRobotCase(actor: OperatorActor) {
  return operatorCommand(actor, 'robot:answer', async (ctx, p: { caseRef: string; answer: string }) => {
    const answer = typeof p.answer === 'string' ? p.answer.trim() : '';
    if (answer.length < 2 || answer.length > 2000) throw new DomainError('INVALID_ARGUMENT', 'an answer is 2 to 2,000 characters', { field: 'answer' });
    const c = await ctx.tx.selectFrom('robot_case').select(['id', 'ref', 'status']).where('ref', '=', String(p.caseRef)).forUpdate().executeTakeFirst();
    if (!c) throw new DomainError('NOT_FOUND', 'no such question');
    if (c.status !== 'OPEN') throw new DomainError('INVALID_TRANSITION', 'this question is already answered or closed');
    await ctx.tx.updateTable('robot_case')
      .set({ status: 'ANSWERED', answer, answered_by: actor.userId, answered_at: sql<Date>`inrp2p_now()`, closed_at: sql<Date>`inrp2p_now()`, updated_at: sql<Date>`inrp2p_now()` })
      .where('id', '=', c.id).execute();
    await appendAudit(ctx, { action: 'robot.case_answered', entityType: 'robot_case', entityId: c.id, before: { status: 'OPEN' }, after: { ref: c.ref, status: 'ANSWERED' } });
    await enqueueOutbox(ctx, { type: 'robot.case_answered', aggregateType: 'robot_case', aggregateId: c.id, payload: { caseId: c.id } });
    return { ref: c.ref };
  });
}

/** `robot.close_case` (`robot:answer`): closed without an answer to send — dealt with elsewhere, or not a question. */
export function closeRobotCase(actor: OperatorActor) {
  return operatorCommand(actor, 'robot:answer', async (ctx, p: { caseRef: string; reason: string }) => {
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    if (reason.length < 3) throw new DomainError('INVALID_ARGUMENT', 'say why', { field: 'reason' });
    const c = await ctx.tx.selectFrom('robot_case').select(['id', 'ref', 'status']).where('ref', '=', String(p.caseRef)).forUpdate().executeTakeFirst();
    if (!c) throw new DomainError('NOT_FOUND', 'no such question');
    if (c.status !== 'OPEN') throw new DomainError('INVALID_TRANSITION', 'this question is already answered or closed');
    await ctx.tx.updateTable('robot_case').set({ status: 'CLOSED', closed_at: sql<Date>`inrp2p_now()`, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', c.id).execute();
    await appendAudit(ctx, { action: 'robot.case_closed', entityType: 'robot_case', entityId: c.id, before: { status: 'OPEN' }, after: { ref: c.ref, status: 'CLOSED', reason: reason.slice(0, 500) } });
    return { ref: c.ref };
  });
}
