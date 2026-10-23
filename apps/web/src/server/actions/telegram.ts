'use server';

import { revalidatePath } from 'next/cache';
import { telegramFromEnv } from '@inrp2p/adapters';
import { revokeTelegramLink, startTelegramLink } from '@inrp2p/clients';
import type { CommandResult } from '../command.ts';
import { runWorkspaceCommand } from '../client.ts';

/**
 * Connecting a person's Telegram chat for alerts (docs/adr/0020-desks.md §2.14). The code comes back once, inside the
 * `t.me` link that hands it to the bot; the chat is linked when the bot receives it.
 */
export async function startTelegramLinkAction(key: string): Promise<CommandResult<{ url: string; expiresAt: string }>> {
  const bot = telegramFromEnv();
  if (!bot) return { ok: false, code: 'NOT_CONFIGURED', message: 'Telegram alerts are not available yet.' };
  let code: string | null = null;
  const out = await runWorkspaceCommand(
    (ctx) =>
      startTelegramLink(ctx.actor, (c) => {
        code = c;
      }),
    {},
    { name: 'telegram_link.start', idempotencyKey: key, financial: false },
  );
  if (!out.ok) return out;
  if (!code) return { ok: false, code: 'INTERNAL', message: 'No code was issued. Try again.' };
  return { ok: true, result: { url: `https://t.me/${bot.botUsername}?start=${code}`, expiresAt: out.result.expiresAt } };
}

export async function revokeTelegramLinkAction(key: string): Promise<CommandResult<{ revoked: number }>> {
  const out = await runWorkspaceCommand((ctx) => revokeTelegramLink(ctx.actor), {}, { name: 'telegram_link.revoke', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/', 'layout');
  return out;
}
