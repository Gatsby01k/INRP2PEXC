import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageForPath } from '../../../content/site.ts';
import { pageMetadata } from '../metadata.ts';
import { SitePageView } from '../SitePageView.tsx';

export const dynamic = 'force-dynamic';

const PATH: string = '/usdt-otc-india';

export async function generateMetadata(): Promise<Metadata> {
  const page = pageForPath(PATH);
  return page ? pageMetadata(page) : {};
}

export default function Page() {
  const page = pageForPath(PATH);
  if (!page) notFound();
  return <SitePageView page={page} />;
}
