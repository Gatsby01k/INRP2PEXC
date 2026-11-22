# ADR 0026 — Sign in with email or Telegram; confirm what matters with another factor

Status: **Accepted** — owner request of 2026-10-31. Changes SECURITY §2.2 and §2.3b. Migration `0043`, schema 43. The
operator desk (password + mandatory authenticator, §2.1) does not change. **Amended 2026-11-22** (owner request, §4):
Telegram opens an account by itself; migration `0054`, schema 54.

## 1. Context

A client signed in with a code to their email — and, with a session of one hour idle, did so again nearly every time they
came back. Every sensitive change then asked for an authenticator app, which most people do not have: a new client was
sent through installing one before their second bank account, and an older session was made to sign in again by email
just to set one up. Withdrawals and new settlement details of a trader asked for nothing beyond the session. Telegram, which
every desk already uses for its alerts, could neither sign anyone in nor confirm anything ("a chat is never a sign-in or
approval channel").

The goal: a person chooses email or Telegram to sign in, stays signed in on their device, is asked for a code only when
something would move money somewhere new — and then by a factor a thief of the session, the inbox or the Telegram alone
does not hold.

## 2. Decision

### 2.1 Three factors, one account
- **EMAIL** — a code to the address the account was opened with. Every client has it.
- **TELEGRAM** — the person's Telegram, linked from Account & security. Log In with Telegram is Telegram's official
  OpenID Connect flow (core.telegram.org/bots/telegram-login: Authorization Code with PKCE at `oauth.telegram.org`, an
  ID token signed with Telegram's published keys), run by Better Auth's own `genericOAuth` provider — its state (bound to
  a signed cookie), PKCE verifier, callback, linked account (`auth_account`, provider `telegram`) and session. The bot is
  the alerts bot: the scope `telegram:bot_access` lets it write to the person, and its private chat is where their codes
  and alerts arrive.
- **TOTP** — an authenticator app, optional, as before (TD-11).

There is still one user per person and one system of sessions, roles and balances. Telegram gives no email, so it is
never matched to an account by address: it signs in the account it opened (§4) or the one it was linked to from inside
(implicit linking off). One Telegram per person, one person per Telegram; only an active client with a verified email —
or the account that Telegram itself opened — holds one; Telegram's tokens are not kept (IX136, IX137).

### 2.2 Sessions last; how they were opened is recorded
- A client session lasts **30 days at most, 7 days without use** (it was 7 days and 1 hour). The desk's is unchanged.
- `auth_session.sign_in_method` records EMAIL or TELEGRAM (PASSWORD on the desk), set by the session guard from the
  endpoint that opened it and kept when Better Auth rotates the session.
- The device remembers how it signed in last (Better Auth's `lastLoginMethod` cookie, a method name only) and the address
  it used (in the browser only); the sign-in page offers that first.

### 2.3 What is confirmed, and by what
A **step-up by a factor other than the one the session was opened with**, within ten minutes, confirms:
adding or archiving a bank account or wallet; a trader's USDT reserve withdrawal and TRX network withdrawal (new);
a trader's new settlement details (new; an application still under review needs only a recent sign-in or code, like
a first destination); inviting, changing or removing team members and granting who may accept quotes. The authenticator
always counts. A code to the email does not confirm a session the email opened, nor Telegram one Telegram opened; a
step-up by a factor the person no longer has (an authenticator reset by the desk, a Telegram since disconnected) counts
for nothing. `requireConfirmation` (packages/identity `factors.ts`) is the one place this is decided; it refuses with
`STEP_UP_REQUIRED` and the factors that would do, or `MFA_ENROLLMENT_REQUIRED` when there are none (signed in by email,
nothing else linked).

Removed as redundant: the authenticator as the *only* way to confirm; signing in again by email to set up an
authenticator; a code to the email for a first destination when the session was opened minutes ago (D-20 keeps working:
a first bank account or wallet needs only a sign-in or code in the last ten minutes).

### 2.4 Codes (`/step-up/send`, `/step-up/verify`)
A Better Auth endpoint of the client surface, beside the authenticator's: six digits to the email (Resend) or by the bot
to the linked Telegram, one per session at a time, stored as an HMAC under the client auth secret, valid five minutes,
five tries, spent by the first right one, rate-limited (5 sends / 10 min, 10 checks / 5 min). The message names what it
confirms from a fixed list, never words from a page. A verified code is this session's step-up with its factor.

### 2.5 Changing the factors themselves
Linking Telegram, disconnecting it and setting up an authenticator are confirmed the same way when the account already
has a second factor — so whoever holds only the inbox cannot swap the person's Telegram or authenticator for their own. An
account with only its email needs a recent sign-in or code: the trust any first factor starts with, as the authenticator
always had. A lost Telegram is disconnected by the desk after confirming the person (`client_user.reset_mfa` with
`factor: TELEGRAM`, OWNER/SUPPORT ⧗), which ends every session and stops its alerts.

### 2.6 Alerts follow the linked Telegram
Linking Telegram turns the person's deal alerts on in that chat (unless they already had one) and the bot says so;
disconnecting it stops them. Alerts can be switched off and on without a code. Without the Login Widget configured, the
alerts card and its one-time `/start` code work as before (ADR 0020 §2.14).

## 3. Consequences
- Configuration: `TELEGRAM_LOGIN_CLIENT_ID` and `TELEGRAM_LOGIN_CLIENT_SECRET` from @BotFather → the alerts bot → Login
  Widget, whose allowed URLs list the client app's origin and `<CLIENT_BASE_URL>/api/auth/callback/telegram`. Without them
  nothing about Telegram sign-in is shown.
- The operator desk keeps password + authenticator; Telegram is never offered there.
- Unchanged and deliberately so: a trader's confirmation that rupees arrived (the escrow's release) needs the session and
  the sender check, not a step-up — it is part of every deal.
- Migration 0043 must run before the web app at 43 serves (the release check refuses otherwise).

## 4. Amendment of 2026-11-22 — Telegram opens an account

Someone new who pressed "Continue with Telegram" was sent back to sign in by email first and connect Telegram after. The
owner asked for Telegram to work on the first visit.

- **Sign-up.** The workspace door asks Better Auth to open an account (`requestSignUp`; the provider keeps
  `disableImplicitSignUp`, so nothing else does). A Telegram nobody holds creates a CLIENT identity — no client, no role,
  no permission, exactly what the email door creates — named from Telegram's profile, with the placeholder address
  `telegram-<telegram user id>@telegram.invalid` (`.invalid` is reserved, RFC 2606). The account itself is opened on
  `/open-account` as for an email (D-17); its deal alerts go to that Telegram from then on.
- **The placeholder is nobody's inbox.** Nothing is ever sent to it; the email door refuses it; it is never "verified";
  the workspace shows the person by their Telegram instead. The database holds it to a client that never verified it
  (`auth_user_telegram_placeholder`), and IX136 lets an account without a verified email hold only the Telegram its
  placeholder names (migration 0054).
- **Factors.** EMAIL counts only once the address is real, so such an account starts with one factor, its Telegram. A
  first destination still needs only a recent sign-in (D-20). Anything that needs a second factor answers
  `MFA_ENROLLMENT_REQUIRED` with `add: EMAIL`, and the page offers to add the email — or an authenticator.
- **Adding the email** (`/account-email/send`, `/account-email/verify`) is a change of factor (§2.5): within ten minutes
  of signing in, or after a code by the bot. A six-digit code goes to the address whoever it belongs to, so the answer never
  says whether an address has an account; it is stored as an HMAC, lives five minutes, allows five tries, is spent once.
  A right code makes the address the account's, verified — and counts as this session's EMAIL confirmation.
- **The same person, twice.** Someone who opened an account by email earlier and then pressed Telegram has two. When the
  Telegram account is still empty (no client, no application) and they add the earlier account's email, the Telegram
  moves to that account — what signing in by email and connecting Telegram there would have done — and the empty one is
  closed (DISABLED, placeholder released, sessions ended); they sign in again. Never over a Telegram or authenticator that
  already guards the earlier account, and never when both hold something: then `EMAIL_HAS_ACCOUNT`.
- **No lock-out.** While Telegram is the only way in it cannot be disconnected (`ADD_EMAIL_FIRST`).
- **Release.** Migration 0054 must run before the web app at 54 serves (the release check refuses otherwise). With Login
  with Telegram not configured, nothing changes on the page.

