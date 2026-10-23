import { redirect } from 'next/navigation';
import { deskToday, deskWorkspace } from '@inrp2p/traders';
import { telegramLinkOf } from '@inrp2p/clients';
import { telegramFromEnv } from '@inrp2p/adapters';
import { memberPage } from '../../../server/client.ts';
import { publicOrigin } from '../../../server/site.ts';
import { OpenDesk } from './OpenDesk.tsx';
import { TodayScreen } from './TodayScreen.tsx';

export const dynamic = 'force-dynamic';

/**
 * The desk — a trader's own exchange on INRP2P (ADR 0020). Before it exists, the way to open it; once it does, "Today":
 * whether clients can get a price, what waits on the desk, and how it has been doing. Not a trader yet: Traders is where
 * that starts.
 */
export default async function DeskPage() {
  const ctx = await memberPage();
  const ws = await deskWorkspace(ctx.db, ctx.actor.userId);
  if (ws.state === 'NOT_TRADER') redirect('/traders');
  const origin = await publicOrigin();
  const host = origin.replace(/^https?:\/\//, '');
  if (ws.state === 'NO_DESK') return <OpenDesk canAdmin={ws.canAdmin} host={host} clientName={ctx.member.clientName} />;
  const [today, telegram] = await Promise.all([deskToday(ctx.db, ctx.actor.userId), telegramLinkOf(ctx.db, ctx.actor.userId)]);
  return <TodayScreen today={today} host={host} canAdmin={ws.canAdmin} canCommit={ws.canCommit} telegram={{ view: telegram, botConfigured: telegramFromEnv() !== null }} />;
}
