import { NotificationDeliveryError } from '../notifications.ts';
import type { TelegramAdapter, TelegramMessage } from '../telegram.ts';

/** Captures what the bot would send. `failNext` makes the next send fail: an outage, or the person having blocked the bot. */
export class FakeTelegram implements TelegramAdapter {
  readonly botUsername = 'inrp2p_test_bot';
  readonly sent: TelegramMessage[] = [];
  failNext: false | 'OUTAGE' | 'BLOCKED' = false;

  async send(message: TelegramMessage): Promise<{ readonly messageId: string }> {
    const fail = this.failNext;
    this.failNext = false;
    if (fail === 'OUTAGE') throw new NotificationDeliveryError('TELEGRAM_503', true);
    if (fail === 'BLOCKED') throw new NotificationDeliveryError('TELEGRAM_BLOCKED', false);
    this.sent.push(message);
    return { messageId: String(this.sent.length) };
  }

  to(chatId: string): TelegramMessage[] {
    return this.sent.filter((m) => m.chatId === chatId);
  }
}
