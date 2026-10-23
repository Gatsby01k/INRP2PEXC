import { timingSafeEqual } from 'node:crypto';
import { executeCommand, hitRateLimit } from '@inrp2p/commands';
import { telegramFromEnv, telegramWebhookSecret } from '@inrp2p/adapters';
import { completeTelegramLink, stopTelegramChat } from '@inrp2p/clients';
import { getRuntime } from '../../../../server/runtime.ts';
import { surfaceForHost } from '../../../../server/surface.ts';

export const dynamic = 'force-dynamic';

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const ok = () => new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } });
const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Update {
  readonly update_id?: number;
  readonly message?: { readonly text?: string; readonly chat?: { readonly id?: number; readonly type?: string }; readonly from?: { readonly username?: string } };
}

/**
 * The bot's webhook (docs/adr/0020-desks.md §2.14), on the public host only. Telegram sends the secret the webhook was
 * set with; anything without it is refused. The bot understands two things, in a private chat: `/start <code>` links the
 * chat to the person who asked for the code in the workspace, and `/stop` ends every alert there. It answers in words and
 * always acknowledges an update, so Telegram never retries one it should not.
 */
export async function POST(request: Request): Promise<Response> {
  const rt = getRuntime();
  if (surfaceForHost(request.headers.get('host'), rt.hosts) !== 'PUBLIC') return notFound();
  const secret = telegramWebhookSecret();
  const bot = telegramFromEnv();
  if (!secret || !bot) return notFound();
  if (!sameSecret(request.headers.get('x-telegram-bot-api-secret-token') ?? '', secret)) return new Response('Unauthorized', { status: 401 });
  if (Number(request.headers.get('content-length') ?? '0') > 65_536) return new Response('Too large', { status: 413 });

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return ok();
  }
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (typeof chatId !== 'number' || message?.chat?.type !== 'private' || !text.startsWith('/')) return ok();
  try {
    await hitRateLimit(rt.appDb, { bucket: 'telegram_chat', subject: String(chatId), limit: 20, windowSeconds: 60 });
  } catch {
    return ok();
  }
  const reply = async (words: string) => {
    await bot.send({ chatId: String(chatId), text: words }).catch(() => {});
  };

  if (text === '/stop') {
    const out = await executeCommand(rt.appDb, stopTelegramChat(), { name: 'telegram_link.stop', actor: SYSTEM, payload: { chatId: String(chatId) }, idempotencyKey: `telegram-update:${update.update_id ?? chatId}`, financial: false });
    await reply(out.result.stopped > 0 ? 'Stopped. You will get no more alerts here. Connect again from your INRP2P workspace at any time.' : 'There are no alerts linked to this chat.');
    return ok();
  }
  if (text === '/start' || text.startsWith('/start ')) {
    const code = text.slice('/start'.length).trim();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
      await reply('This bot sends INRP2P deal alerts. To get them here, connect Telegram from your INRP2P workspace.');
      return ok();
    }
    const out = await executeCommand(rt.appDb, completeTelegramLink(), {
      name: 'telegram_link.complete',
      actor: SYSTEM,
      payload: { code, chatId: String(chatId), username: message.from?.username ?? null },
      idempotencyKey: `telegram-update:${update.update_id ?? code}`,
      financial: false,
    });
    await reply(
      out.result.linked
        ? `Connected. You will get alerts for ${out.result.clientName} here: new deals, your moves, deadlines and completions. Send /stop to end them.`
        : 'This link has expired or was already used. Open it again from your INRP2P workspace.',
    );
    return ok();
  }
  await reply('This bot only sends alerts. Manage them from your INRP2P workspace.');
  return ok();
}
