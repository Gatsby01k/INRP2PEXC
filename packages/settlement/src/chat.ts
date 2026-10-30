import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, optionalText, requireUuid } from '@inrp2p/kernel';
import type { DealMessageAuthor, DealMessageKind, Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { lockTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';
import { dealNow } from './p2p-timing.ts';

/**
 * A P2P deal's chat (ADR 0023): the buyer, the seller and — when either calls them — INRP2P's people, in one private
 * thread on the deal's own page. Text, and the receipts and screenshots a side attaches; append-only, so what was said
 * stays said.
 *
 * The chat informs; it never decides. Nothing written or attached here moves a rupee or a USDT: the escrow releases only
 * on the payee's own confirmation, checked against who its bank says sent the money (ADR 0018/0019), and a screenshot is
 * never that. The deal's state — the escrow, the payment, its deadline — is shown beside the chat, never in it.
 */

/** Who is speaking, as a side of the deal sees it: itself, the other side by its role, or INRP2P. */
export type ChatParty = 'YOU' | 'BUYER' | 'SELLER' | 'INRP2P';

export interface DealChatFile {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface DealChatMessage {
  readonly id: string;
  readonly from: ChatParty;
  readonly kind: DealMessageKind;
  readonly body: string | null;
  readonly file: DealChatFile | null;
  /** A receipt names the payment it is for. */
  readonly paymentRef: string | null;
  readonly at: string;
}

export interface DealChatView {
  /** The viewer's own role in the deal. */
  readonly you: 'BUYER' | 'SELLER';
  readonly messages: readonly DealChatMessage[];
  /** Whether the viewer can still write: while the deal is live, for a week after it closes, and while INRP2P is in. */
  readonly canPost: boolean;
  /** INRP2P called into the chat and not yet done (`CALLED`), or there and answering (`JOINED`). */
  readonly support: 'NONE' | 'CALLED' | 'JOINED';
}

/** The files a chat takes: what a bank app's screen or its statement is saved as. Never anything a browser would run. */
export const DEAL_FILE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const);
export type DealFileType = (typeof DEAL_FILE_TYPES)[number];
export const DEAL_FILE_MAX_BYTES = 3 * 1024 * 1024;
/** Limits that keep a chat a chat: files per side of a deal, and messages a person writes a minute. */
export const DEAL_CHAT_LIMITS = Object.freeze({ filesPerSide: 15, messagesPerMinute: 20, bodyChars: 2000, openDaysAfterClose: 7 });

export interface DealAttachment {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

/** What a command's payload says of a file — its identity, never its bytes (which travel beside it). */
export interface DealAttachmentRef {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly sha256: string;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function attachmentRef(file: DealAttachment): DealAttachmentRef {
  return { name: file.name, type: file.type, size: file.bytes.byteLength, sha256: sha256Hex(file.bytes) };
}

/** The type the bytes themselves are, by their first bytes — whatever the browser or the file's name claimed. */
export function sniffDealFile(bytes: Uint8Array): DealFileType | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b(i) === v)) return 'image/png';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46 && b(4) === 0x2d) return 'application/pdf';
  return null;
}

