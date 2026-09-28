'use client';

import { useState } from 'react';
import type { DeskBankView, DeskTraderDetail, DeskWalletView } from '@inrp2p/traders';
import { Button, StepUpMark } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  revealBankAccountAction, revealTraderPhoneAction, reviewDestinationAction, reviewSettlementChangeAction, setExchangeAccessAction,
} from '../../../../server/actions/traders-desk.ts';
import { PanelSection } from '../../_desk/ContextPanel.tsx';
import { TextArea } from '../../_desk/fields.tsx';
import { dateTime, inr, usdt } from '../../_desk/format.ts';
import { Chip, KeyValues, Notice } from '../../_desk/ui.tsx';
import type { TraderPerms } from './TraderControls.tsx';
import d from '../../_desk/desk.module.css';

const STATUS: Record<string, { word: string; tone: 'success' | 'warning' | 'muted' | 'danger' }> = {
  PENDING_REVIEW: { word: 'pending review', tone: 'warning' },
  ACTIVE: { word: 'verified', tone: 'success' },
  REJECTED: { word: 'rejected', tone: 'danger' },
  ARCHIVED: { word: 'archived', tone: 'muted' },
};
const EXPERIENCE: Record<string, string> = { BINANCE: 'Binance P2P', BYBIT: 'Bybit P2P', OTHER: 'Other P2P platform', NONE: 'None' };

function StatusTag({ status, note }: { status: string; note: string | null }) {
  const s = STATUS[status] ?? { word: status.toLowerCase(), tone: 'muted' as const };
  return (
    <span className={d.row}>
      <Chip tone={s.tone}>{s.word}</Chip>
      {note ? <span className={d.muted}>{note}</span> : null}
    </span>
  );
}

function BankFacts({ bank, revealed }: { bank: DeskBankView; revealed: string | null }) {
  return (
    <KeyValues
      items={[
        { label: 'Status', value: <StatusTag status={bank.status} note={bank.reviewNote} /> },
        { label: 'Holder', value: bank.holderName },
        { label: 'Bank', value: bank.bankName },
        { label: 'Account', value: <span className={d.mono}>{revealed ?? `••••${bank.last4}`}</span> },
        { label: 'IFSC', value: <span className={d.mono}>{bank.ifsc}</span> },
        { label: 'Rails', value: bank.rails.join(' · ') },
        { label: 'Submitted', value: dateTime(bank.submittedAt) },
        ...(bank.alsoOnFile.length > 0 ? [{ label: 'Also on file for', value: <Chip tone="warning">{bank.alsoOnFile.join(', ')}</Chip> }] : []),
      ]}
    />
  );
}

function WalletFacts({ wallet }: { wallet: DeskWalletView }) {
  return (
    <KeyValues
      items={[
        { label: 'Status', value: <StatusTag status={wallet.status} note={wallet.reviewNote} /> },
        { label: 'Address', value: <span className={d.mono}>{wallet.address}</span> },
        { label: 'Label', value: `${wallet.label} · ${wallet.purpose.toLowerCase()}` },
        { label: 'Submitted', value: dateTime(wallet.submittedAt) },
        ...(wallet.alsoOnFile.length > 0 ? [{ label: 'Also on file for', value: <Chip tone="warning">{wallet.alsoOnFile.join(', ')}</Chip> }] : []),
      ]}
    />
  );
}

/**
 * What an applicant submitted, and the desk's decisions on it — each one a command with its own audit event, none of
 * them asking the operator to type in what the trader already gave. The bank account and the wallet are verified or
 * rejected one at a time; the trader is approved (in the decision beside this) only once both are verified. For an
 * approved trader, a replacement it proposed is approved or rejected here, and approval waits until no order is
 * accepted or in progress.
 */
