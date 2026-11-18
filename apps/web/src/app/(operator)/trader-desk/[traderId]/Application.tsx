'use client';

import { useState, type ReactNode } from 'react';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, StepUpMark } from '@inrp2p/ui';
import { BankMark, UsdtOnTron } from '../../../../components/PayMarks.tsx';
import { useCommand } from '../../../../components/useCommand.tsx';
import { approveTraderAction, rejectTraderAction, reviewDestinationAction } from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { TextField } from '../../_desk/fields.tsx';
import { dateTime, plainDecimal } from '../../_desk/format.ts';
import { Icon } from '../../_desk/icons.tsx';
import { Notice } from '../../_desk/ui.tsx';
import { Sheet, bookStyles as b } from '../../_book/parts.tsx';
import { AUTO_FLAG, type TraderPerms } from '../words.tsx';
import { BankFacts, DetailChip, WalletFacts, useReveal } from './Profile.tsx';
import d from '../../_desk/desk.module.css';

const blank = (v: string) => (v.trim() === '' ? null : v.trim());
const step = <StepUpMark label="needs your authenticator code" />;

/** One submitted detail as a card: what it is, its facts, and its two answers. */
function ReviewCard({ mark, title, sub, status, children, foot }: { mark: ReactNode; title: string; sub: string; status: string; children: ReactNode; foot: ReactNode }) {
  return (
    <section className={b.review} data-state={status === 'PENDING_REVIEW' ? 'pending' : status === 'ACTIVE' ? 'done' : 'other'} aria-label={sub}>
      <div className={b.reviewHead}>
        {mark}
        <span className={b.reviewTitle}>
          <strong>{title}</strong>
          <span>{sub}</span>
        </span>
        {status === 'PENDING_REVIEW' ? null : <DetailChip status={status} />}
      </div>
      <div className={b.reviewBody}>{children}</div>
      {foot ? <div className={b.reviewFoot}>{foot}</div> : null}
    </section>
  );
}

/**
 * An application, as the job it is: the bank account and the wallet the applicant submitted, each verified or rejected on
 * its own (a rejection's note is what the applicant reads), then the decision — approve on the terms below, or reject the
 * application. Approval waits for both details; nothing here asks the operator to type what the trader already gave.
 */
