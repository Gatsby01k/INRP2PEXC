import type { ReactNode } from 'react';
import Link from 'next/link';
import { getImageProps } from 'next/image';
import mark from '../../../../../brand/inrp2p-mark.png';
import { workspacePage } from '../../server/client.ts';
import { mailto, siteContacts } from '../../server/site.ts';
import { workspaceFrame } from '../../server/workspace-frame.ts';
import { AccountMenu } from './_workspace/AccountMenu.tsx';
import { Ticker } from './_workspace/Ticker.tsx';
import { CommandMenu, type CommandEntry } from './_workspace/CommandMenu.tsx';
import { FieldLight } from './_workspace/FieldLight.tsx';
import { LiveDeal } from './_workspace/LiveDeal.tsx';
import { MailIcon } from './_workspace/icons.tsx';
import { NotificationsLink } from './_workspace/NotificationsLink.tsx';
import { PAGE_HEAD_ID } from './_workspace/PageHead.tsx';
import { ClientNav, type ClientNavEntry } from './Nav.tsx';
import styles from './shell.module.css';

export const dynamic = 'force-dynamic';

const ENTRIES: ClientNavEntry[] = [
  { href: '/exchange', label: 'Exchange' },
  { href: '/history', label: 'History' },
  { href: '/destinations', label: 'Bank & wallets' },
  { href: '/traders', label: 'Traders' },
];

/** A client that provides capacity only, or a trader applicant: Traders is the whole of their workspace. */
const TRADER_ENTRIES: ClientNavEntry[] = [
  { href: '/traders', label: 'Traders' },
  // A trader's phone bar carries its orders and its reserve too (mock-up v3); on a desk they are on the Traders page.
  { href: '/traders/orders', label: 'Orders', phone: true },
  { href: '/traders/reserve', label: 'Reserve', phone: true },
];

/** A trader's own exchange (ADR 0020): its desk comes first, before the programme it trades through. */
const DESK: ClientNavEntry = { href: '/desk', label: 'Desk' };
const DESKS: ClientNavEntry = { href: '/desks', label: 'Desks' };
const withDesk = (entries: ClientNavEntry[]): ClientNavEntry[] => {
  const at = entries.findIndex((e) => e.href === '/traders');
  return [...entries.slice(0, at), DESK, ...entries.slice(at)];
};

/** Signed in with no account yet (D-17): open one for the Exchange, or apply to provide capacity. */
const NEW_ENTRIES: ClientNavEntry[] = [
  { href: '/open-account', label: 'Open account' },
  { href: '/traders', label: 'Traders' },
];

/** The desk's own sections, beside the workspace's in the sidebar and in the command menu. */
const DESK_SECTIONS: ClientNavEntry[] = [
  { href: '/desk', label: 'Today' },
  { href: '/desk/deals', label: 'Deals' },
  { href: '/desk/prices', label: 'Prices' },
  { href: '/desk/clients', label: 'Clients' },
  { href: '/desk/team', label: 'Team' },
  { href: '/desk/settings', label: 'Page' },
];