export function TraderReview({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const t = detail.trader;
  const a = detail.applicant;
  const [note, setNote] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const hasNote = note.trim().length >= 3;
  const underReview = t.status === 'UNDER_REVIEW';
  const approved = t.status === 'APPROVED' || t.status === 'PAUSED';
  const { bank: proposedBank, wallet: proposedWallet } = detail.proposal;
  const waitingChange = proposedBank?.status === 'PENDING_REVIEW' || proposedBank?.status === 'ACTIVE' || proposedWallet?.status === 'PENDING_REVIEW' || proposedWallet?.status === 'ACTIVE';
  const step = <StepUpMark label="needs your authenticator code" />;

  const reveal = async (bankAccountId: string) => {
    const out = await cmd.run('Reveal the bank account number', () => revealBankAccountAction({ bankAccountId }));
    if (out.ok) setRevealed((r) => ({ ...r, [bankAccountId]: out.result.accountNumber }));
  };
  const review = (destination: 'BANK' | 'WALLET', decision: 'VERIFY' | 'REJECT') =>
    cmd.run(`${decision === 'VERIFY' ? 'Verify' : 'Reject'} the submitted ${destination === 'BANK' ? 'bank account' : 'wallet'} of ${t.ref}`, (key) =>
      reviewDestinationAction({ traderId: t.traderId, destination, decision, note: note.trim() === '' ? null : note.trim() }, key),
    );
  const decideChange = (destination: 'BANK' | 'WALLET', decision: 'APPROVE' | 'REJECT') =>
    cmd.run(`${decision === 'APPROVE' ? 'Approve' : 'Reject'} the new ${destination === 'BANK' ? 'bank account' : 'wallet'} of ${t.ref}`, (key) =>
      reviewSettlementChangeAction({ traderId: t.traderId, destination, decision, note: note.trim() === '' ? null : note.trim() }, key),
    );

  const reviewButtons = (destination: 'BANK' | 'WALLET', status: string) =>
    underReview && perms.configure && status === 'PENDING_REVIEW' ? (
      <div className={d.actions}>
        <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy} onClick={() => review(destination, 'VERIFY')}>
          Verify
        </Button>
        <Button intent="ghost" size="sm" shortcut={step} disabled={cmd.busy || !hasNote} onClick={() => review(destination, 'REJECT')}>
          Reject
        </Button>
        {!hasNote ? <span className={d.fieldHint}>A rejection needs the note above.</span> : null}
      </div>
    ) : null;

  const changeButtons = (destination: 'BANK' | 'WALLET', status: string) =>
    approved && perms.configure && (status === 'PENDING_REVIEW' || status === 'ACTIVE') ? (
      <>
        <div className={d.actions}>
          <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy || t.openOrders > 0} onClick={() => decideChange(destination, 'APPROVE')}>
            Verify and switch
          </Button>
          <Button intent="ghost" size="sm" shortcut={step} disabled={cmd.busy || !hasNote} onClick={() => decideChange(destination, 'REJECT')}>
            Reject
          </Button>
        </div>
        {t.openOrders > 0 ? <p className={d.fieldHint}>{t.openOrders === 1 ? 'An order is' : `${t.openOrders} orders are`} in progress: they settle with the current details. Switch once they finish.</p> : null}
      </>
    ) : null;

  return (
    <div className={d.stack}>
      <PanelSection title="Applicant">
        <KeyValues
          items={[
            { label: 'Name', value: `${a.fullName} · ${a.entityType === 'COMPANY' ? 'company' : 'individual'} · ${a.clientRef}` },
            { label: 'Email', value: a.email ?? '—' },
            { label: 'Telegram', value: a.telegram ?? '—' },
            {
              label: 'Phone',
              value: (
                <span className={d.row}>
                  {a.phoneLast4 ? (phone ?? `••••${a.phoneLast4}`) : '—'}
                  {a.phoneLast4 && !phone && perms.configure ? (
                    <button
                      type="button"
                      className={d.linkButton}
                      onClick={async () => {
                        const out = await cmd.run('Reveal the applicant’s phone number', () => revealTraderPhoneAction({ traderId: t.traderId }));
                        if (out.ok) setPhone(out.result.phone);
                      }}
                    >
                      reveal
                    </button>
                  ) : null}
                </span>
              ),
            },
            { label: 'P2P experience', value: a.experience ? EXPERIENCE[a.experience] : '—' },
            { label: 'Profile', value: <span className={d.mono}>{a.profileLink ?? '—'}</span> },
            ...(t.typicalInr || a.dailyInr ? [{ label: 'INR typical / daily', value: `${t.typicalInr ? inr(t.typicalInr) : '—'} / ${a.dailyInr ? inr(a.dailyInr) : '—'}` }] : []),
            ...(t.typicalUsdt || a.dailyUsdt ? [{ label: 'USDT typical / daily', value: `${t.typicalUsdt ? usdt(t.typicalUsdt, { unit: false }) : '—'} / ${a.dailyUsdt ? usdt(a.dailyUsdt) : '—'}` }] : []),
            { label: 'Owns the details', value: a.ownershipConfirmedAt ? `confirmed ${dateTime(a.ownershipConfirmedAt)}` : 'not recorded' },
            { label: 'Exchange', value: a.exchangeAccess ? 'open (a client of the desk)' : 'closed (trader only)' },
          ]}
        />
        <TextArea label="Note (the trader sees a rejection note)" value={note} onChange={setNote} />
        {!a.exchangeAccess && approved && perms.configure ? (
          <div className={d.actions}>
            <Button
              intent="ghost"
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !hasNote}
              onClick={() => cmd.run(`Open the Exchange for ${a.clientRef}`, (key) => setExchangeAccessAction({ clientId: t.clientId, exchangeAccess: true, reason: note.trim() }, key))}
            >
              Open the Exchange for this client
            </Button>
          </div>
        ) : null}
      </PanelSection>

      <PanelSection title={underReview ? 'Submitted bank account' : 'Registered bank account'}>
        <BankFacts bank={detail.bank} revealed={revealed[detail.bank.bankAccountId] ?? null} />
        {perms.reveal && !revealed[detail.bank.bankAccountId] ? (
          <div className={d.actions}>
            <Button intent="ghost" size="sm" shortcut={step} onClick={() => void reveal(detail.bank.bankAccountId)}>
              Reveal account number
            </Button>
          </div>
        ) : null}
        {reviewButtons('BANK', detail.bank.status)}
      </PanelSection>

      <PanelSection title={underReview ? 'Submitted TRC20 wallet' : 'Registered TRC20 wallet'}>
        <WalletFacts wallet={detail.wallet} />
        {reviewButtons('WALLET', detail.wallet.status)}
      </PanelSection>

      {approved && (proposedBank || proposedWallet) ? (
        <PanelSection title={`Proposed by the trader${waitingChange ? ' · waiting for review' : ''}`}>
          <Notice>The registered details keep settling every order until a change is approved.</Notice>
          {proposedBank ? (
            <div className={d.stackTight}>
              <span className={d.fieldLabel}>New bank account</span>
              <BankFacts bank={proposedBank} revealed={revealed[proposedBank.bankAccountId] ?? null} />
              {perms.reveal && !revealed[proposedBank.bankAccountId] ? (
                <div className={d.actions}>
                  <Button intent="ghost" size="sm" shortcut={step} onClick={() => void reveal(proposedBank.bankAccountId)}>
                    Reveal account number
                  </Button>
                </div>
              ) : null}
              {changeButtons('BANK', proposedBank.status)}
            </div>
          ) : null}
          {proposedWallet ? (
            <div className={d.stackTight}>
              <span className={d.fieldLabel}>New TRC20 wallet</span>
              <WalletFacts wallet={proposedWallet} />
              {changeButtons('WALLET', proposedWallet.status)}
            </div>
          ) : null}
        </PanelSection>
      ) : null}

      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
