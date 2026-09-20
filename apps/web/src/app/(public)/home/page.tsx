import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageForPath } from '../../../content/site.ts';
import { publicOrigin } from '../../../server/site.ts';
import { SitePageView } from '../SitePageView.tsx';

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
  if (!page) return {};
  const origin = await publicOrigin();
  const url = `${origin}${PATH === '/' ? '' : PATH}`;
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: { title: page.title, description: page.description, url, type: 'website' },
  };
}

export default function Page() {
  const page = pageForPath(PATH);
  if (!page) notFound();
  return <SitePageView page={page} />;
}
