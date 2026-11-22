import 'server-only';
import { createDb, createPool, type Db } from '@inrp2p/db';
import { telegramFromEnv } from '@inrp2p/adapters';
import { executeCommand } from '@inrp2p/commands';
import { connectTelegramAlerts, disconnectTelegramAlerts } from '@inrp2p/clients';
import { type ClientTelegram, createClientAuth, createOperatorAuth, type ClientAuth, type OperatorAuth } from '@inrp2p/identity';
import { envFlag, optionalEnv, requiredEnv as required } from './env.ts';
import { clientOtpSender } from './client-otp.ts';
import { hostConfig } from './hosts.ts';
import { databaseStartCheck } from './production-start.ts';
import type { HostConfig } from './surface.ts';

/**
 * Session cookies are `Secure` everywhere a real person signs in. The one exception is an end-to-end run against
 * a plain-HTTP localhost server, which cannot receive a Secure cookie at all. The switch is explicit, loud, and
 * refused outright in production, so it can never be the reason a desk session leaks over http.
 */
function useSecureCookies(): boolean {
  const insecure = envFlag('INRP2P_ALLOW_INSECURE_COOKIES');
  if (!insecure) return true;
  if ((optionalEnv('INRP2P_ENV') ?? '').toLowerCase() === 'production') {
    throw new Error('INRP2P_ALLOW_INSECURE_COOKIES must never be set in production');
  }
  return false;
}

interface Runtime {
  hosts: HostConfig;
  appDb: Db;
  operatorAuth: OperatorAuth;
  clientAuth: ClientAuth;
}

let runtime: Runtime | undefined;

/**
 * Log In with Telegram (ADR 0026), when the alerts bot's Login Widget is set up in BotFather: its Client ID and Secret,
 * and the bot itself — the private chat a person's codes and alerts arrive in. Any of them missing, Telegram is simply
 * not offered: sign-in stays the email code, confirmation the email code or the authenticator.
 */
export function telegramLoginConfigured(): boolean {
  return Boolean(optionalEnv('TELEGRAM_LOGIN_CLIENT_ID') && optionalEnv('TELEGRAM_LOGIN_CLIENT_SECRET') && telegramFromEnv());
}

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

function clientTelegram(appDb: Db): ClientTelegram | undefined {
  const bot = telegramFromEnv();
  const clientId = optionalEnv('TELEGRAM_LOGIN_CLIENT_ID');
  const clientSecret = optionalEnv('TELEGRAM_LOGIN_CLIENT_SECRET');
  if (!bot || !clientId || !clientSecret) return undefined;
  const botId = (optionalEnv('TELEGRAM_BOT_TOKEN') ?? '').split(':')[0] ?? '';
  return {
    login: { clientId, clientSecret, audiences: [...new Set([clientId, botId].filter(Boolean))] },
    send: async ({ chatId, text }) => {
      await bot.send({ chatId, text });
    },
    // The person's alerts follow their Telegram, and the bot says hello — which also proves it may write to them.
    onLinked: async ({ userId, telegramId, username }) => {
      await executeCommand(appDb, connectTelegramAlerts(), { name: 'telegram_link.connect', actor: SYSTEM, payload: { userId, chatId: telegramId, username }, idempotencyKey: null, financial: false });
      await bot
        .send({ chatId: telegramId, text: 'Telegram is connected to your INRP2P account. You can sign in with it, codes that confirm changes come here, and so do your deal alerts. Not you? Disconnect it in Account & security and contact the desk.' })
        .catch(() => {});
    },
    onUnlinked: async ({ userId, telegramId }) => {
      await executeCommand(appDb, disconnectTelegramAlerts(), { name: 'telegram_link.disconnect', actor: SYSTEM, payload: { userId, chatId: telegramId }, idempotencyKey: null, financial: false });
      await bot.send({ chatId: telegramId, text: 'Telegram is disconnected from your INRP2P account. It no longer signs you in, and alerts stop here.' }).catch(() => {});
    },
  };
}

/**
 * A person who signed in with Telegram before they had an account — opened by Telegram itself, or linked while still
 * new — opens one: their deal alerts go to that Telegram from the start (ADR 0026). Without a linked Telegram, or with
 * alerts already on, nothing happens; a failure never fails the account that was just opened.
 */
export async function alertsFollowTelegram(userId: string): Promise<void> {
  if (!telegramFromEnv()) return;
  const appDb = getRuntime().appDb;
  try {
    const linked = await appDb.selectFrom('auth_account').select(['account_id', 'telegram_username']).where('user_id', '=', userId).where('provider_id', '=', 'telegram').executeTakeFirst();
    if (!linked) return;
    await executeCommand(appDb, connectTelegramAlerts(), {
      name: 'telegram_link.connect', actor: SYSTEM, payload: { userId, chatId: linked.account_id, username: linked.telegram_username }, idempotencyKey: null, financial: false,
    });
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', event: 'telegram.alerts_on_open_failed', reason: (e instanceof Error ? e.message : String(e)).split(':')[0]!.slice(0, 80) }));
  }
}

/**
 * Lazily constructed server runtime (pools and Better Auth instances). In production, neither pool sends a statement
 * before the start-up check has passed on the database (`databaseStartCheck`). Something that only needs the host
 * names asks `hostConfig()`, not this.
 */
export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const databaseUrl = required('DATABASE_URL');
  const appPool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-web', int8: 'bigint' });
  const ready = databaseStartCheck(appPool);
  const appDb = createDb(appPool, ready ? { ready } : {});
  const authDb = createDb(createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-web-auth', int8: 'number' }), ready ? { ready } : {});
  const hosts = hostConfig();
  const secure = useSecureCookies();
  const operatorAuth = createOperatorAuth({
    authDb, appDb, secret: required('OPERATOR_AUTH_SECRET'),
    baseURL: optionalEnv('OPERATOR_BASE_URL') ?? `https://${hosts.deskHost}`,
    useSecureCookies: secure,
  });
  const clientAuth = createClientAuth({
    authDb, appDb, secret: required('CLIENT_AUTH_SECRET'),
    baseURL: optionalEnv('CLIENT_BASE_URL') ?? `https://${hosts.appHost}`,
    useSecureCookies: secure,
    otpSender: clientOtpSender(),
    telegram: clientTelegram(appDb),
  });
  runtime = { hosts, appDb, operatorAuth, clientAuth };
  return runtime;
}

/**
 * The origin a shareable quote link is written with (D-01). It is the public host, never the client host: a link
 * is opened by whoever holds it, and the page it opens must not sit on an origin that carries a client's cookie.
 */
export function quoteLinkBase(): string {
  return optionalEnv('CLIENT_LINK_BASE') ?? `https://${hostConfig().publicHost}`;
}

/** The origin the client product is served from, used where an email needs an absolute link back into it. */
export function clientBase(): string {
  return optionalEnv('CLIENT_BASE_URL') ?? `https://${hostConfig().appHost}`;
}
