'use client';

import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, StepUpMark } from '@inrp2p/ui';
import { BankMark, UsdtOnTron } from '../../../../components/PayMarks.tsx';
import { useCommand } from '../../../../components/useCommand.tsx';
import { reviewSettlementChangeAction } from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { dateTime } from '../../_desk/format.ts';
import { Icon } from '../../_desk/icons.tsx';
import { bookStyles as b, shortAddress } from '../../_book/parts.tsx';
import type { TraderPerms } from '../words.tsx';
import { BankFacts, DetailChip, WalletFacts, useReveal } from './Profile.tsx';
import d from '../../_desk/desk.module.css';

const step = <StepUpMark label="needs your authenticator code" />;

/**
 * New settlement details the trader proposed, above everything else on its page because they wait for a decision. The
 * registered details keep settling every order until a change is approved; approving waits until no order is accepted or
 * in progress. A rejection's note is what the trader reads.
 */
export function Proposal({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const { cmd: revealCmd, revealed, reveal } = useReveal();
  const t = detail.trader;
  const { bank, wallet, effectiveAt } = detail.proposal;
  const decide = (destination: 'BANK' | 'WALLET', decision: 'APPROVE' | 'REJECT', note: string | null) =>
    cmd.run(`${decision === 'APPROVE' ? 'Approve' : 'Reject'} the new ${destination === 'BANK' ? 'bank account' : 'wallet'} of ${t.ref}`, (key) =>
      reviewSettlementChangeAction({ traderId: t.traderId, destination, decision, note }, key),
    );
  const answers = (destination: 'BANK' | 'WALLET', status: string) =>
    perms.configure && (status === 'PENDING_REVIEW' || status === 'ACTIVE') ? (
      <div className={d.actions}>
        <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy || t.openOrders > 0} onClick={() => void decide(destination, 'APPROVE', null)}>
          Verify and switch
        </Button>
        <GuardedAction
          label="Reject"
          trigger="ghost"
          tone="danger"
          stepUp
          busy={cmd.busy}
          reasonLabel="Why — the trader reads this"
          consequence="The proposal is closed; the registered details keep settling every order."
          onConfirm={async (note) => (await decide(destination, 'REJECT', note)).ok}
        />
      </div>
    ) : null;

  return (
    <section className={b.attention} aria-label="Proposed by the trader">
      <div className={b.attentionHead}>
        <span className={b.glyph} data-tone="brand">
          <Icon name="flag" size={14} />
        </span>
        <strong>New settlement details proposed</strong>
        <span>
          The registered details keep settling every order until this is decided.
          {effectiveAt ? ` Every member was told; it can take effect from ${dateTime(effectiveAt)}${detail.program.autoReview ? ', when the rules apply it between orders' : ''}.` : ''}
        </span>
      </div>
      <div className={b.attentionBody}>
        {bank ? (
          <div className={b.reviewGrid}>
            <div className={d.stackTight}>
              <span className={b.eyebrow} style={{ color: 'var(--text-muted)' }}>
                Now · settles every order
              </span>
              <span className={b.who}>
                <BankMark ifsc={detail.bank.ifsc} name={detail.bank.bankName} size={36} />
                <span className={b.whoText}>
                  <span className={b.whoName}>
                    {detail.bank.bankName} <span className={b.addr}>••••{detail.bank.last4}</span>
                  </span>
                  <span className={b.whoSub}>
                    {detail.bank.holderName} · {detail.bank.ifsc}
                  </span>
                </span>
              </span>
            </div>
            <div className={d.stackTight}>
              <span className={b.eyebrow} style={{ color: 'var(--brand-action)' }}>
                Proposed · new bank account
              </span>
              <span className={b.who}>
                <BankMark ifsc={bank.ifsc} name={bank.bankName} size={36} />
                <span className={b.whoText}>
                  <span className={b.whoName}>{bank.bankName}</span>
                  <span className={b.whoSub}>{bank.holderName}</span>
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <DetailChip status={bank.status} />
                </span>
              </span>
              <BankFacts bank={bank} revealed={revealed[bank.bankAccountId] ?? null} onReveal={perms.reveal ? () => void reveal(bank.bankAccountId) : null} />
              {answers('BANK', bank.status)}
            </div>
          </div>
        ) : null}
        {wallet ? (
          <div className={b.reviewGrid}>
            <div className={d.stackTight}>
              <span className={b.eyebrow} style={{ color: 'var(--text-muted)' }}>
                Now · settles every order
              </span>
              <span className={b.who}>
                <UsdtOnTron size={36} />
                <span className={b.whoText}>
                  <span className={b.whoName}>{detail.wallet.label}</span>
                  <span className={`${b.whoSub} ${b.addr}`}>{shortAddress(detail.wallet.address)}</span>
                </span>
              </span>
            </div>
            <div className={d.stackTight}>
              <span className={b.eyebrow} style={{ color: 'var(--brand-action)' }}>
                Proposed · new TRC20 wallet
              </span>
              <span className={b.who}>
                <UsdtOnTron size={36} />
                <span className={b.whoText}>
                  <span className={b.whoName}>{wallet.label}</span>
                  <span className={b.whoSub}>USDT on TRON</span>
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <DetailChip status={wallet.status} />
                </span>
              </span>
              <WalletFacts wallet={wallet} />
              {answers('WALLET', wallet.status)}
            </div>
          </div>
        ) : null}
        {t.openOrders > 0 ? (
          <p className={d.fieldHint}>
            {t.openOrders === 1 ? 'An order is' : `${t.openOrders} orders are`} in progress: they settle with the current details. Switch once they finish.
          </p>
        ) : null}
        {cmd.error ?? revealCmd.error ? (
          <p className={d.errorLine} role="alert">
            {cmd.error ?? revealCmd.error}
          </p>
        ) : null}
        {cmd.dialog}
        {revealCmd.dialog}
      </div>
    </section>
  );
}
