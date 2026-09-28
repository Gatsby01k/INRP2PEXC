import { deskStrip, payoutAccounts, rateHistory, routePositions } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { dateTime, pair, rate, rateDelta } from '../_desk/format.ts';
import { Notice, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { HistoryTable } from './HistoryTable.tsx';
import { Positions } from './Positions.tsx';
import { RateBoard } from './RateBoard.tsx';

export const dynamic = 'force-dynamic';

/**
 * Rates (UX_FLOWS §2, brief "Rates page"): a dealer control surface, not a market terminal — the route rate in force
 * per route and direction, the one before it, how old it is, and a place to publish the next; the recent history as a
 * table; and, for the roles that see route economics, the route positions the desk settles separately.
 */
export default async function RatesPage() {
  const ctx = await operatorPage();
  const economics = ctx.access.economics;
  const showPositions = ctx.access.routePositions;
  const [strip, history, positions, accounts] = await Promise.all([
    deskStrip(ctx.db, ctx.access),
    economics ? rateHistory(ctx.db, { limit: 30 }) : Promise.resolve([]),
    showPositions ? routePositions(ctx.db, { status: 'OPEN' }) : Promise.resolve([]),
    payoutAccounts(ctx.db),
  ]);
  const routeCount = new Set((strip.routes ?? []).map((r) => r.routeId)).size;

  return (
    <Page>
      <PageHeader title="Rates" meta={economics ? `${routeCount} desk route${routeCount === 1 ? '' : 's'} · route rates are never shown to a client` : 'Route rates are hidden for your role'} />
      <PageBody>
        {!economics ? (
          <Notice icon="lock">Route rates, their history and route positions are economics. Your role does not include economics:view.</Notice>
        ) : (
          <>
            <RateBoard routes={strip.routes ?? []} history={history} canPublish={can(ctx, 'rates:update_route')} />
            <Section title="Recent rate changes" count={history.length} hint="Every published route rate, newest first, with the rate it replaced." flush>
              <HistoryTable
                rows={history.map((h) => ({
                  id: h.id,
                  at: dateTime(h.effectiveAt),
                  route: h.routeName,
                  pair: pair(h.direction),
                  rate: rate(h.rate),
                  change: h.previous ? rateDelta(h.rate, h.previous) : null,
                  by: h.byLabel,
                }))}
              />
            </Section>
          </>
        )}
        {showPositions ? (
          <Section
            id="positions"
            testId="route-positions"
            title="Route positions"
            count={positions.length}
            hint="Open route obligations. The client trade never waits for these; they settle between the desk and the route."
          >
            <Positions
              positions={positions}
              accounts={accounts.map((a) => ({ accountId: a.accountId, label: a.label, bankName: a.bankName }))}
              canRecord={can(ctx, 'route_settlement:record')}
              canConfirm={can(ctx, 'route_settlement:confirm')}
            />
          </Section>
        ) : null}
      </PageBody>
    </Page>
  );
}
