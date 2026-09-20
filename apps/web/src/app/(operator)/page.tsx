import { deskQueue, deskRequest, deskStrip, deskTrade } from '@inrp2p/desk';
import { optionalEnv } from '../../server/env.ts';
import { can, operatorPage } from '../../server/operator.ts';
import { ExceptionPanel } from '../../components/panels/ExceptionPanel.tsx';
import { PayoutPanel } from '../../components/panels/PayoutPanel.tsx';
import { QuotePanel } from '../../components/panels/QuotePanel.tsx';
import { DeskQueue } from './DeskQueue.tsx';
import { Strip } from './Strip.tsx';
import styles from './shell.module.css';

export const dynamic = 'force-dynamic';

/** `row` is `trade:<id>` / `request:<id>` / `quote:<id>`; `do` names the panel section a hotkey asked for. */
function parseRow(value: string | undefined): { kind: string; id: string } | null {
  if (!value) return null;
  const [kind, id] = value.split(':');
  return kind && id ? { kind, id } : null;
}

export default async function DeskPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const selected = parseRow(typeof params.row === 'string' ? params.row : undefined);
  const section = typeof params.do === 'string' ? params.do : undefined;

  const [strip, groups] = await Promise.all([deskStrip(ctx.db, ctx.access), deskQueue(ctx.db, ctx.access)]);

  // The panel is server-rendered from the same rows the queue read, so it can never show a different trade.
  const trade = selected?.kind === 'trade' ? await deskTrade(ctx.db, selected.id, ctx.access) : null;
  const request = selected?.kind === 'request' ? await deskRequest(ctx.db, selected.id, ctx.access) : null;
  const showException = trade !== null && (section === 'exception' || (trade.cases.length > 0 && section === undefined && trade.hold));

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>Desk</h1>
      </header>
      <Strip strip={strip} />
      <div className={styles.content}>
        <div className={selected ? styles.withPanel : ''}>
          <DeskQueue groups={groups} economics={ctx.access.economics} />
          {request ? (
            <QuotePanel
              request={request}
              canQuote={can(ctx, 'quote:create') && can(ctx, 'quote:send')}
              canDecline={can(ctx, 'request:decline')}
              linkBase={optionalEnv('CLIENT_LINK_BASE') ?? ''}
            />
          ) : null}
          {trade && showException ? (
            <ExceptionPanel trade={trade} canResolve={can(ctx, 'exception:resolve')} canAdjust={can(ctx, 'adjustment:request')} />
          ) : trade ? (
            <PayoutPanel
              trade={trade}
              canCreate={can(ctx, 'settlement:create_payout')}
              canSend={can(ctx, 'settlement:send_payout') || can(ctx, 'settlement:record_route_payout_sent')}
              canRecord={can(ctx, 'settlement:record_utr')}
              canConfirm={can(ctx, 'settlement:confirm_payout')}
              canViewReceipt={can(ctx, 'receipt:view')}
              {...(section ? { focus: section } : {})}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
