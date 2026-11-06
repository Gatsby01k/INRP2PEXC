import Link from 'next/link';
import type { DeskTrade } from '@inrp2p/desk';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { Icon } from '../_desk/icons.tsx';
import { Notice } from '../_desk/ui.tsx';
import { CaseCard } from './Cases.tsx';
import { DeskDealChat } from './DealChat.tsx';
import { Destination } from './Destination.tsx';
import { TradeNetwork } from './Network.tsx';
import { P2pMoney } from './P2pMoney.tsx';
import { P2pPayment } from './P2pPayment.tsx';
import { Economics, Headline, Stages } from './Summary.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';

/**
 * One deal, from the desk's side panel: what was agreed, how far it has got, and what INRP2P can still do about it. A
 * deal moves by its client, its trader and the chain; a person steps in on a dispute, a case or a refund.
 */
export function TradeWorkspace({
  trade,
  perms,
  focus,
  record,
}: {
  trade: DeskTrade;
  perms: TradePerms;
  focus?: string;
  /** On the full record the headline is in the page header; in the panel it leads. */
  record?: boolean;
}) {
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

  return (
    <div className={d.stack} data-testid="trade-workspace">
      {record ? null : (
        <PanelSection>
          <Headline trade={trade} />
          <Stages trade={trade} />
          {perms.economics ? <Economics trade={trade} realized={trade.lifecycle === 'COMPLETED'} compact /> : null}
        </PanelSection>
      )}
      {/* A P2P payment waiting for INRP2P's decision leads: nothing else on the deal can move until it is decided. */}
      <P2pPayment trade={trade} perms={perms} />
      {/* ADR 0023: the deal's own chat — first when a side called support and nobody answered yet. */}
      <DeskDealChat trade={trade} perms={perms} />
      {focus === 'exception' || trade.hold ? cases : null}
      {trade.lifecycle !== 'COMPLETED' && trade.lifecycle !== 'CANCELLED' ? <Destination trade={trade} perms={perms} /> : null}
      <P2pMoney trade={trade} />
      <TradeNetwork trade={trade} perms={perms} />
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
