import { describe, expect, it } from 'vitest';
import { BotApiTelegram, type NotificationDeliveryError, telegramFromEnv, telegramWebhookSecret } from '../src/index.ts';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('the Telegram bot', () => {
  it('sends plain text with one button, and reads back the message id', async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const bot = new BotApiTelegram({ token: TOKEN, botUsername: 'inrp2p_alerts_bot', fetchImpl });
    expect(await bot.send({ chatId: '424242', text: 'New deal', button: { text: 'Open', url: 'https://app.inrp2p.com/desk' } })).toEqual({ messageId: '42' });
    expect(sent!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(sent!.body).toMatchObject({ chat_id: '424242', text: 'New deal', reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://app.inrp2p.com/desk' }]] } });
    expect(sent!.body).not.toHaveProperty('parse_mode');
  });

  it('treats a blocked chat and a bad request as final, a rate limit or an outage as worth retrying', async () => {
    const outcome = async (status: number) => new BotApiTelegram({ token: TOKEN, botUsername: 'inrp2p_alerts_bot', fetchImpl: reply(status, { ok: false }) }).send({ chatId: '1', text: 'x' }).catch((e: NotificationDeliveryError) => ({ code: e.code, retryable: e.retryable }));
    expect(await outcome(403)).toEqual({ code: 'TELEGRAM_BLOCKED', retryable: false });
    expect(await outcome(400)).toEqual({ code: 'TELEGRAM_REJECTED_400', retryable: false });
    expect(await outcome(429)).toEqual({ code: 'TELEGRAM_429', retryable: true });
    expect(await outcome(502)).toEqual({ code: 'TELEGRAM_502', retryable: true });
  });

  it('is configured only with a token and a username; the webhook only with a long secret', () => {
    expect(telegramFromEnv({})).toBeNull();
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toBeNull();
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: '@inrp2p_alerts_bot' })?.botUsername).toBe('inrp2p_alerts_bot');
    expect(() => telegramFromEnv({ TELEGRAM_BOT_TOKEN: 'nope', TELEGRAM_BOT_USERNAME: 'inrp2p_alerts_bot' })).toThrow(/bot token/);
    expect(telegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: 'short' })).toBeNull();
    expect(telegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: 'local-webhook-secret-0123456789abcdef' })).toBe('local-webhook-secret-0123456789abcdef'); // secret-scan:allow — a fixture, not a secret
  });
});
