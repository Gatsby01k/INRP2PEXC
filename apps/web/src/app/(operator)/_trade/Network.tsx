import Link from 'next/link';
import type { DeskTrade } from '@inrp2p/desk';
import { CopyButton } from '@inrp2p/ui';
import { shortenAddress, shortenHash } from '@inrp2p/ui/format';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { inr } from '../_desk/format.ts';
import { ATTEMPT, PURPOSE, STATUS, trx } from '../_desk/network.ts';
import { Chip, KeyValues, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

/**
 * A trade's side of the exchange's own rails (ADR 0017): whose TRX pays its transfers, what it holds and spent, the
 * network fee its client's price carried against what the network actually cost (economics viewers only), and each
 * transfer the signer makes for it with its transactions. Approving and unblocking happen on the Network page.
 */
export function TradeNetwork({ trade }: { trade: DeskTrade }) {
  const n = trade.network;
  if (!n) return null;
  const open = n.sends.filter((s) => s.status !== 'CONFIRMED' && s.status !== 'CANCELLED');
  const attention = open.some((s) => s.status === 'BLOCKED' || s.status === 'AWAITING_APPROVAL');
  return (
    <PanelSection title="Network" aside={n.holdStatus === 'ACTIVE' ? `${trx(n.heldTrx)} held` : n.holdStatus === 'CLOSED' ? 'settled' : undefined} testId="trade-network">
      <div className={d.stackTight}>
        <KeyValues
          split
          label="Network budget"
          items={[
            { label: 'TRX from', value: n.funder === 'Platform' ? 'Platform budget' : `${n.funder}’s network deposit` },
            { label: 'Held for its transfers', value: trx(n.heldTrx) },
            { label: 'Spent so far', value: /[1-9]/.test(n.traderBorneTrx) ? `${trx(n.spentTrx)} · ${trx(n.traderBorneTrx)} the trader’s` : trx(n.spentTrx) },
            ...(n.reimbursed !== null ? [{ label: 'Paid back to the trader', value: inr(n.reimbursed) }] : []),
            ...(n.economics
              ? [
                  ...(/[1-9]/.test(n.economics.reward) ? [{ label: 'Trader’s reward', value: inr(n.economics.reward) }] : []),
                  { label: 'Network fee in the price', value: `${inr(n.economics.feeCharged)} · ${trx(n.economics.feeChargedTrx)}` },
                  { label: 'Network cost', value: inr(n.economics.spentInr) },
                  {
                    label: n.economics.netFinal ? 'Net: margin − reward − network' : 'Net expected: margin − reward − fee',
                    value: n.economics.netProfit.startsWith('-') ? <Chip tone="danger">{inr(n.economics.netProfit)}</Chip> : inr(n.economics.netProfit),
                    strong: true,
                  },
                ]
              : []),
          ]}
        />
        {n.sends.length > 0 ? (
          <ul className={t.legs} aria-label="Signer transfers">
            {n.sends.map((s) => {
              const live = [...s.attempts].reverse().find((a) => a.status !== 'EXPIRED' && a.status !== 'FAILED') ?? s.attempts.at(-1);
              return (
                <li key={s.id} className={t.leg} {...(s.status === 'BLOCKED' || s.status === 'AWAITING_APPROVAL' ? { 'data-attention': '' } : {})}>
                  <div className={t.legHead}>
                    <span className={t.legAmount}>
                      {PURPOSE[s.purpose] ?? s.purpose} · {s.amount}
                    </span>
                    <Chip tone={STATUS[s.status]?.tone ?? 'neutral'}>{STATUS[s.status]?.label ?? s.status}</Chip>
                  </div>
                  <div className={t.legMeta}>
                    <span className={d.mono}>{s.ref}</span>
                    <span>to {shortenAddress(s.to)}</span>
                    {live ? (
                      <span>
                        <Chip tone={ATTEMPT[live.status] ?? 'neutral'}>{live.status.toLowerCase()}</Chip> <span className={d.mono}>{shortenHash(live.txid)}</span> <CopyButton value={live.txid} label="transaction hash" />
                        {live.burned ? ` · ${trx(live.burned)} burned` : ''}
                      </span>
                    ) : null}
                  </div>
                  {s.blockedReason ? <Notice tone="danger" icon="lock">{s.blockedReason}</Notice> : s.lastError && s.status !== 'CONFIRMED' ? <Notice tone="warning">{s.lastError}</Notice> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {attention ? (
          <Notice icon="arrowUpRight">
            A transfer needs a person: approve or unblock it on the <Link href="/network">Network page</Link>.
          </Notice>
        ) : null}
      </div>
    </PanelSection>
  );
}