export function ApplicationReview({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const { cmd: revealCmd, revealed, reveal } = useReveal();
  const t = detail.trader;
  const underReview = t.status === 'UNDER_REVIEW';
  const [reserve, setReserve] = useState(plainDecimal(detail.reserve.required ?? detail.program.defaultRequiredReserve));
  const [maxOrderInr, setMaxOrderInr] = useState(plainDecimal(t.limits.maxOrderInr));
  const [maxOrderUsdt, setMaxOrderUsdt] = useState(plainDecimal(t.limits.maxOrderUsdt));
  const [maxCapInr, setMaxCapInr] = useState(plainDecimal(t.limits.maxCapacityInr));
  const [maxCapUsdt, setMaxCapUsdt] = useState(plainDecimal(t.limits.maxCapacityUsdt));
  const verified = detail.bank.status === 'ACTIVE' && detail.wallet.status === 'ACTIVE';
  const flags = detail.autoReview.flags;

  const review = (destination: 'BANK' | 'WALLET', decision: 'VERIFY' | 'REJECT', note: string | null) =>
    cmd.run(`${decision === 'VERIFY' ? 'Verify' : 'Reject'} the submitted ${destination === 'BANK' ? 'bank account' : 'wallet'} of ${t.ref}`, (key) =>
      reviewDestinationAction({ traderId: t.traderId, destination, decision, note }, key),
    );

  const answers = (destination: 'BANK' | 'WALLET', status: string) =>
    underReview && perms.configure && status === 'PENDING_REVIEW' ? (
      <>
        <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy} onClick={() => void review(destination, 'VERIFY', null)}>
          Verify
        </Button>
        <GuardedAction
          label="Reject"
          trigger="ghost"
          tone="danger"
          stepUp
          busy={cmd.busy}
          reasonLabel="Why — the applicant reads this"
          consequence={`The ${destination === 'BANK' ? 'bank account' : 'wallet'} is rejected and the applicant is told why; they can submit another.`}
          onConfirm={async (note) => (await review(destination, 'REJECT', note)).ok}
        />
      </>
    ) : status === 'ACTIVE' ? (
      <span className={b.sideNote}>
        <Icon name="check" size={12} />
        Verified — usable once the trader is approved.
      </span>
    ) : null;

  return (
    <>
      {detail.program.autoReview && underReview ? (
        <Notice icon={flags.length > 0 ? 'flag' : 'shield'} {...(flags.length > 0 ? { tone: 'warning' as const } : {})}>
          {flags.length > 0
            ? `The programme’s rules left this for a person: ${flags.map((f) => AUTO_FLAG[f] ?? f).join('; ')}.`
            : 'The programme’s rules approve this as soon as the trader’s reserve lands from its wallet; nothing is needed from the desk.'}
          {detail.autoReview.reviewedAt ? ` Checked ${dateTime(detail.autoReview.reviewedAt)}.` : ''}
        </Notice>
      ) : null}

      <div className={b.reviewGrid}>
        <ReviewCard mark={<BankMark ifsc={detail.bank.ifsc} name={detail.bank.bankName} size={40} />} title={detail.bank.bankName} sub="Submitted bank account" status={detail.bank.status} foot={answers('BANK', detail.bank.status)}>
          <BankFacts bank={detail.bank} revealed={revealed[detail.bank.bankAccountId] ?? null} onReveal={perms.reveal ? () => void reveal(detail.bank.bankAccountId) : null} />
        </ReviewCard>
        <ReviewCard mark={<UsdtOnTron size={40} />} title={detail.wallet.label} sub="Submitted TRC20 wallet" status={detail.wallet.status} foot={answers('WALLET', detail.wallet.status)}>
          <WalletFacts wallet={detail.wallet} />
        </ReviewCard>
      </div>

      {underReview && perms.configure ? (
        <Sheet title="Decision" hint="Approve on these terms, or reject the application with a note the applicant reads." label="Decision">
          <div className={b.grid2}>
            <TextField label="Security Reserve (USDT)" value={reserve} onChange={setReserve} placeholder="Required" hint="The programme’s default unless changed." />
            <p className={d.fieldHint} style={{ alignSelf: 'center', margin: 0 }}>
              Ceilings below are optional — the trader’s own limits and the reserve-based ones apply under them.
            </p>
            <TextField label="Max order ₹" value={maxOrderInr} onChange={setMaxOrderInr} placeholder="No ceiling" />
            <TextField label="Max order USDT" value={maxOrderUsdt} onChange={setMaxOrderUsdt} placeholder="No ceiling" />
            <TextField label="Max capacity ₹" value={maxCapInr} onChange={setMaxCapInr} placeholder="No ceiling" />
            <TextField label="Max capacity USDT" value={maxCapUsdt} onChange={setMaxCapUsdt} placeholder="No ceiling" />
          </div>
          {verified ? null : (
            <p className={b.gap}>
              <Icon name="flag" size={12} />
              Verify the bank account and the wallet first — approval waits for both.
            </p>
          )}
          <div className={d.actions}>
            <Button
              intent="primary"
              shortcut={step}
              disabled={cmd.busy || blank(reserve) === null || !verified}
              onClick={() =>
                cmd.run(`Approve ${t.ref}`, (key) =>
                  approveTraderAction(
                    { traderId: t.traderId, requiredReserve: blank(reserve), maxOrderInr: blank(maxOrderInr), maxOrderUsdt: blank(maxOrderUsdt), maxCapacityInr: blank(maxCapInr), maxCapacityUsdt: blank(maxCapUsdt), note: null },
                    key,
                  ),
                )
              }
            >
              Approve trader
            </Button>
            <GuardedAction
              label="Reject application"
              trigger="ghost"
              tone="danger"
              stepUp
              size="md"
              busy={cmd.busy}
              reasonLabel="Note to the applicant — they see it"
              consequence="The application is closed and the applicant is told why. They can apply again."
              onConfirm={async (note) => (await cmd.run(`Reject ${t.ref}`, (key) => rejectTraderAction({ traderId: t.traderId, note }, key))).ok}
            />
          </div>
        </Sheet>
      ) : null}

      {cmd.error ?? revealCmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error ?? revealCmd.error}
        </p>
      ) : null}
      {cmd.dialog}
      {revealCmd.dialog}
    </>
  );
}
