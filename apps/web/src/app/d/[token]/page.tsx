import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { sql } from 'kysely';
import { notFound } from 'next/navigation';
import { getImageProps } from 'next/image';
import { hitRateLimit } from '@inrp2p/commands';
import { deskDealLinkView } from '@inrp2p/quotes';
import mark from '../../../../../../brand/inrp2p-mark.png';
import { callerIpHash } from '../../../server/link.ts';
import { getRuntime } from '../../../server/runtime.ts';
import { appOrigin } from '../../../server/site.ts';
import { surfaceForHost } from '../../../server/surface.ts';
import { clientLinkState } from '@inrp2p/quotes';
import { clientDestinations, hasAuthenticator } from '@inrp2p/portal';
import { redirect } from 'next/navigation';
import { workspacePage } from '../../../server/client.ts';
import { DealLinkScreen } from './DealLinkScreen.tsx';
import { LinkTakeScreen } from './LinkTakeScreen.tsx';
import styles from '../../public-desk/storefront.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'A deal for you',
  // A deal link is one person's: never indexed, previewed or summarised by anything that follows it.
  robots: { index: false, follow: false, nocache: true },
};

/** Opens a person may make of deal links from one address in a minute: enough to read and reload, not to guess. */
const OPENS_PER_MINUTE = 30;

/**
 * A desk's deal link (ADR 0020 §2.9), as anyone holding it sees it before signing in: the desk, the deal at the desk's
 * rate, the exact amounts the client sends and receives, and until when it can be taken. Never the desk's own USDT or
 * INRP2P's fee. Opening it takes nothing: the first person to sign in and take it is the only one who ever can, in the
 * client's workspace. An unknown token is "not found", like one that never existed.
 */
export default async function DealLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rt = getRuntime();
  const surface = surfaceForHost((await headers()).get('host'), rt.hosts);
  if (!/^[0-9A-Za-z]{16,64}$/.test(token)) notFound();
  if (surface === 'CLIENT') return <ClientLinkPage token={token} />;
  if (surface !== 'PUBLIC') notFound();
  await hitRateLimit(rt.appDb, { bucket: 'desk_link_open_ip', subject: await callerIpHash(), limit: OPENS_PER_MINUTE, windowSeconds: 60 });
  const view = await deskDealLinkView(rt.appDb, token);
  if (!view) notFound();
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 22, height: 22 });
  const now = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(rt.appDb)).rows[0]!.now;

  return (
    <div className={styles.page}>
      <div className={styles.backdrop} aria-hidden="true">
        <span className={styles.glow} />
      </div>
      <header className={styles.bar}>
        <a className={styles.by} href="/">
          <img {...markProps} className={styles.byMark} />
          <span>
            Escrow by <strong>INRP2P Exchange</strong>
          </span>
        </a>
      </header>
      <DealLinkScreen view={view} now={now.toISOString()} takeUrl={`${appOrigin()}/d/${token}`} />
    </div>
  );
}

/**
 * The same link in the client's workspace host, signed in (the proxy sends a stranger to sign in and back here): the
 * person takes the deal — opening an account first if they have none — and accepts its firm price. Once it became their
 * trade, the link takes them to it.
 */
async function ClientLinkPage({ token }: { token: string }) {
  const ctx = await workspacePage();
  if (ctx.access.kind !== 'MEMBER') redirect(`/open-account?next=${encodeURIComponent(`/d/${token}`)}`);
  const member = ctx.access.member;
  const state = await clientLinkState(ctx.db, member.clientId, token);
  if (!state) notFound();
  if (state.tradeRef) redirect(`/trades/${state.tradeRef}`);
  const [destinations, authenticator, now] = await Promise.all([
    clientDestinations(ctx.db, member.clientId),
    hasAuthenticator(ctx.db, ctx.actor.userId),
    sql<{ now: Date }>`select inrp2p_now() as now`.execute(ctx.db).then((r) => r.rows[0]!.now),
  ]);
  const banks = destinations.banks.filter((b) => b.status === 'ACTIVE').map((b) => ({ id: b.id, name: `${b.bankName} •••• ${b.last4}`, meta: b.holderName }));
  const wallets = destinations.wallets
    .filter((w) => w.status === 'ACTIVE' && w.purpose !== 'SOURCE')
    .map((w) => ({ id: w.id, name: w.label, meta: `TRC20 · ${w.address.slice(0, 4)}…${w.address.slice(-4)}` }));
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 22, height: 22 });
  return (
    <div className={styles.page}>
      <div className={styles.backdrop} aria-hidden="true">
        <span className={styles.glow} />
      </div>
      <header className={styles.bar}>
        <span className={styles.by}>
          <img {...markProps} className={styles.byMark} />
          <span>
            Escrow by <strong>INRP2P Exchange</strong>
          </span>
        </span>
        <a className={styles.signIn} href="/desks">
          Your desks
        </a>
      </header>
      <LinkTakeScreen
        token={token}
        state={state}
        banks={banks}
        wallets={wallets}
        anyWallet={destinations.wallets.some((w) => w.status === 'ACTIVE' || w.status === 'PENDING_REVIEW')}
        who={{ canAccept: member.canAcceptQuotes, isAdmin: member.role === 'CLIENT_ADMIN', hasAuthenticator: authenticator, email: ctx.access.email, clientName: member.clientName }}
        now={now.toISOString()}
      />
    </div>
  );
}
