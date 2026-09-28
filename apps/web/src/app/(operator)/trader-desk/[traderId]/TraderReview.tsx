'use client';

import { useState } from 'react';
import type { DeskBankView, DeskTraderDetail, DeskWalletView } from '@inrp2p/traders';
import { Button } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  revealBankAccountAction, revealTraderPhoneAction, reviewDestinationAction, reviewSettlementChangeAction, setExchangeAccessAction,
} from '../../../../server/actions/traders-desk.ts';
import type { TraderPerms } from './TraderControls.tsx';
import styles from '../traders.module.css';

const STATUS: Record<string, { word: string; tone?: 'good' | 'warn' | 'brand' }> = {
  PENDING_REVIEW: { word: 'pending review', tone: 'warn' },
  ACTIVE: { word: 'verified', tone: 'good' },
  REJECTED: { word: 'rejected' },
  ARCHIVED: { word: 'archived' },
};
const EXPERIENCE: Record<string, string> = { BINANCE: 'Binance P2P', BYBIT: 'Bybit P2P', OTHER: 'Other P2P platform', NONE: 'None' };

function StatusTag({ status }: { status: string }) {
  const s = STATUS[status] ?? { word: status.toLowerCase() };
  return (
    <span className={styles.tag} {...(s.tone ? { 'data-tone': s.tone } : {})}>
      {s.word}
    </span>
  );
}

