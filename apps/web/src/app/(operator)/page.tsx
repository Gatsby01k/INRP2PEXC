import { isDomainError } from '@inrp2p/kernel';
import { type QueueGroupKey, deskNow, deskQueue, deskQuote, deskRequest, deskStrip, deskTrade } from '@inrp2p/desk';
import { collectionAccounts } from '@inrp2p/traders';
import { optionalEnv } from '../../server/env.ts';
import { can, operatorPage } from '../../server/operator.ts';
import { ContextPanel } from './_desk/ContextPanel.tsx';
import { LiveRefresh } from './_desk/Keyboard.tsx';
import { dateTime, money, pair, side } from './_desk/format.ts';
import { Chip, LifecycleChip, LinkTabs, Page, PageHeader, Side } from './_desk/ui.tsx';
import { QuoteBuilder } from './_quote/QuoteBuilder.tsx';
import { SentQuote } from './_quote/SentQuote.tsx';
import { tradePerms } from './_trade/perms.ts';
import { TradeWorkspace } from './_trade/TradeWorkspace.tsx';
import { DeskQueue } from './DeskQueue.tsx';
import { GROUP_TITLE } from './_desk/queue-labels.ts';
import { Strip } from './Strip.tsx';
import q from './queue.module.css';

export const dynamic = 'force-dynamic';

const VIEWS: readonly (QueueGroupKey | 'all')[] = ['all', 'needs_action', 'exception', 'settlement', 'waiting_client', 'processing'];

/** `row` is `trade:<id>` / `request:<id>` / `quote:<id>`; `do` names the panel section a hotkey asked for. */
function parseRow(value: string | undefined): { kind: 'trade' | 'request' | 'quote'; id: string } | null {
  if (!value) return null;
  const [kind, id] = value.split(':');
  return (kind === 'trade' || kind === 'request' || kind === 'quote') && id ? { kind, id } : null;
}

/** A row that no longer resolves (a stale link, a mistyped id) closes the panel rather than failing the desk. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isDomainError(e) && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGUMENT')) return null;
    throw e;
  }
}

/**
 * The Desk (UX_FLOWS W5): what needs action right now. The strip, then the live queue in priority order, and the
 * context panel for the selected row beside it — the quote builder for a request, the sent quote while the client
 * decides, the trade workspace for a trade — so the queue stays in view while the work is done.
 */
