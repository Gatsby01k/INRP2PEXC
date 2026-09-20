import { deskTrade, listOrders } from '@inrp2p/desk';
import type { OrderFilter } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { ExceptionPanel } from '../../../components/panels/ExceptionPanel.tsx';
import { PayoutPanel } from '../../../components/panels/PayoutPanel.tsx';
import { OrdersTable } from './OrdersTable.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

const STATES = new Set(['OPEN', 'COMPLETED', 'CANCELLED', 'ALL']);

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const state = typeof params.state === 'string' && STATES.has(params.state) ? (params.state as OrderFilter['state']) : 'OPEN';
  const tradeId = typeof params.trade === 'string' ? params.trade : undefined;

  const rows = await listOrders(ctx.db, ctx.access, { state: state ?? 'OPEN', limit: 200 });
  const trade = tradeId ? await deskTrade(ctx.db, tradeId, ctx.access) : null;

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>Orders</h1>
      </header>
      <div className={styles.content}>
        <div className={trade ? styles.withPanel : ''}>
          <OrdersTable rows={rows} state={state ?? 'OPEN'} economics={ctx.access.economics} />
          {trade && trade.hold ? (
            <ExceptionPanel trade={trade} canResolve={can(ctx, 'exception:resolve')} canAdjust={can(ctx, 'adjustment:request')} />
          ) : trade ? (
            <PayoutPanel
              trade={trade}
              canCreate={can(ctx, 'settlement:create_payout')}
              canSend={can(ctx, 'settlement:send_payout') || can(ctx, 'settlement:record_route_payout_sent')}
              canRecord={can(ctx, 'settlement:record_utr')}
              canConfirm={can(ctx, 'settlement:confirm_payout')}
              canViewReceipt={can(ctx, 'receipt:view')}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
