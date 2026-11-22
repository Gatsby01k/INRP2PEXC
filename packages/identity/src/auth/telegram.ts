import { type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

/**
 * Log In with Telegram (ADR 0026) — Telegram's official OpenID Connect flow (core.telegram.org/bots/telegram-login): the
 * Authorization Code flow with PKCE against oauth.telegram.org, run by Better Auth's own `genericOAuth` provider, so the
 * state, the PKCE verifier, the callback, the linked account and the session are all Better Auth's.
 *
 * It is the bot that sends the deal alerts: in BotFather, its Login Widget lists the client app's origin and its callback
 * (`<app>/api/auth/callback/telegram`) and shows the Client ID and Client Secret. The scopes ask for the person's id and
 * name, and for the bot to be allowed to write to them — that private chat is where their confirmation codes and alerts
 * arrive. Telegram gives no email: an account it opens carries a placeholder address (`telegramPlaceholderEmail`) until the
 * person adds their own in Account & security; an account opened by email links its Telegram from there.
 */
export const TELEGRAM_PROVIDER = 'telegram';
export const TELEGRAM_ISSUER = 'https://oauth.telegram.org';
const AUTHORIZATION_URL = `${TELEGRAM_ISSUER}/auth`;
const TOKEN_URL = `${TELEGRAM_ISSUER}/token`;
const JWKS_URL = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;
export const TELEGRAM_SCOPES = ['openid', 'profile', 'telegram:bot_access'] as const;

/**
 * Better Auth's OAuth sign-in needs an address for a profile; Telegram has none. This one can never be a person's: the
 * `.invalid` top-level domain is reserved (RFC 2606), nothing is ever sent to it, the workspace's email door refuses it,
 * and implicit linking by address is off besides — a Telegram signs in only the account it opened or was linked to.
 * The database holds it to that (migration 0054): only a client's, never "verified".
 */
export const TELEGRAM_PLACEHOLDER_DOMAIN = 'telegram.invalid';
export const telegramPlaceholderEmail = (telegramId: string) => `telegram-${telegramId}@${TELEGRAM_PLACEHOLDER_DOMAIN}`;

/** Whether an account's address is a stand-in rather than a person's email: it opened with Telegram and added none yet. */
export function isTelegramPlaceholderEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${TELEGRAM_PLACEHOLDER_DOMAIN}`);
}

/**
 * How a person is shown wherever their address would be: the address itself, or — for an account Telegram opened that
 * has not added an email — their Telegram (`@username`, or just "Telegram" when they have none). Never the placeholder.
 */
export function signInLabel(email: string, telegramUsername: string | null | undefined): string {
  if (!isTelegramPlaceholderEmail(email)) return email;
  return telegramUsername ? `@${telegramUsername}` : 'Telegram';
}

export interface TelegramLoginConfig {
  /** BotFather → the bot → Login Widget. */
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Who Telegram's ID tokens name as their audience: the Client ID, and the bot's own numeric id (the part of its token
   * before the colon), which Telegram's documentation names. Both are this bot.
   */
  readonly audiences: readonly string[];
  /** Tests only: the token endpoint and the signing keys. */
  readonly fetch?: typeof fetch;
  readonly keys?: JWTVerifyGetKey;
}

/** What INRP2P reads from a verified ID token: Telegram's numeric user id (also the bot's chat with them) and how to show it. */
export interface TelegramIdentity {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

let remoteKeys: JWTVerifyGetKey | undefined;
const telegramKeys = () => (remoteKeys ??= createRemoteJWKSet(new URL(JWKS_URL), { timeoutDuration: 5_000, cooldownDuration: 30_000 }));

/**
 * Verifies an ID token Telegram's token endpoint returned: its signature against Telegram's published keys, its issuer,
 * its audience, its expiry — and that it names a Telegram user by a numeric id. Anything else is `null`, never a guess.
 */
export async function verifyTelegramIdToken(idToken: string, config: Pick<TelegramLoginConfig, 'audiences' | 'keys'>): Promise<TelegramIdentity | null> {
  try {
    const { payload } = await jwtVerify(idToken, config.keys ?? telegramKeys(), {
      issuer: TELEGRAM_ISSUER,
      audience: [...config.audiences],
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 30,
    });
    const id = typeof payload.id === 'number' || typeof payload.id === 'string' ? String(payload.id) : '';
    if (!/^[1-9][0-9]{0,19}$/.test(id)) return null;
    const username = typeof payload.preferred_username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(payload.preferred_username) ? payload.preferred_username : null;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : (username ?? `Telegram ${id}`);
    return { id, name, username };
  } catch {
    return null;
  }
}

/** The username an ID token carries, read without verifying — only for an account row Better Auth is writing from a token it verified moments ago. */
export function telegramUsernameOf(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  try {
    const u = decodeJwt(idToken).preferred_username;
    return typeof u === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(u) ? u : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

/** The provider's configuration for Better Auth's `genericOAuth`. */
export function telegramOAuthProvider(config: TelegramLoginConfig) {
  const request = config.fetch ?? fetch;
  return {
    providerId: TELEGRAM_PROVIDER,
    name: 'Telegram',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizationUrl: AUTHORIZATION_URL,
    tokenUrl: TOKEN_URL,
    scopes: [...TELEGRAM_SCOPES],
    pkce: true,
    // A Telegram nobody holds opens a new client account — but only when the workspace's door asks for it
    // (`requestSignUp`); nothing is ever matched by address (implicit linking is off).
    disableSignUp: false,
    disableImplicitSignUp: true,
    accountSubject: ({ profile }: { profile: { id?: unknown } }) => String(profile.id ?? ''),
    // Telegram's token endpoint, as its documentation states it: HTTP Basic client authentication and a form body.
    getToken: async ({ code, redirectURI, codeVerifier }: { code: string; redirectURI: string; codeVerifier?: string | undefined }) => {
      const res = await request(TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectURI, client_id: config.clientId, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json().catch(() => null)) as TokenResponse | null;
      if (!res.ok || !json || typeof json.id_token !== 'string') throw new Error(`TELEGRAM_TOKEN_REFUSED: ${res.status}`);
      return {
        tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
        accessToken: typeof json.access_token === 'string' ? json.access_token : undefined,
        idToken: json.id_token,
        ...(typeof json.expires_in === 'number' ? { accessTokenExpiresAt: new Date(Date.now() + json.expires_in * 1000) } : {}),
      };
    },
    // There is no userinfo endpoint: everything comes from the verified ID token.
    getUserInfo: async (tokens: { idToken?: string | undefined }) => {
      if (!tokens.idToken) return null;
      const who = await verifyTelegramIdToken(tokens.idToken, config);
      if (!who) return null;
      return { id: who.id, name: who.name, email: telegramPlaceholderEmail(who.id), emailVerified: false, username: who.username };
    },
  };
}
