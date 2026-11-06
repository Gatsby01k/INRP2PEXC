import type { DeskLeg, DeskTrade } from '@inrp2p/desk';
import { CopyButton } from '@inrp2p/ui';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { money, time } from '../_desk/format.ts';
import { LegStatusChip, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

const whose = (leg: DeskLeg, buy: boolean): string => {
  if (leg.side === 'REFUND_TO_CLIENT') return 'Back to the client';
  if (leg.asset === 'USDT') return leg.side === 'CLIENT_TO_EXCHANGE' ? 'From the client' : 'Released to the client';
  return buy ? 'Client to the trader' : 'Trader to the client';
};

function Leg({ leg, buy }: { leg: DeskLeg; buy: boolean }) {
  return (
    <li className={t.leg} {...(leg.status === 'FAILED' || leg.status === 'CANCELLED' ? { 'data-dim': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>{money(leg.amount, leg.asset, { exact: leg.asset === 'USDT' })}</span>
        <LegStatusChip status={leg.status} />
      </div>
      <div className={t.legMeta}>
        <span>{whose(leg, buy)}</span>
        <span>{leg.ref}</span>
        {leg.reference ? <span className={d.mono}>{leg.referenceKind === 'TX' ? `tx ${shortenHash(leg.reference)}` : `UTR ${maskUtr(leg.reference)}`}</span> : null}
        <span>{leg.confirmedAt ? `confirmed ${time(leg.confirmedAt)}` : leg.sentAt ? `sent ${time(leg.sentAt)}` : `seen ${time(leg.createdAt)}`}</span>
      </div>
      {leg.failureReason ? <Notice tone="danger">{leg.failureReason}</Notice> : null}
    </li>
  );
}

/**
 * A P2P deal's money as it stands (ADR 0019): the USDT in the deal's escrow and the rupees straight between client and
 * trader. Nothing here is the desk's to move. The chain confirms the USDT, the signer releases it, and the two sides confirm
 * the rupees; what INRP2P does decide — a payment disputed or unanswered — is the panel above this one.
 */
export function P2pMoney({ trade }: { trade: DeskTrade }) {
  const buy = trade.direction === 'BUY_USDT';
  const escrow = trade.deposit?.address ?? trade.funding.places.find((p) => p.asset === 'USDT' && p.address)?.address ?? null;
  const usdtLegs = trade.legs.filter((l) => l.asset === 'USDT');
  const rupeeLegs = trade.legs.filter((l) => l.asset === 'INR');
  const inr = money(trade.quoteInr, 'INR');
  return (
    <>
      <PanelSection title="USDT in escrow" aside={`${money(trade.base, 'USDT', { exact: true })} · ${buy ? 'the trader funds it' : 'the client funds it'}`} testId="p2p-escrow">
        {escrow ? (
          <div className={t.address}>
            <span className={t.addressValue}>{escrow}</span>
            <CopyButton value={escrow} label="deal address" />
          </div>
        ) : (
          <Notice icon="clock">{buy ? 'The trader has not taken its delivery address yet.' : 'No deal address yet.'}</Notice>
        )}
        {usdtLegs.length > 0 ? (
          <ul className={t.legs}>
            {usdtLegs.map((leg) => (
              <Leg key={leg.id} leg={leg} buy={buy} />
            ))}
          </ul>
        ) : null}
      </PanelSection>
      <PanelSection title="Rupees" aside={`${inr} · ${buy ? 'the client pays the trader' : 'the trader pays the client'}`} testId="p2p-rupees">
        {rupeeLegs.length > 0 ? (
          <ul className={t.legs}>
            {rupeeLegs.map((leg) => (
              <Leg key={leg.id} leg={leg} buy={buy} />
            ))}
          </ul>
        ) : (
          <Notice icon="clock">Nothing said to be sent yet.</Notice>
        )}
      </PanelSection>
    </>
  );
}
