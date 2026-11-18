import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import { deskTraders } from '@inrp2p/traders';
import { MarkArt } from '../../../components/MarkArt.tsx';
import { can, operatorPage } from '../../../server/operator.ts';
import { usdt } from '../_desk/format.ts';
import { KpiBand, LinkTabs, Page, PageBody, PageHeader } from '../_desk/ui.tsx';
import { bookStyles as b } from '../_book/parts.tsx';
import { ProgramForm } from './ProgramForm.tsx';
import { TraderList } from './TraderList.tsx';
import q from '../queue.module.css';

export const dynamic = 'force-dynamic';

/**
 * Traders, for the desk (`traders:view`). Two views: the traders — what waits for a decision first, as the page's one
 * orange moment, then every trader with what matters for routing — and the programme, the settings every approval and
 * every deal starts from, on a page of its own so the list is never under a form. Anyone can apply through "Become a
 * trader"; nothing an applicant submits is usable until it is verified here.
 */
export default async function TradersDeskPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'traders:view')) notFound();
  const params = await searchParams;
  const view = params.view === 'programme' ? 'programme' : 'traders';
  const { program, traders } = await deskTraders(ctx.db);
  const review = traders.filter((t) => t.status === 'UNDER_REVIEW').length;
  const changes = traders.filter((t) => t.status !== 'UNDER_REVIEW' && t.awaitingReview > 0).length;
  const approved = traders.filter((t) => t.status === 'APPROVED' || t.status === 'PAUSED');
  const online = approved.filter((t) => t.status === 'APPROVED' && t.available).length;
  const unresolved = traders.reduce((n, t) => n + t.unresolved, 0);
  const open = traders.reduce((n, t) => n + t.openOrders, 0);
  const reserve = approved.reduce((s, t) => s.add(Money.parse(t.reserveBalance, 'USDT')), Money.zero('USDT'));
  const decide = review + changes;
  const first = traders.find((t) => t.status === 'UNDER_REVIEW' || t.awaitingReview > 0);

  return (
    <Page>
      <PageHeader
        title="Traders"
        meta={`${approved.length} approved · ${review} new application${review === 1 ? '' : 's'} · ${changes} settlement change${changes === 1 ? '' : 's'}`}
        tabs={
          <LinkTabs
            label="Traders views"
            items={[
              { href: '/trader-desk', label: 'Traders', count: traders.length, current: view === 'traders', ...(decide > 0 ? { tone: 'brand' as const } : {}) },
              { href: '/trader-desk?view=programme', label: 'Programme', current: view === 'programme' },
            ]}
          />
        }
      />
      <PageBody>
        {view === 'programme' ? (
          <ProgramForm program={program} canConfigure={can(ctx, 'traders:configure')} />
        ) : (
          <>
            <div className={b.strip} aria-label="Trader programme">
              <Link href={first ? `/trader-desk/${first.traderId}` : '/trader-desk'} className={q.focus} {...(decide === 0 ? { 'data-calm': '' } : {})}>
                <MarkArt className={q.focusArt} stages={decide === 0 ? 3 : 1} hub={false} />
                <span className={q.focusLabel}>{decide > 0 ? 'Needs a decision' : 'Nothing to decide'}</span>
                <span className={q.focusFigure}>
                  <span className={q.focusCount}>{decide}</span>
                  <span className={q.focusWords}>{decide === 0 ? 'every trader is decided' : decide === 1 ? 'trader waits for you' : 'traders wait for you'}</span>
                </span>
                <span className={q.focusParts}>
                  {review > 0 ? <span className={q.focusPart}>{review} application{review === 1 ? '' : 's'}</span> : null}
                  {changes > 0 ? <span className={q.focusPart}>{changes} settlement change{changes === 1 ? '' : 's'}</span> : null}
                  {decide === 0 ? <span className={q.focusPart}>{program.autoReview ? 'rules approve the clear ones' : 'new applications appear here'}</span> : null}
                </span>
              </Link>
              <KpiBand
                  label="Traders at work"
                  items={[
                    { key: 'o', label: 'Online now', value: `${online} of ${approved.length}`, sub: 'approved traders taking work', ...(online === 0 ? { tone: 'muted' as const } : {}) },
                    { key: 'n', label: 'Open orders', value: String(open), sub: 'accepted or in progress' },
                    { key: 'u', label: 'Unresolved', value: String(unresolved), sub: unresolved > 0 ? 'owed and not yet settled' : 'nothing owed', ...(unresolved > 0 ? { tone: 'danger' as const } : { tone: 'muted' as const }) },
                    { key: 'r', label: 'Reserves held', value: usdt(reserve.toDecimalString()), sub: program.autoAssign ? 'requests routed automatically' : 'requests assigned by hand' },
                  ]}
                />
            </div>
            <section className={`${b.sheet} ${b.bookTable}`} aria-label="Every trader">
              <TraderList traders={traders} />
            </section>
          </>
        )}
      </PageBody>
    </Page>
  );
}
