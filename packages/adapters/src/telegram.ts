import { NotificationDeliveryError } from './notifications.ts';

/**
 * Telegram, for alerts (docs/adr/0020-desks.md §2.14): one bot, which the people of a desk link their own chat to and
 * which tells them about their deals. The bot only speaks when spoken of by the system: it sends messages and answers the
 * one command that links a chat. It is never an authentication channel.
 */
export interface TelegramMessage {
  /** Telegram's id of the chat, as a decimal string (int64). */
  readonly chatId: string;
  /** Plain text: no markup is parsed, so nothing a desk or a client typed can format or link anything. */
  readonly text: string;
  /** One button under the message, opening the deal in the workspace. */
  readonly button?: { readonly text: string; readonly url: string } | undefined;
}

export interface TelegramAdapter {
  /** The bot's username, for the `t.me/<bot>?start=<code>` link a person opens to connect. */
  readonly botUsername: string;
  send(message: TelegramMessage): Promise<{ readonly messageId: string }>;
}

/**
 * Telegram's Bot API (`sendMessage`). A refusal by the person — they blocked the bot or deleted the chat (403) — or a
 * malformed request (400) is permanent; a rate limit (429), a server error or the network failing is not.
 */
export class BotApiTelegram implements TelegramAdapter {
  readonly botUsername: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(opts: { token: string; botUsername: string; fetchImpl?: typeof fetch; baseUrl?: string }) {
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(opts.token)) throw new Error('TELEGRAM_BOT_TOKEN does not look like a bot token');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(opts.botUsername)) throw new Error('TELEGRAM_BOT_USERNAME must be the bot’s username, without @');
    this.botUsername = opts.botUsername;
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#base = (opts.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    if (!this.#base.startsWith('https://')) throw new Error('the Telegram API base must be https');
  }

  async send(message: TelegramMessage): Promise<{ readonly messageId: string }> {
    const body: Record<string, unknown> = { chat_id: message.chatId, text: message.text, link_preview_options: { is_disabled: true } };
    if (message.button) body.reply_markup = { inline_keyboard: [[{ text: message.button.text, url: message.button.url }]] };
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/bot${this.#token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new NotificationDeliveryError('TELEGRAM_UNREACHABLE', true);
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number } } | null;
    if (res.ok && json?.ok && typeof json.result?.message_id === 'number') return { messageId: String(json.result.message_id) };
    if (res.status === 403) throw new NotificationDeliveryError('TELEGRAM_BLOCKED', false);
    if (res.status === 400) throw new NotificationDeliveryError('TELEGRAM_REJECTED_400', false);
    throw new NotificationDeliveryError(`TELEGRAM_${res.status}`, res.status === 429 || res.status >= 500);
  }
}

/**
 * The Telegram channel the environment configures: the Bot API when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` are
 * set, otherwise none — and no channel is registered, so a deployment without a bot loses nothing else.
 */
export function telegramFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): TelegramAdapter | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const username = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  if (!token || !username) return null;
  return new BotApiTelegram({ token, botUsername: username, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** The secret Telegram sends back with every update (`X-Telegram-Bot-Api-Secret-Token`), when the webhook is set. */
export function telegramWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return s && /^[A-Za-z0-9_-]{24,256}$/.test(s) ? s : null;
}