const ROLE: Record<string, string> = { CLIENT_ADMIN: 'Administrator', CLIENT_TRADER: 'Trader', CLIENT_VIEWER: 'Viewer' };
const DESK_STATE: Record<string, { label: string; tone: 'live' | 'paused' | 'neutral' }> = {
  LIVE: { label: 'Live', tone: 'live' },
  PAUSED: { label: 'Paused', tone: 'paused' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUSPENDED: { label: 'Suspended', tone: 'paused' },
};

/**
 * The client workspace. Everything inside it has already been through `workspacePage()`, so a page never asks whether
 * someone is signed in — only what their client has. One sign-in reaches it, and what it offers follows from the
 * account: a client with the Exchange sees all four sections; a trader applicant, or a client that provides capacity
 * only, sees Traders.
 *
 * The masthead is one glass bar floating over the page: the mark and the name on the left, the sections beside it —
 * the one you are on a visor with its glyph lit, sliding to the next as you move — and search (⌘K), notifications and
 * the account on the right, and — when a deal waits on this person — that deal riding in the bar on every page
 * (`LiveDeal`). On a phone the sections drop to a floating bar under the thumb. Below
 * it each page lays out its own work: a heading, the work, and — where the page has one — a column of context beside
 * it (`shell.module.css`).
 */
export default async function ClientLayout({ children }: { children: ReactNode }) {
  const ctx = await workspacePage();
  const member = ctx.access.kind === 'MEMBER' ? ctx.access.member : null;
  // What the frame shows besides the person, read together (one round trip, not five).
  const { unread, held, trader, dealsWithDesks } = await workspaceFrame(ctx.db, member);
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 32, height: 32 });
  const { desk } = siteContacts();
  // A trader runs a desk: approved or paused, or already with one open.
  const desks = trader !== null && (trader.status === 'APPROVED' || trader.status === 'PAUSED');
  const ownDesk = desks ? (trader.desk ?? undefined) : undefined;
  const home = member?.exchangeAccess ? '/exchange' : desks ? '/desk' : member ? '/traders' : '/open-account';
  const base = member?.exchangeAccess ? ENTRIES : member ? TRADER_ENTRIES : NEW_ENTRIES;
  const withDesks = dealsWithDesks && member?.exchangeAccess ? [base[0]!, DESKS, ...base.slice(1)] : base;
  const entries = desks ? withDesk(withDesks) : withDesks;
  const name = member?.clientName ?? ctx.access.email;
  const deskState = ownDesk ? DESK_STATE[ownDesk.status] : undefined;

  const commands: CommandEntry[] = [
    ...entries.filter((e) => !e.phone).map((e) => ({ href: e.href, label: e.label, group: 'Go to' })),
    ...(ownDesk ? DESK_SECTIONS.map((e) => ({ href: e.href, label: e.label, group: 'Your desk', hint: ownDesk.displayName })) : []),
    ...(member ? [{ href: '/notifications', label: 'Notifications', group: 'Account', ...(unread > 0 ? { hint: `${unread} unread` } : {}) }] : []),
    // ADR 0026: everyone who can sign in has Account & security — how they sign in and confirm is theirs, client or not.
    { href: '/account', label: 'Account & security', group: 'Account' },
    ...(member && desks ? [{ href: '/account/team', label: 'Team', group: 'Account' }] : []),
  ];

  return (
    <div className={styles.shell}>
      {/* A full load draws the page itself, never its loading shape first (ADR 0021 §4.5). On a phone the stylesheets
          land after the page's HTML; at that moment the browser would draw the frame and the loading shape, and React
          then holds the page, already read, 300 ms behind that first frame. This asks the browser to draw nothing until
          the page's heading has been read, so its first frame is the page. React lifts it into the document's head, the
          only place that can hold a first paint: on a click it lands in a page already drawn and does nothing, and the
          shape opens the section at once (§2.3). A browser that does not know `expect` draws as before. */}
      <link rel="expect" href={`#${PAGE_HEAD_ID}`} blocking="render" />
      <FieldLight />
      {/* The room the work sits in: warm paper, a sunrise across its top whose light drifts slowly, the landing's dotted
          orbits turning in the corner, and a grain. */}
      <div className={styles.backdrop} aria-hidden="true">
        <span className={styles.glow} />
        <span className={styles.orbitMask}>
          <svg className={styles.orbits} viewBox="0 0 1400 1400" fill="none" focusable="false">
            <g stroke="currentColor" strokeLinecap="round" strokeWidth="1.5">
              <circle cx="700" cy="700" r="470" strokeDasharray="2 13" />
              <circle cx="700" cy="700" r="590" strokeDasharray="2 17" opacity="0.75" />
              <circle cx="700" cy="700" r="690" strokeDasharray="2 22" opacity="0.5" />
            </g>
            <circle cx="367.7" cy="1032.3" r="6" fill="currentColor" />
            <circle cx="1117.2" cy="1117.2" r="5" fill="currentColor" opacity="0.8" />
            <circle cx="212" cy="212" r="5" fill="currentColor" opacity="0.7" />
          </svg>
        </span>
      </div>
      <header className={styles.header}>
        <div className={styles.mastheadInner}>
          <Link href={home} className={styles.brand} aria-label="INRP2P workspace">
            <img {...markProps} className={styles.brandMark} />
            <span className={styles.brandName}>
              INRP2P <span className={styles.brandSub}>Exchange</span>
            </span>
          </Link>
          <ClientNav entries={entries} />
          <div className={styles.headerActions}>
            {member ? <LiveDeal /> : null}
            {member ? <Ticker /> : null}
            <CommandMenu entries={commands} />
            {member ? (
              <NotificationsLink unread={unread} className={styles.iconButton} iconClassName={styles.toolIcon} badgeClassName={styles.unread} />
            ) : null}
            <AccountMenu name={name} email={ctx.access.email} role={member ? (ROLE[member.role] ?? 'Viewer') : null} hasAccount />
          </div>
        </div>
      </header>

      {held ? (
        <p className={styles.holdNotice} role="status" data-testid="payments-reconciling">
          We are reconciling recent payments. If you have already sent a payment, please do not send it again — it will be matched to your trade or order.
        </p>
      ) : null}

      <div className={styles.workspace} data-robot-scope="">
        {children}
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerBrand}>
            <img {...markProps} className={styles.footerMark} />
            INRP2P Exchange · USDT ↔ INR
            {deskState && ownDesk ? (
              <span className={styles.deskState} data-tone={deskState.tone}>
                <span className={styles.deskStateDot} />
                {ownDesk.displayName} · {deskState.label}
              </span>
            ) : null}
          </span>
          {desk ? (
            <a className={styles.footerLink} href={mailto(desk, 'Question from the workspace')}>
              <MailIcon className={styles.footerIcon} />
              Contact the desk — quote your trade reference
            </a>
          ) : (
            <span>Questions about a trade? Quote its reference when you contact the desk.</span>
          )}
        </div>
      </footer>
    </div>
  );
}
