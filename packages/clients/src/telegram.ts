import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, optionalText, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type ClientActor, type DomainCommand, actorLabel } from '@inrp2p/identity';

/**
 * A person's Telegram chat for alerts (docs/adr/0020-desks.md §2.14). The workspace hands out a one-time code — only its
 * hash is kept, valid fifteen minutes — and the person sends it to the bot from the chat they want alerts in
 * (`t.me/<bot>?start=<code>` does it in one tap). The bot's webhook links that chat to that person; `/stop` in the chat,
 * or disconnecting in the workspace, ends it. A chat never authenticates anyone and can do nothing but receive alerts.
 */

export const TELEGRAM_CODE_MINUTES = 15;

const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');

/** The signed-in person's own membership: alerts are a person's, about the client they act for. */
async function activeMember(ex: Executor, userId: string) {
  const row = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .innerJoin('client as c', 'c.id', 'cu.client_id')
    .select(['cu.id', 'cu.status', 'u.status as user_status', 'u.kind', 'c.display_name'])
    .where('cu.user_id', '=', requireUuid(userId, 'userId'))
    .executeTakeFirst();
  if (!row || row.status !== 'ACTIVE' || row.user_status !== 'ACTIVE' || row.kind !== 'CLIENT') throw new DomainError('FORBIDDEN', 'this account is not linked to a client');
  return row;
}

function personCommand<P, R>(actor: ClientActor, handle: (ctx: TxContext, payload: P, member: { id: string; clientName: string }) => Promise<R>): DomainCommand<P, R> {
  let member: { id: string; clientName: string } | undefined;
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const m = await activeMember(ctx.tx, actor.userId);
      member = { id: m.id, clientName: m.display_name };
    },
    handle: async (ctx, payload) => {
      if (!member) throw new Error('telegram command executed without authorization');
      return handle(ctx, payload, member);
    },
  };
}

/** The bot's own commands come from Telegram, through the webhook, as the system — never as a person. */
function botCommand<P, R>(handle: (ctx: TxContext, payload: P) => Promise<R>): DomainCommand<P, R> {
  return {
    authorize: async (ctx) => {
      if (ctx.actor.type !== 'SYSTEM') throw new DomainError('FORBIDDEN', 'only the Telegram webhook links a chat');
    },
    handle,
  };
}

async function revokeWhere(ctx: TxContext, filter: { clientUserId?: string; chatId?: bigint; status: 'PENDING' | 'ACTIVE' }, reason: string): Promise<string[]> {
  let q = ctx.tx
    .updateTable('telegram_link')
    .set({ status: 'REVOKED', revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: reason })
    .where('status', '=', filter.status);
  if (filter.clientUserId) q = q.where('client_user_id', '=', filter.clientUserId);
  if (filter.chatId !== undefined) q = q.where('chat_id', '=', filter.chatId);
  return (await q.returning('id').execute()).map((r) => r.id);
}

/**
 * `telegram_link.start` — the signed-in person asks to connect a chat: a fresh one-time code, handed out once
 * (`onCode`), replacing any code they had waiting. The chat they had stays linked until the new one is.
 */
export function startTelegramLink(actor: ClientActor, onCode: (code: string) => void) {
  return personCommand(actor, async (ctx, _p: Record<string, never>, member) => {
    await revokeWhere(ctx, { clientUserId: member.id, status: 'PENDING' }, 'replaced by a new code');
    const code = randomBytes(16).toString('base64url');
    const row = await ctx.tx
      .insertInto('telegram_link')
      .values({ client_user_id: member.id, code_hash: codeHash(code), code_expires_at: sql<Date>`inrp2p_now() + make_interval(mins => ${TELEGRAM_CODE_MINUTES})` })
      .returning(['id', 'code_expires_at'])
      .executeTakeFirstOrThrow();
    onCode(code);
    await appendAudit(ctx, { action: 'telegram_link.started', entityType: 'telegram_link', entityId: row.id, after: { expires_at: row.code_expires_at } });
    return { expiresAt: row.code_expires_at!.toISOString() };
  });
}

/**
 * `telegram_link.complete` — the bot received `/start <code>` from a chat: if the code is a person's and still waiting,
 * that chat becomes theirs (replacing a chat they linked before). An unknown, used or expired code links nothing and says
 * so — the bot tells the chat to ask the workspace for a new one.
 */
