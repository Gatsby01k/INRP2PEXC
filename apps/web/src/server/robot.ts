import 'server-only';
import type { Db } from '@inrp2p/db';
import { TELEGRAM_PROVIDER } from '@inrp2p/identity';
import { type RobotMind, robotMindFromEnv } from '@inrp2p/adapters';
import type { WorkspaceAccess } from '@inrp2p/portal';
import { type RobotBrief, robotBriefOf } from '@inrp2p/robot';
import { liveDeal } from './live-deal.ts';
import { siteContacts } from './site.ts';

/**
 * The robot as the web app serves it (ADR 0034): its brief for the signed-in person — with the deal that waits on them,
 * read the way the bar reads it — and what it answers with. Everything it says comes from `@inrp2p/robot`; this file
 * only puts the person's session and the deployment's configuration around it.
 */
export async function robotBriefFor(db: Db, access: WorkspaceAccess): Promise<RobotBrief | null> {
  const deal = access.kind === 'MEMBER' ? await liveDeal(db, access.member, access.userId) : null;
  return robotBriefOf(db, access.userId, { deal: deal ? { ref: deal.ref, href: deal.href, move: deal.move, dueBy: deal.dueBy, more: deal.more } : null });
}

let mind: RobotMind | null | undefined;
/** The model, when `ANTHROPIC_API_KEY` is set on this deployment; null otherwise (rules and people answer). */
export function robotMind(): RobotMind | null {
  if (mind === undefined) mind = robotMindFromEnv(process.env);
  return mind;
}

export function robotDeskEmail(): string | null {
  return siteContacts().desk;
}

/**
 * Who writes from a private Telegram chat: the person whose alerts chat it is, or — with no alerts chat — the person who
 * signs in with that Telegram (a private chat's id is its person's Telegram id). Null for a stranger.
 */
export async function personOfTelegramChat(db: Db, chatId: number): Promise<string | null> {
  const linked = await db.selectFrom('telegram_link as l').innerJoin('client_user as cu', 'cu.id', 'l.client_user_id')
    .select('cu.user_id').where('l.chat_id', '=', BigInt(chatId)).where('l.status', '=', 'ACTIVE').where('cu.status', '=', 'ACTIVE')
    .orderBy('l.linked_at', 'desc').executeTakeFirst();
  if (linked) return linked.user_id;
  const account = await db.selectFrom('auth_account as a').innerJoin('auth_user as u', 'u.id', 'a.user_id')
    .select('a.user_id').where('a.provider_id', '=', TELEGRAM_PROVIDER).where('a.account_id', '=', String(chatId)).where('u.status', '=', 'ACTIVE').where('u.kind', '=', 'CLIENT')
    .executeTakeFirst();
  return account?.user_id ?? null;
}
