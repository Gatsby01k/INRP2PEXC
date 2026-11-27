import { clientPeople, hasAuthenticator } from '@inrp2p/portal';
import { telegramLinkOf, telegramOf } from '@inrp2p/clients';
import { telegramFromEnv, webPushPublicKey } from '@inrp2p/adapters';
import { workspacePage } from '../../../server/client.ts';
import { telegramLoginConfigured } from '../../../server/runtime.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { AccountScreen, type AccountTelegram } from './AccountScreen.tsx';
import { ShieldIcon } from '../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * Account & security, for everyone who can sign in — a client, a trader, someone who has not opened an account yet: who
 * is signed in, how they sign in and confirm changes (email, Telegram, an authenticator — ADR 0026), and, for an
 * administrator of an account with the Exchange, who may accept quotes (TD-11).
 */
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ telegram?: string | string[]; error?: string | string[] }> }) {
  const ctx = await workspacePage();
  const member = ctx.access.kind === 'MEMBER' ? ctx.access.member : null;
  const exchangeAdmin = member?.exchangeAccess === true && member.role === 'CLIENT_ADMIN';
  const params = await searchParams;
  const state = params.telegram === 'linked' || params.telegram === 'failed' ? params.telegram : null;
  const error = typeof params.error === 'string' && /^[a-z_]{1,64}$/.test(params.error) ? params.error : null;

  const loadTelegram = async (): Promise<AccountTelegram> => {
    if (telegramLoginConfigured()) {
      return { mode: 'LOGIN', view: await telegramOf(ctx.db, ctx.actor.userId, member !== null), ...(state ? { outcome: { state, error } } : {}) };
    }
    // The bot without its Login Widget set up: alerts only, linked by a code sent to the bot (ADR 0020 §2.14).
    if (telegramFromEnv() && member) return { mode: 'ALERTS', view: await telegramLinkOf(ctx.db, ctx.actor.userId) };
    return null;
  };
  const [authenticator, people, telegram] = await Promise.all([
    hasAuthenticator(ctx.db, ctx.actor.userId),
    exchangeAdmin ? clientPeople(ctx.db, member.clientId) : Promise.resolve([]),
    loadTelegram(),
  ]);

  return (
    <>
      <PageHead icon={<ShieldIcon />} title="Account & security" lede="Who you are signed in as, how you sign in and confirm what matters, and who on your account may accept quotes." />
      <AccountScreen
        name={member?.clientName ?? ctx.access.name}
        label={ctx.access.label}
        email={ctx.access.email}
        role={member?.role ?? null}
        canAccept={member?.exchangeAccess ? member.canAcceptQuotes : null}
        hasAuthenticator={authenticator}
        signInMethod={ctx.signInMethod}
        people={people}
        isAdmin={exchangeAdmin}
        telegram={telegram}
        pushKey={webPushPublicKey(process.env)}
      />
    </>
  );
}