/** A file's name as it is shown: its own base name, printable, short — never a path. */
export function cleanFileName(raw: string, type: DealFileType): string {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[type];
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} ._()-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${base || 'attachment'}.${ext}`;
}

/** Checks an attachment against what its command said of it, and against what the chat takes. */
export function checkAttachment(file: DealAttachment, ref: DealAttachmentRef): { readonly type: DealFileType; readonly name: string; readonly sha256: string } {
  if (file.bytes.byteLength === 0) throw new DomainError('INVALID_ARGUMENT', 'the file is empty', { field: 'file' });
  if (file.bytes.byteLength > DEAL_FILE_MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 'a file can be up to 3 MB — a screenshot or a PDF of the receipt', { field: 'file' });
  const type = sniffDealFile(file.bytes);
  if (!type) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 'attach a JPEG, PNG or WebP picture, or a PDF', { field: 'file' });
  const sha256 = sha256Hex(file.bytes);
  if (ref.sha256 !== sha256 || ref.size !== file.bytes.byteLength) throw new DomainError('INVALID_ARGUMENT', 'the file changed on its way — attach it again', { field: 'file' });
  return { type, name: cleanFileName(ref.name, type), sha256 };
}

interface ChatTrade {
  readonly id: string;
  readonly ref: string;
  readonly clientId: string;
  readonly buy: boolean;
  readonly lifecycle: string;
  readonly closedAt: Date | null;
}

async function chatTrade(ex: Executor, tradeId: string): Promise<ChatTrade> {
  const t = await ex
    .selectFrom('trade as t')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .select(['t.id', 't.ref', 't.client_id', 't.direction', 't.lifecycle_state', 't.completed_at', 't.cancelled_at', 'e.route_execution_mode'])
    .where('t.id', '=', requireUuid(tradeId, 'tradeId'))
    .executeTakeFirst();
  if (!t) throw new DomainError('NOT_FOUND', 'deal not found');
  if (t.route_execution_mode !== 'P2P') throw new DomainError('INVALID_ARGUMENT', 'only a P2P deal has a chat between its two sides');
  return { id: t.id, ref: t.ref, clientId: t.client_id, buy: t.direction === 'BUY_USDT', lifecycle: t.lifecycle_state, closedAt: t.completed_at ?? t.cancelled_at };
}

async function openSupportCase(ex: Executor, tradeId: string) {
  return ex.selectFrom('exception_case').select(['id', 'ref', 'opened_at as created_at']).where('type', '=', 'P2P_SUPPORT').where('subject_type', '=', 'TRADE').where('subject_id', '=', tradeId).where('status', 'in', ['OPEN', 'IN_PROGRESS']).executeTakeFirst();
}

async function chatOpen(ex: Executor, t: ChatTrade, now: Date): Promise<boolean> {
  if (!t.closedAt) return true;
  if (now.getTime() - t.closedAt.getTime() <= DEAL_CHAT_LIMITS.openDaysAfterClose * 86_400_000) return true;
  return (await openSupportCase(ex, t.id)) !== undefined;
}


async function messagesOf(ex: Executor, tradeId: string) {
  return ex
    .selectFrom('deal_message as m')
    .leftJoin('deal_file as f', 'f.id', 'm.file_id')
    .leftJoin('settlement_leg as l', 'l.id', 'm.settlement_leg_id')
    .innerJoin('auth_user as u', 'u.id', 'm.author_user_id')
    .select(['m.id', 'm.author', 'm.author_user_id', 'm.kind', 'm.body', 'm.created_at', 'f.id as file_id', 'f.name as file_name', 'f.content_type', 'f.byte_size', 'l.ref as leg_ref', 'u.name as user_name', 'u.email as user_email'])
    .where('m.trade_id', '=', tradeId)
    .orderBy('m.created_at')
    .orderBy('m.id')
    .execute();
}

const fileOf = (m: { file_id: string | null; file_name: string | null; content_type: string | null; byte_size: number | null }): DealChatFile | null =>
  m.file_id ? { id: m.file_id, name: m.file_name!, type: m.content_type!, size: m.byte_size! } : null;

/** The chat as one side of the deal sees it: the other side by its role only — never a name, an email or a person. */
export async function dealChatView(ex: Executor, input: { readonly tradeId: string; readonly viewer: 'CLIENT' | 'TRADER' }): Promise<DealChatView> {
  const t = await chatTrade(ex, input.tradeId);
  // The client buys on a BUY; the trader sells on it.
  const you: 'BUYER' | 'SELLER' = (input.viewer === 'CLIENT') === t.buy ? 'BUYER' : 'SELLER';
  const other: 'BUYER' | 'SELLER' = you === 'BUYER' ? 'SELLER' : 'BUYER';
  const rows = await messagesOf(ex, t.id);
  const support = await openSupportCase(ex, t.id);
  const joined = support ? rows.some((m) => m.author === 'INRP2P' && m.created_at >= support.created_at) : false;
  return {
    you,
    messages: rows.map((m) => ({
      id: m.id, from: m.author === 'INRP2P' ? 'INRP2P' : m.author === input.viewer ? 'YOU' : other, kind: m.kind, body: m.body, file: fileOf(m), paymentRef: m.leg_ref, at: m.created_at.toISOString(),
    })),
    canPost: await chatOpen(ex, t, await dealNow(ex)),
    support: !support ? 'NONE' : joined ? 'JOINED' : 'CALLED',
  };
}

export interface DeskDealChatMessage {
  readonly id: string;
  readonly author: DealMessageAuthor;
  /** The person who wrote it, as INRP2P knows them. */
  readonly person: string;
  readonly kind: DealMessageKind;
  readonly body: string | null;
  readonly file: DealChatFile | null;
  readonly paymentRef: string | null;
  readonly at: string;
}

export interface DeskDealChat {
  /** The client's role in the deal: the trader holds the other. */
  readonly clientIs: 'BUYER' | 'SELLER';
  readonly messages: readonly DeskDealChatMessage[];
  readonly support: { readonly caseId: string; readonly ref: string; readonly calledAt: string; readonly joined: boolean } | null;
}

/** The chat as INRP2P's people see it: every message with who wrote it, and whether a side is waiting for them. */
export async function deskDealChat(ex: Executor, tradeId: string): Promise<DeskDealChat | null> {
  const e = await ex.selectFrom('trade_economics').select('route_execution_mode').where('trade_id', '=', requireUuid(tradeId, 'tradeId')).executeTakeFirst();
  if (e?.route_execution_mode !== 'P2P') return null;
  const t = await chatTrade(ex, tradeId);
  const rows = await messagesOf(ex, t.id);
  const support = await openSupportCase(ex, t.id);
  return {
    clientIs: t.buy ? 'BUYER' : 'SELLER',
    messages: rows.map((m) => ({
      id: m.id, author: m.author, person: m.user_name?.trim() || m.user_email, kind: m.kind, body: m.body, file: fileOf(m), paymentRef: m.leg_ref, at: m.created_at.toISOString(),
    })),
    support: support ? { caseId: support.id, ref: support.ref, calledAt: support.created_at.toISOString(), joined: rows.some((m) => m.author === 'INRP2P' && m.created_at >= support.created_at) } : null,
  };
}

/** The bytes of a deal's file, for a reader the caller has already found to be of this deal. */
export async function dealFile(ex: Executor, input: { readonly fileId: string }): Promise<{ readonly tradeId: string; readonly name: string; readonly type: DealFileType; readonly sha256: string; readonly body: Buffer } | null> {
  const f = await ex.selectFrom('deal_file').select(['trade_id', 'name', 'content_type', 'sha256', 'body']).where('id', '=', requireUuid(input.fileId, 'fileId')).executeTakeFirst();
  if (!f) return null;
  // Read back as it was checked when written: bytes that no longer hash to what was recorded are not served.
  if (sha256Hex(f.body) !== f.sha256) throw new DomainError('FILE_INTEGRITY', 'this file does not match what was attached');
  return { tradeId: f.trade_id, name: f.name, type: f.content_type, sha256: f.sha256, body: f.body };
}

export interface PostInput {
  readonly tradeId: string;
  readonly author: DealMessageAuthor;
  readonly userId: string;
  readonly body?: string | null;
  /** The file and what the command's payload said of it. */
  readonly file?: { readonly attachment: DealAttachment; readonly ref: DealAttachmentRef } | null;
  /** A receipt: the rupee payment of this deal it is for. */
  readonly legId?: string | null;
}

/**
 * Writes one message of a deal's chat. The caller has authorized the author as a side of the deal (or INRP2P) and holds
 * the trade lock. The other side — and INRP2P, if it was called — hears of it; the words stay in the chat.
 */
export async function postDealMessageInTx(ctx: TxContext, input: PostInput, kind: DealMessageKind = input.legId ? 'RECEIPT' : 'TEXT'): Promise<{ readonly id: string }> {
  const t = await chatTrade(ctx.tx, input.tradeId);
  const userId = requireUuid(input.userId, 'userId');
  const now = await dealNow(ctx.tx);
  if (!(await chatOpen(ctx.tx, t, now))) throw new DomainError('CHAT_CLOSED', 'this deal closed more than a week ago — write to INRP2P from Help if something is still open');
  const body = optionalText(input.body, 'body', DEAL_CHAT_LIMITS.bodyChars);
  if (!body && !input.file) throw new DomainError('INVALID_ARGUMENT', 'write a message or attach a file', { field: 'body' });
  const recent = await ctx.tx.selectFrom('deal_message').select(({ fn }) => fn.countAll<string>().as('n')).where('author_user_id', '=', userId).where('created_at', '>', sql<Date>`inrp2p_now() - interval '1 minute'`).executeTakeFirstOrThrow();
  if (BigInt(recent.n) >= BigInt(DEAL_CHAT_LIMITS.messagesPerMinute)) throw new DomainError('RATE_LIMITED', 'too many messages in a minute — wait a moment');

  let fileId: string | null = null;
  if (input.file) {
    const checked = checkAttachment(input.file.attachment, input.file.ref);
    const files = await ctx.tx.selectFrom('deal_message').select(({ fn }) => fn.countAll<string>().as('n')).where('trade_id', '=', t.id).where('author', '=', input.author).where('file_id', 'is not', null).executeTakeFirstOrThrow();
    if (BigInt(files.n) >= BigInt(DEAL_CHAT_LIMITS.filesPerSide)) throw new DomainError('RATE_LIMITED', `a side attaches up to ${DEAL_CHAT_LIMITS.filesPerSide} files to a deal`);
    const row = await ctx.tx
      .insertInto('deal_file')
      .values({ trade_id: t.id, name: checked.name, content_type: checked.type, byte_size: input.file.attachment.bytes.byteLength, sha256: checked.sha256, body: Buffer.from(input.file.attachment.bytes), uploaded_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    fileId = row.id;
    await appendAudit(ctx, { action: 'deal_chat.file_attached', entityType: 'deal_file', entityId: row.id, after: { trade_id: t.id, author: input.author, type: checked.type, size: input.file.attachment.bytes.byteLength, sha256: checked.sha256 } });
  }
  let legId: string | null = null;
  if (input.legId) {
    const leg = await ctx.tx.selectFrom('settlement_leg').select(['id', 'trade_id', 'side']).where('id', '=', requireUuid(input.legId, 'legId')).executeTakeFirst();
    if (!leg || leg.trade_id !== t.id) throw new DomainError('NOT_FOUND', 'payment not found');
    // A receipt is the payer's: the client's for its own payment, the trader's for its payout to the client.
    if ((leg.side === 'CLIENT_TO_EXCHANGE' ? 'CLIENT' : 'TRADER') !== input.author) throw new DomainError('NOT_THE_PAYER', 'only the one who sent a payment attaches its receipt');
    if (!input.file) throw new DomainError('INVALID_ARGUMENT', 'attach the receipt', { field: 'file' });
    legId = leg.id;
  }
  const row = await ctx.tx
    .insertInto('deal_message')
    .values({ trade_id: t.id, author: input.author, author_user_id: userId, kind, body, file_id: fileId, settlement_leg_id: legId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tellOtherSides(ctx, t, input.author, row.id, kind, now);
  return { id: row.id };
}

/**
 * The other side of the deal hears of a message — not its words — in its inbox, and by Telegram or email where it set
 * those up; at most once in a few minutes of conversation (`bucket`), so a chat never floods a phone.
 */
async function tellOtherSides(ctx: TxContext, t: ChatTrade, author: DealMessageAuthor, messageId: string, kind: DealMessageKind, now: Date): Promise<void> {
  const payload = { tradeId: t.id, clientId: t.clientId, messageId, from: author, kind, bucket: (BigInt(now.getTime()) / 600_000n).toString() };
  if (author !== 'CLIENT') await enqueueOutbox(ctx, { type: 'p2p.message_posted', aggregateType: 'trade', aggregateId: t.id, payload });
  if (author !== 'TRADER') await enqueueOutbox(ctx, { type: 'trader.p2p_message_posted', aggregateType: 'trade', aggregateId: t.id, payload });
}

/**
 * "Call support": a side asks INRP2P into the deal's chat. One open call per deal (the case's own uniqueness); it is a
 * case for the desk, never a hold — the deal and its deadlines go on, and only a dispute stops the escrow.
 */
export async function callSupportInTx(ctx: TxContext, input: { readonly tradeId: string; readonly author: 'CLIENT' | 'TRADER'; readonly userId: string; readonly note?: string | null }): Promise<{ readonly ref: string; readonly called: boolean }> {
  const trade = await lockTrade(ctx.tx, input.tradeId);
  const t = await chatTrade(ctx.tx, trade.id);
  const note = optionalText(input.note, 'note', 500);
  if (!(await chatOpen(ctx.tx, t, await dealNow(ctx.tx)))) throw new DomainError('CHAT_CLOSED', 'this deal closed more than a week ago');
  const role = (input.author === 'CLIENT') === t.buy ? 'buyer' : 'seller';
  const opened = await openExceptionInTx(ctx, { type: 'P2P_SUPPORT', subjectType: 'TRADE', subjectId: t.id, tradeId: t.id, details: { side: input.author, role, ...(note ? { note } : {}) } });
  if (!opened.opened) return { ref: opened.ref, called: false };
  await postDealMessageInTx(ctx, { tradeId: t.id, author: input.author, userId: input.userId, body: note ?? `The ${role} asked INRP2P support to join.` }, 'SUPPORT_CALLED');
  await appendAudit(ctx, { action: 'deal_chat.support_called', entityType: 'trade', entityId: t.id, after: { case: opened.ref, side: input.author } });
  return { ref: opened.ref, called: true };
}

/**
 * INRP2P's people write in a deal's chat. The first message after a side called them says they joined; the call's case
 * stays for the desk to close once it is answered.
 */
export async function postDeskMessageInTx(ctx: TxContext, input: Omit<PostInput, 'author' | 'legId'>): Promise<{ readonly id: string }> {
  const trade = await lockTrade(ctx.tx, input.tradeId);
  const support = await openSupportCase(ctx.tx, trade.id);
  if (support) {
    const answered = await ctx.tx.selectFrom('deal_message').select('id').where('trade_id', '=', trade.id).where('author', '=', 'INRP2P').where('created_at', '>=', support.created_at).executeTakeFirst();
    if (!answered) await postDealMessageInTx(ctx, { tradeId: trade.id, author: 'INRP2P', userId: input.userId, body: 'INRP2P support joined the chat.' }, 'SUPPORT_JOINED');
  }
  return postDealMessageInTx(ctx, { ...input, tradeId: trade.id, author: 'INRP2P' });
}

/** Who a person is to a P2P deal's chat, from the trade's own rows: its client's member, its trader's member, or nobody. */
export async function chatSideOf(ex: Executor, input: { readonly tradeId: string; readonly userId: string }): Promise<'CLIENT' | 'TRADER' | null> {
  const r = await sql<{ client_side: boolean; trader_side: boolean }>`
    select exists (select 1 from client_user cu join auth_user u on u.id = cu.user_id
                    where cu.client_id = t.client_id and cu.user_id = ${input.userId}::uuid and cu.status = 'ACTIVE' and u.status = 'ACTIVE' and u.kind = 'CLIENT') as client_side,
           exists (select 1 from route_obligation o join liquidity_route r on r.id = o.route_id join trader_profile p on p.id = r.trader_id
                     join client_user cu on cu.client_id = p.client_id join auth_user u on u.id = cu.user_id
                    where o.trade_id = t.id and cu.user_id = ${input.userId}::uuid and cu.status = 'ACTIVE' and u.status = 'ACTIVE' and u.kind = 'CLIENT') as trader_side
      from trade t join trade_economics e on e.trade_id = t.id
     where t.id = ${requireUuid(input.tradeId, 'tradeId')}::uuid and e.route_execution_mode = 'P2P'`.execute(ex);
  const row = r.rows[0];
  if (!row) return null;
  return row.client_side ? 'CLIENT' : row.trader_side ? 'TRADER' : null;
}
