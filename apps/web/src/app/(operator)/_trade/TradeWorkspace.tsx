import Link from 'next/link';
import type { DeskTrade } from '@inrp2p/desk';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { Icon } from '../_desk/icons.tsx';
import { Notice } from '../_desk/ui.tsx';
import { CaseCard } from './Cases.tsx';
import { ClientFunds, type CollectionAccount } from './ClientFunds.tsx';
import { Payouts } from './Payouts.tsx';
import { Economics, Headline, Stages } from './Summary.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';

/**
 * One trade, worked from the desk's side panel: what was agreed, how far it has got, and the blocks that move it —
 * ordered by what the trade needs next. A trade on hold leads with its case (nothing else can move until it is
 * resolved); one waiting for the client leads with the client's funds; one being paid leads with the payout.
 */
export function TradeWorkspace({
  trade,
  perms,
  focus,
  collectionAccounts,
  record,
}: {
  trade: DeskTrade;
  perms: TradePerms;
  focus?: string;
  collectionAccounts: readonly CollectionAccount[];
  /** On the full record the headline is in the page header; in the panel it leads. */
  record?: boolean;
}) {
  const waitingForClient = trade.lifecycle === 'AWAITING_FIRST_LEG' || trade.lifecycle === 'FIRST_LEG_DETECTED';
  const cases =
    trade.cases.length > 0 ? (
      <PanelSection title="Exceptions" aside={`${trade.cases.length} open`} testId="exceptions">
        <div className={d.stackTight}>
          {trade.cases.map((c) => (
            <CaseCard key={c.id} c={c} perms={perms} trade={trade} />
          ))}
        </div>
      </PanelSection>
    ) : null;
  const funds = <ClientFunds trade={trade} perms={perms} collectionAccounts={collectionAccounts} />;
  const payouts = <Payouts trade={trade} perms={perms} {...(focus ? { focus } : {})} />;

  return (
    <div className={d.stack} data-testid="trade-workspace">
      {record ? null : (
        <PanelSection>
          <Headline trade={trade} />
          <Stages trade={trade} />
          {perms.economics ? <Economics trade={trade} realized={trade.lifecycle === 'COMPLETED'} compact /> : null}
        </PanelSection>
      )}
      {focus === 'exception' || trade.hold ? cases : null}
      {waitingForClient ? (
        <>
          {funds}
          {payouts}
        </>
      ) : (
        <>
          {payouts}
          {funds}
        </>
      )}
      {focus === 'exception' || trade.hold ? null : cases}
      {record ? null : (
        <Notice icon="arrowUpRight">
          Cancel, refund, adjustments, the receipt and the full history are on the <Link href={`/orders/${encodeURIComponent(trade.ref)}`}>trade record</Link>.
        </Notice>
      )}
      {trade.receipt && perms.receipt && !record ? (
        <a className={d.linkButton} href={`/api/receipts/${encodeURIComponent(trade.ref)}`} target="_blank" rel="noreferrer">
          <Icon name="external" size={12} />
          Settlement receipt
        </a>
      ) : null}
    </div>
  );
}