export function completeTelegramLink() {
  return botCommand(async (ctx, p: { code: string; chatId: string; username?: string | null }) => {
    const code = requireText(p.code, 'code', 64);
    if (!/^-?\d{1,20}$/.test(p.chatId)) throw new DomainError('INVALID_ARGUMENT', 'chatId must be an integer', { field: 'chatId' });
    const chatId = BigInt(p.chatId);
    const username = optionalText(p.username, 'username', 64);
    const link = await ctx.tx
      .selectFrom('telegram_link')
      .select(['id', 'client_user_id', 'status', sql<boolean>`code_expires_at > inrp2p_now()`.as('fresh')])
      .where('code_hash', '=', codeHash(code))
      .forUpdate()
      .executeTakeFirst();
    if (!link || link.status !== 'PENDING' || !link.fresh) return { linked: false as const };
    const member = await ctx.tx
      .selectFrom('client_user as cu')
      .innerJoin('client as c', 'c.id', 'cu.client_id')
      .select(['cu.status', 'c.display_name'])
      .where('cu.id', '=', link.client_user_id)
      .executeTakeFirstOrThrow();
    if (member.status !== 'ACTIVE') return { linked: false as const };
    const replaced = await revokeWhere(ctx, { clientUserId: link.client_user_id, status: 'ACTIVE' }, 'replaced by another chat');
    await ctx.tx
      .updateTable('telegram_link')
      .set({ status: 'ACTIVE', chat_id: chatId, username, linked_at: sql<Date>`inrp2p_now()` })
      .where('id', '=', link.id)
      .execute();
    await appendAudit(ctx, { action: 'telegram_link.linked', entityType: 'telegram_link', entityId: link.id, before: { status: 'PENDING' }, after: { status: 'ACTIVE', username, replaced } });
    return { linked: true as const, clientName: member.display_name };
  });
}

/** `telegram_link.stop` — the chat sent `/stop`: every person it was linked for stops getting alerts there. */
export function stopTelegramChat() {
  return botCommand(async (ctx, p: { chatId: string }) => {
    if (!/^-?\d{1,20}$/.test(p.chatId)) throw new DomainError('INVALID_ARGUMENT', 'chatId must be an integer', { field: 'chatId' });
    const ids = await revokeWhere(ctx, { chatId: BigInt(p.chatId), status: 'ACTIVE' }, 'stopped from the chat');
    for (const id of ids) await appendAudit(ctx, { action: 'telegram_link.revoked', entityType: 'telegram_link', entityId: id, before: { status: 'ACTIVE' }, after: { status: 'REVOKED', by: 'CHAT' } });
    return { stopped: ids.length };
  });
}

/** `telegram_link.revoke` — the person disconnects their chat (and drops a code still waiting) in the workspace. */
export function revokeTelegramLink(actor: ClientActor) {
  return personCommand(actor, async (ctx, _p: Record<string, never>, member) => {
    const ids = [
      ...(await revokeWhere(ctx, { clientUserId: member.id, status: 'ACTIVE' }, 'disconnected in the workspace')),
      ...(await revokeWhere(ctx, { clientUserId: member.id, status: 'PENDING' }, 'disconnected in the workspace')),
    ];
    for (const id of ids) await appendAudit(ctx, { action: 'telegram_link.revoked', entityType: 'telegram_link', entityId: id, after: { status: 'REVOKED', by: actorLabel(ctx) } });
    return { revoked: ids.length };
  });
}

export interface TelegramLinkView {
  readonly status: 'ACTIVE' | 'PENDING' | null;
  readonly username: string | null;
  readonly linkedAt: string | null;
  /** Until when a waiting code can be sent to the bot. */
  readonly codeExpiresAt: string | null;
}

/** The signed-in person's chat: linked (and as whom), a code waiting, or nothing. */
export async function telegramLinkOf(ex: Executor, userId: string): Promise<TelegramLinkView> {
  const member = await activeMember(ex, userId);
  const rows = await ex
    .selectFrom('telegram_link')
    .select(['status', 'username', 'linked_at', 'code_expires_at', sql<boolean>`coalesce(code_expires_at > inrp2p_now(), false)`.as('fresh')])
    .where('client_user_id', '=', member.id)
    .where('status', 'in', ['ACTIVE', 'PENDING'])
    .execute();
  const active = rows.find((r) => r.status === 'ACTIVE');
  if (active) return { status: 'ACTIVE', username: active.username, linkedAt: active.linked_at?.toISOString() ?? null, codeExpiresAt: null };
  const pending = rows.find((r) => r.status === 'PENDING' && r.fresh);
  return pending ? { status: 'PENDING', username: null, linkedAt: null, codeExpiresAt: pending.code_expires_at!.toISOString() } : { status: null, username: null, linkedAt: null, codeExpiresAt: null };
}
