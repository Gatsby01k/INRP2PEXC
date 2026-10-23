import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getImageProps } from 'next/image';
import { type DeskPage, deskPage } from '@inrp2p/traders';
import { formatDuration, groupDigits } from '@inrp2p/ui/format';
import mark from '../../../../../../brand/inrp2p-mark.png';
import { getRuntime } from '../../../server/runtime.ts';
import { appOrigin, publicOrigin } from '../../../server/site.ts';
import { surfaceForHost } from '../../../server/surface.ts';
import { DeskTicket } from './DeskTicket.tsx';
import styles from '../storefront.module.css';

export const dynamic = 'force-dynamic';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (iso: string) => {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** The desk behind `inrp2p.com/<handle>` — on the public host only, and never a draft. */
async function load(handle: string): Promise<DeskPage> {
  const surface = surfaceForHost((await headers()).get('host'), getRuntime().hosts);
  if (surface !== 'PUBLIC') notFound();
  const page = await deskPage(getRuntime().appDb, handle);
  if (!page) notFound();
  return page;
}

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const page = await load(handle);
  const origin = await publicOrigin();
  const description = page.about ?? `Sell or buy USDT for rupees with ${page.displayName}. Every deal settles through INRP2P’s escrow.`;
  return {
    metadataBase: new URL(origin),
    title: `${page.displayName} — USDT ⇄ INR`,
    description,
    alternates: { canonical: `/${page.handle}` },
    // A live desk's page is its shop window and may be found; a paused one says so and is not offered to a crawler.
    robots: page.status === 'LIVE' ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title: `${page.displayName} on INRP2P Exchange`, description, url: `/${page.handle}`, siteName: 'INRP2P Exchange', type: 'website', locale: 'en_IN' },
  };
}

/**
 * A desk's own page (ADR 0020 §2.10): its name, what it says about itself, its record from the books, and its live
 * prices in a ticket that works out what the client gets. Nothing about its clients, volumes, its own USDT or INRP2P's
 * fee. The way on is the client's workspace, where a firm price is asked for after signing in.
 */
/** The storefront's few glyphs, in the kit's hand: one stroke weight, round joins, a 24-unit grid. */
const GLYPH = {
  price: 'M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2a1 1 0 0 1 0 1.4l-7.8 7.8a1 1 0 0 1-1.4 0Z M8 6.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z',
  escrow: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z M12 8.5v1 M12 14.5v1 M8.5 12h1 M14.5 12h1',
  release: 'M12 3.5 5 6.5v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9v-5Z M9 12l2.2 2.2L15.5 10',
  deals: 'M4.5 8.5h13 M14 5l3.5 3.5L14 12 M19.5 15.5h-13 M10 12l-3.5 3.5L10 19',
  time: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 7.5V12l3 2',
  since: 'M6.5 5.5h11a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5V8a2.5 2.5 0 0 1 2.5-2.5Z M4 10h16 M8.5 3.5v4 M15.5 3.5v4',
} as const;

function Glyph({ name, className }: { name: keyof typeof GLYPH; className?: string | undefined }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={GLYPH[name]} />
    </svg>
  );
}

export default async function PublicDeskPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const page = await load(handle);
  const app = appOrigin();
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 22, height: 22 });
  const live = page.status === 'LIVE';
  const { completedDeals, medianMinutes } = page.record;

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
        <a className={styles.signIn} href={`${app}/sign-in`}>
          Sign in
        </a>
      </header>

      <main className={styles.main}>
        <div className={styles.hero}>
          <section className={styles.identity} aria-labelledby="desk-name">
            <div className={styles.deskRow}>
              <span className={styles.monogram} aria-hidden="true">
                {page.displayName.trim().charAt(0).toUpperCase()}
              </span>
              <span className={styles.status} data-tone={live ? undefined : 'paused'}>
                {live ? 'Taking deals' : 'Paused'}
              </span>
            </div>
            <h1 id="desk-name" className={styles.name}>
              {page.displayName}
            </h1>
            <p className={styles.about}>{page.about ?? 'Sell USDT for rupees, or buy USDT with rupees — at this desk’s own prices.'}</p>
          </section>

          <DeskTicket handle={page.handle} displayName={page.displayName} prices={page.prices} live={live} appOrigin={app} />

          <section className={styles.proof} aria-label="Record and escrow">
            <dl className={styles.record}>
              <div>
                <Glyph name="deals" className={styles.recordIcon} />
                <dt>Deals completed</dt>
                <dd>{groupDigits(String(completedDeals))}</dd>
              </div>
              <div>
                <Glyph name="time" className={styles.recordIcon} />
                <dt>Usual time</dt>
                <dd>{medianMinutes === null ? '—' : formatDuration(medianMinutes * 60_000)}</dd>
              </div>
              <div>
                <Glyph name="since" className={styles.recordIcon} />
                <dt>On INRP2P since</dt>
                <dd>{monthYear(page.since)}</dd>
              </div>
            </dl>
            <p className={styles.escrowNote}>
              <svg className={styles.escrowIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3.5 5 6.5v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9v-5Z" />
                <path d="m9 12 2.2 2.2L15.5 10" />
              </svg>
              <span>Rupees go straight between you and {page.displayName}. The USDT waits in the deal’s own escrow, held by INRP2P, and is released only when the rupees are confirmed.</span>
            </p>
          </section>
        </div>

        <section className={styles.how} aria-labelledby="how-title">
          <h2 id="how-title" className={styles.howTitle}>
            How a deal works
          </h2>
          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={styles.stepGlyph}>
                <Glyph name="price" />
              </span>
              <p className={styles.stepTitle}>A firm price</p>
              <p className={styles.stepBody}>Sign in with your email and ask: the price is fixed for a minute, with exactly what you send and receive.</p>
            </li>
            <li className={styles.step}>
              <span className={styles.stepGlyph}>
                <Glyph name="escrow" />
              </span>
              <p className={styles.stepTitle}>USDT into escrow</p>
              <p className={styles.stepBody}>Whoever sells puts the USDT into the deal’s own address, held by INRP2P. Rupees move by IMPS or NEFT, account to account.</p>
            </li>
            <li className={styles.step}>
              <span className={styles.stepGlyph}>
                <Glyph name="release" />
              </span>
              <p className={styles.stepTitle}>Released on confirmation</p>
              <p className={styles.stepBody}>Once the rupees are confirmed, INRP2P releases the USDT from escrow — never before.</p>
            </li>
          </ol>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>{page.displayName} is an independent desk on INRP2P Exchange. Its prices are its own.</span>
          <a href="/">INRP2P Exchange</a>
        </div>
      </footer>
    </div>
  );
}
