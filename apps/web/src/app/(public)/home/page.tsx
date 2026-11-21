import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageForPath } from '../../../content/site.ts';
import { Closing } from '../_landing/closing/Closing.tsx';
import { Faq } from '../_landing/faq/Faq.tsx';
import { Deal } from '../_landing/deal/Deal.tsx';
import { Hero } from '../_landing/Hero.tsx';
import { FieldLight } from '../_landing/FieldLight.tsx';
import { OwnDesk } from '../_landing/owndesk/OwnDesk.tsx';
import { Board } from '../_landing/board/Board.tsx';
import { Showcase } from '../_landing/showcase/Showcase.tsx';
import { Story } from '../_landing/Story.tsx';
import { Why } from '../_landing/why/Why.tsx';
import { pageMetadata } from '../metadata.ts';
import { SitePageView } from '../SitePageView.tsx';
import { appOrigin, publicOrigin } from '../../../server/site.ts';

export const dynamic = 'force-dynamic';

/**
 * The public home page.
 *
 * It lives at `/home` in the route tree and is served at `/` by a rewrite in the proxy, because `/` in this
 * build is already the operator desk and two route groups cannot both own one path. The rewrite is one-way: a
 * request for `/home` is refused by the public host's gate, so the page has exactly one URL and the canonical
 * link, the sitemap and the structured data all agree on which.
 */
const PATH: string = '/';

export async function generateMetadata(): Promise<Metadata> {
  const page = pageForPath(PATH);
  return page ? pageMetadata(page) : {};
}

export default async function Page() {
  const page = pageForPath(PATH);
  if (!page) notFound();
  // The desk programme's mock-up shows a desk's address on this site's own host, as a desk's page really has it.
  const host = (await publicOrigin()).replace(/^https?:\/\//, '');
  return (
    <SitePageView
      page={page}
      hero={<Hero />}
      story={
        <Story>
          <Board />
          <Deal />
          <Why />
          <Showcase />
          <OwnDesk appOrigin={appOrigin()} host={host} />
          <Faq />
          <Closing />
          <FieldLight />
        </Story>
      }
    />
  );
}
