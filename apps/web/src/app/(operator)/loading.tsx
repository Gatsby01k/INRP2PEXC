import { PageSkeleton } from './_desk/PageSkeleton.tsx';

/**
 * The boundary every desk section opens behind. Moving between sections is instant: the router has this prefetched with
 * each link in the rail and draws it on the click, while the server reads the section. It does not show when only a
 * page's own query changes (a tab, a selected row, a search): there the page stays as it is until the new one is read.
 */
export default function Loading() {
  return <PageSkeleton />;
}