function BankFacts({ bank, revealed }: { bank: DeskBankView; revealed: string | null }) {
  return (
    <dl className={styles.facts}>
      <dt>Status</dt>
      <dd>
        <StatusTag status={bank.status} />
        {bank.reviewNote ? <span className="ix-muted"> · {bank.reviewNote}</span> : null}
      </dd>
      <dt>Holder</dt>
      <dd>{bank.holderName}</dd>
      <dt>Bank</dt>
      <dd>{bank.bankName}</dd>
      <dt>Account</dt>
      <dd className={styles.mono}>{revealed ?? `••••${bank.last4}`}</dd>
      <dt>IFSC</dt>
      <dd className={styles.mono}>{bank.ifsc}</dd>
      <dt>Rails</dt>
      <dd>{bank.rails.join(' · ')}</dd>
      <dt>Submitted</dt>
      <dd>{formatIstDateTime(new Date(bank.submittedAt))}</dd>
      {bank.alsoOnFile.length > 0 ? (
        <>
          <dt>Also on file for</dt>
          <dd>
            <span className={styles.tag} data-tone="warn">
              {bank.alsoOnFile.join(', ')}
            </span>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function WalletFacts({ wallet }: { wallet: DeskWalletView }) {
  return (
    <dl className={styles.facts}>
      <dt>Status</dt>
      <dd>
        <StatusTag status={wallet.status} />
        {wallet.reviewNote ? <span className="ix-muted"> · {wallet.reviewNote}</span> : null}
      </dd>
      <dt>Address</dt>
      <dd className={styles.mono}>{wallet.address}</dd>
      <dt>Label</dt>
      <dd>
        {wallet.label} · {wallet.purpose.toLowerCase()}
      </dd>
      <dt>Submitted</dt>
      <dd>{formatIstDateTime(new Date(wallet.submittedAt))}</dd>
      {wallet.alsoOnFile.length > 0 ? (
        <>
          <dt>Also on file for</dt>
          <dd>
            <span className={styles.tag} data-tone="warn">
              {wallet.alsoOnFile.join(', ')}
            </span>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * What an applicant submitted, and the desk's decisions on it — each one a command with its own audit event, none of
 * them asking the operator to type in what the trader already gave. The bank account and the wallet are verified or
 * rejected one at a time; the trader is approved (in the controls beside this) only once both are verified. For an
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
  const waitingChange = (proposedBank?.status === 'PENDING_REVIEW' || proposedBank?.status === 'ACTIVE') || (proposedWallet?.status === 'PENDING_REVIEW' || proposedWallet?.status === 'ACTIVE');

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
      <div className="ix-row">
        <Button intent="primary" disabled={cmd.busy} onClick={() => review(destination, 'VERIFY')}>
          Verify
        </Button>
        <Button intent="ghost" disabled={cmd.busy || !hasNote} onClick={() => review(destination, 'REJECT')}>
          Reject
        </Button>
      </div>
    ) : null;

  const changeButtons = (destination: 'BANK' | 'WALLET', status: string) =>
    approved && perms.configure && (status === 'PENDING_REVIEW' || status === 'ACTIVE') ? (
      <>
        <div className="ix-row">
          <Button intent="primary" disabled={cmd.busy || t.openOrders > 0} onClick={() => decideChange(destination, 'APPROVE')}>
            Verify and switch
          </Button>
          <Button intent="ghost" disabled={cmd.busy || !hasNote} onClick={() => decideChange(destination, 'REJECT')}>
            Reject
          </Button>
        </div>
        {t.openOrders > 0 ? <span className="ix-hint">{t.openOrders === 1 ? 'An order is' : `${t.openOrders} orders are`} in progress: they settle with the current details. Switch once they finish.</span> : null}
      </>
    ) : null;

  return (
    <>
      <section className="ix-card" aria-label="Applicant">
        <h2 className="ix-sectionTitle">Applicant</h2>
        <dl className={styles.facts}>
          <dt>Name</dt>
          <dd>
            {a.fullName} · {a.entityType === 'COMPANY' ? 'company' : 'individual'} · {a.clientRef}
          </dd>
          <dt>Email</dt>
          <dd>{a.email ?? '—'}</dd>
          <dt>Telegram</dt>
          <dd>{a.telegram ?? '—'}</dd>
          <dt>Phone</dt>
          <dd>
            {a.phoneLast4 ? (phone ?? `••••${a.phoneLast4}`) : '—'}
            {a.phoneLast4 && !phone && perms.configure ? (
              <>
                {' '}
                <button
                  type="button"
                  className="ix-linkish"
                  onClick={async () => {
                    const out = await cmd.run('Reveal the applicant’s phone number', () => revealTraderPhoneAction({ traderId: t.traderId }));
                    if (out.ok) setPhone(out.result.phone);
                  }}
                >
                  reveal
                </button>
              </>
            ) : null}
          </dd>
          <dt>P2P experience</dt>
          <dd>{a.experience ? EXPERIENCE[a.experience] : '—'}</dd>
          <dt>Profile</dt>
          <dd className={styles.mono}>{a.profileLink ?? '—'}</dd>
          {t.typicalInr || a.dailyInr ? (
            <>
              <dt>INR typical / daily</dt>
              <dd>
                ₹{t.typicalInr ?? '—'} / ₹{a.dailyInr ?? '—'}
              </dd>
            </>
          ) : null}
          {t.typicalUsdt || a.dailyUsdt ? (
            <>
              <dt>USDT typical / daily</dt>
              <dd>
                {t.typicalUsdt ?? '—'} / {a.dailyUsdt ?? '—'} USDT
              </dd>
            </>
          ) : null}
          <dt>Owns the details</dt>
          <dd>{a.ownershipConfirmedAt ? `confirmed ${formatIstDateTime(new Date(a.ownershipConfirmedAt))}` : 'not recorded'}</dd>
          <dt>Exchange</dt>
          <dd>{a.exchangeAccess ? 'open (a client of the desk)' : 'closed (trader only)'}</dd>
        </dl>
        <div className="ix-field">
          <label htmlFor="r-note">Note (the trader sees a rejection note)</label>
          <input id="r-note" className="ix-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {!a.exchangeAccess && approved && perms.configure ? (
          <div>
            <Button
              intent="ghost"
              disabled={cmd.busy || !hasNote}
              onClick={() => cmd.run(`Open the Exchange for ${a.clientRef}`, (key) => setExchangeAccessAction({ clientId: t.clientId, exchangeAccess: true, reason: note.trim() }, key))}
            >
              Open the Exchange for this client
            </Button>
          </div>
        ) : null}
      </section>

      <section className="ix-card" aria-label="Bank account">
        <h2 className="ix-sectionTitle">{underReview ? 'Submitted bank account' : 'Registered bank account'}</h2>
        <BankFacts bank={detail.bank} revealed={revealed[detail.bank.bankAccountId] ?? null} />
        {perms.reveal && !revealed[detail.bank.bankAccountId] ? (
          <Button intent="ghost" onClick={() => void reveal(detail.bank.bankAccountId)}>
            Reveal account number
          </Button>
        ) : null}
        {reviewButtons('BANK', detail.bank.status)}
      </section>

      <section className="ix-card" aria-label="Wallet">
        <h2 className="ix-sectionTitle">{underReview ? 'Submitted TRC20 wallet' : 'Registered TRC20 wallet'}</h2>
        <WalletFacts wallet={detail.wallet} />
        {reviewButtons('WALLET', detail.wallet.status)}
      </section>

      {approved && (proposedBank || proposedWallet) ? (
        <section className="ix-card" aria-label="Proposed settlement details">
          <h2 className="ix-sectionTitle">Proposed by the trader{waitingChange ? ' · waiting for review' : ''}</h2>
          <p className="ix-muted">The registered details keep settling every order until a change is approved.</p>
          {proposedBank ? (
            <div className="ix-stack">
              <h3 className="ix-muted">New bank account</h3>
              <BankFacts bank={proposedBank} revealed={revealed[proposedBank.bankAccountId] ?? null} />
              {perms.reveal && !revealed[proposedBank.bankAccountId] ? (
                <Button intent="ghost" onClick={() => void reveal(proposedBank.bankAccountId)}>
                  Reveal account number
                </Button>
              ) : null}
              {changeButtons('BANK', proposedBank.status)}
            </div>
          ) : null}
          {proposedWallet ? (
            <div className="ix-stack">
              <h3 className="ix-muted">New TRC20 wallet</h3>
              <WalletFacts wallet={proposedWallet} />
              {changeButtons('WALLET', proposedWallet.status)}
            </div>
          ) : null}
        </section>
      ) : null}

      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </>
  );
}
