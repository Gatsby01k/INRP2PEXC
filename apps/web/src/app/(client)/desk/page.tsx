import { redirect } from 'next/navigation';
import { deskToday, deskWorkspace } from '@inrp2p/traders';
import { telegramLinkOf, telegramOf } from '@inrp2p/clients';
import { telegramFromEnv } from '@inrp2p/adapters';
import { telegramLoginConfigured } from '../../../server/runtime.ts';
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
  // ADR 0026: with Log In with Telegram set up, the desk's alerts card is the person's Telegram card (sign-in, codes, alerts).
  const login = telegramLoginConfigured();
  const [today, alerts, telegram] = await Promise.all([
    deskToday(ctx.db, ctx.actor.userId),
    login ? Promise.resolve(null) : telegramLinkOf(ctx.db, ctx.actor.userId),
    login ? telegramOf(ctx.db, ctx.actor.userId, true) : Promise.resolve(null),
  ]);
  return (
    <TodayScreen
      today={today}
      host={host}
      canAdmin={ws.canAdmin}
      canCommit={ws.canCommit}
      telegram={telegram ? { mode: 'LOGIN', view: telegram } : { mode: 'ALERTS', view: alerts!, botConfigured: telegramFromEnv() !== null }}
    />
  );
}
