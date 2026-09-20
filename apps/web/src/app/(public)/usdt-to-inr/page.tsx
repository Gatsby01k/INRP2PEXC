import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageForPath } from '../../../content/site.ts';
import { publicOrigin } from '../../../server/site.ts';
import { SitePageView } from '../SitePageView.tsx';

export const dynamic = 'force-dynamic';

const PATH: string = '/usdt-to-inr';

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
