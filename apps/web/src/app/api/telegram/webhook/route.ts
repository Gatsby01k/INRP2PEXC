import { timingSafeEqual } from 'node:crypto';
import { executeCommand, hitRateLimit } from '@inrp2p/commands';
import { telegramFromEnv, telegramWebhookSecret } from '@inrp2p/adapters';
import { completeTelegramLink, stopTelegramChat } from '@inrp2p/clients';
import { askRobot, quietViaTelegram } from '@inrp2p/robot';
import { getRuntime } from '../../../../server/runtime.ts';
import { surfaceForHost } from '../../../../server/surface.ts';
import { personOfTelegramChat, robotDeskEmail, robotMind } from '../../../../server/robot.ts';

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
 * set with; anything without it is refused. In a private chat: `/start <code>` links the chat to the person who asked for
 * the code in the workspace, and `/stop` ends every alert there — and the robot's messages too. Everything else is the
 * robot's (ADR 0034): a question in the person's own words, or `/status`, `/rate`, `/help`, `/human`, answered from what
 * is true for the person whose chat it is; `/quiet` stops only the robot's suggestions. It always acknowledges an update,
 * so Telegram never retries one it should not.
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
  if (typeof chatId !== 'number' || message?.chat?.type !== 'private' || text.length === 0) return ok();
  try {
    await hitRateLimit(rt.appDb, { bucket: 'telegram_chat', subject: String(chatId), limit: 20, windowSeconds: 60 });
  } catch {
    return ok();
  }
  const reply = async (words: string) => {
    await bot.send({ chatId: String(chatId), text: words }).catch(() => {});
  };

  if (text === '/stop') {
    const person = await personOfTelegramChat(rt.appDb, chatId);
    const out = await executeCommand(rt.appDb, stopTelegramChat(), { name: 'telegram_link.stop', actor: SYSTEM, payload: { chatId: String(chatId) }, idempotencyKey: `telegram-update:${update.update_id ?? chatId}`, financial: false });
    if (person) await executeCommand(rt.appDb, quietViaTelegram(), { name: 'robot.quiet_telegram', actor: SYSTEM, payload: { userId: person }, idempotencyKey: null, financial: false });
    await reply(out.result.stopped > 0 || person ? 'Stopped. You will get no more alerts or messages here. Connect again from your INRP2P workspace at any time.' : 'There are no alerts linked to this chat.');
    return ok();
  }
  if (text === '/quiet') {
    const person = await personOfTelegramChat(rt.appDb, chatId);
    if (person) await executeCommand(rt.appDb, quietViaTelegram(), { name: 'robot.quiet_telegram', actor: SYSTEM, payload: { userId: person }, idempotencyKey: null, financial: false });
    await reply(person ? 'Done — the robot sends you no more suggestions. Your deal alerts still come here; /stop ends those too.' : 'There is nothing from the robot linked to this chat.');
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
  // The robot answers: a command it knows as the question it stands for, anything else in the person's own words.
  const COMMANDS: Record<string, string> = { '/status': 'status of my deal', '/rate': 'rate', '/help': 'help', '/human': 'talk to a person' };
  const question = text.startsWith('/') ? COMMANDS[text.split(/\s/)[0]!.toLowerCase()] : text;
  if (!question) {
    await reply('Ask me anything about your INRP2P account in your own words — or /status, /rate, /help, /human.');
    return ok();
  }
  try {
    const person = await personOfTelegramChat(rt.appDb, chatId);
    const answer = await askRobot(rt.appDb, { mind: robotMind(), deskEmail: robotDeskEmail() }, { userId: person, channel: 'TELEGRAM', telegramChatId: String(chatId), text: question.slice(0, 1000) });
    const base = rt.hosts.appHost ? `https://${rt.hosts.appHost}` : null;
    const url = answer.action && base ? new URL(answer.action.href, base).toString() : null;
    await bot.send({ chatId: String(chatId), text: answer.answer, ...(url ? { button: { text: answer.action!.label, url } } : {}) }).catch(() => {});
  } catch {
    await reply('I could not answer just now. Try again in a minute.');
  }
  return ok();
}