export default async function DeskPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const rowParam = typeof params.row === 'string' ? params.row : undefined;
  const selected = parseRow(rowParam);
  const section = typeof params.do === 'string' ? params.do : undefined;
  const view = (typeof params.view === 'string' && (VIEWS as readonly string[]).includes(params.view) ? params.view : 'all') as QueueGroupKey | 'all';

  const [strip, groups, now] = await Promise.all([deskStrip(ctx.db, ctx.access), deskQueue(ctx.db, ctx.access), deskNow(ctx.db)]);

  // The panel is server-rendered from the same rows the queue read, so it can never show a different trade.
  const trade = selected?.kind === 'trade' ? await orNull(deskTrade(ctx.db, selected.id, ctx.access)) : null;
  const request = selected?.kind === 'request' ? await orNull(deskRequest(ctx.db, selected.id, ctx.access)) : null;
  const quote = selected?.kind === 'quote' ? await orNull(deskQuote(ctx.db, selected.id, ctx.access)) : null;
  const collection = trade && trade.direction === 'BUY_USDT' ? await collectionAccounts(ctx.db) : [];
  const hasPanel = Boolean(trade || request || quote);

  const keep = (next: Record<string, string | null>) => {
    const p = new URLSearchParams();
    if (view !== 'all') p.set('view', view);
    for (const [k, v] of Object.entries(next)) if (v !== null) p.set(k, v);
    const s = p.toString();
    return s ? `/?${s}` : '/';
  };
  const closeHref = keep({});
  const count = (key: QueueGroupKey) => groups.find((g) => g.key === key)?.rows.length ?? 0;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  const tabs = (
    <LinkTabs
      label="Queue views"
      items={VIEWS.map((v) => {
        const p = new URLSearchParams();
        if (v !== 'all') p.set('view', v);
        if (rowParam) p.set('row', rowParam);
        return {
          href: p.toString() ? `/?${p.toString()}` : '/',
          label: v === 'all' ? 'All work' : GROUP_TITLE[v],
          count: v === 'all' ? total : count(v),
          ...(v === 'exception' ? { tone: 'danger' as const } : v === 'needs_action' ? { tone: 'brand' as const } : {}),
          current: view === v,
        };
      })}
    />
  );

  return (
    <Page fixed>
      <PageHeader
        title="Desk"
        meta={
          <span className={q.live}>
            <span className={q.liveDot} aria-hidden="true" />
            Live · {strip.istDay} IST
          </span>
        }
        tabs={tabs}
      />
      <LiveRefresh seconds={20} />
      <div className={q.strip}>
        <Strip strip={strip} now={now} />
      </div>
      <div className={q.split} {...(hasPanel ? { 'data-panel': '' } : {})}>
        <div className={q.list}>
          <DeskQueue groups={groups} economics={ctx.access.economics} selected={rowParam ?? null} view={view} compact={hasPanel} />
        </div>
        {hasPanel ? (
          <div className={q.panelCol}>
            {request ? (
              <ContextPanel
                refLabel={request.ref}
                title={request.clientName}
                subtitle={`${side(request.direction)} ${money(request.amount, request.amountCurrency)} · ${pair(request.direction)}`}
                badges={
                  <>
                    <Side direction={request.direction} />
                    <Chip tone={request.status === 'OPEN' ? 'brand' : 'neutral'}>{request.status === 'OPEN' ? 'New request' : request.status.toLowerCase()}</Chip>
                  </>
                }
                closeHref={closeHref}
                testId="request-panel"
                label={`Quote ${request.ref}`}
              >
                <QuoteBuilder
                  request={request}
                  perms={{ quote: can(ctx, 'quote:create') && can(ctx, 'quote:send'), decline: can(ctx, 'request:decline'), withdraw: can(ctx, 'request:withdraw'), assign: can(ctx, 'traders:assign') }}
                  linkBase={optionalEnv('CLIENT_LINK_BASE') ?? ''}
                  autoFocus={section === 'quote'}
                />
              </ContextPanel>
            ) : null}
            {quote ? (
              <ContextPanel
                refLabel={quote.ref}
                title={quote.clientName}
                subtitle={`Quote sent${quote.sentAt ? ` ${dateTime(quote.sentAt)}` : ''}`}
                badges={<Side direction={quote.direction} />}
                closeHref={closeHref}
                {...(quote.tradeRef ? { recordHref: `/orders/${encodeURIComponent(quote.tradeRef)}` } : {})}
                testId="quote-context"
                label={`Quote ${quote.ref}`}
              >
                <SentQuote quote={quote} canCancel={can(ctx, 'quote:cancel')} canLink={can(ctx, 'quote_link:create')} linkBase={optionalEnv('CLIENT_LINK_BASE') ?? ''} />
              </ContextPanel>
            ) : null}
            {trade ? (
              <ContextPanel
                refLabel={trade.ref}
                title={trade.clientName}
                subtitle={`Opened ${dateTime(trade.openedAt)}`}
                badges={
                  <>
                    <Side direction={trade.direction} />
                    <LifecycleChip state={trade.lifecycle} hold={trade.hold} />
                  </>
                }
                closeHref={closeHref}
                recordHref={`/orders/${encodeURIComponent(trade.ref)}`}
                testId="trade-panel"
                label={`Trade ${trade.ref}`}
              >
                <TradeWorkspace trade={trade} perms={tradePerms(ctx)} collectionAccounts={collection} {...(section ? { focus: section } : {})} />
              </ContextPanel>
            ) : null}
          </div>
        ) : null}
      </div>
    </Page>
  );
}
