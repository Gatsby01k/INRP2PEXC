'use client';

import { useState } from 'react';
import type { DeskBankView, DeskTraderDetail, DeskWalletView } from '@inrp2p/traders';
import { CopyButton, StepUpMark } from '@inrp2p/ui';
import { BankMark, RailMark, UsdtOnTron } from '../../../../components/PayMarks.tsx';
import { useCommand } from '../../../../components/useCommand.tsx';
import { revealBankAccountAction, revealTraderPhoneAction, setExchangeAccessAction } from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { dateTime, inr, usdt } from '../../_desk/format.ts';
import { Chip } from '../../_desk/ui.tsx';
import { Facts, Group, Sheet, bookStyles as b } from '../../_book/parts.tsx';
import type { TraderPerms } from '../words.tsx';
import d from '../../_desk/desk.module.css';

const EXPERIENCE: Record<string, string> = { BINANCE: 'Binance P2P', BYBIT: 'Bybit P2P', OTHER: 'Other P2P platform', NONE: 'None' };

export const DETAIL_STATUS: Record<string, { word: string; tone: 'success' | 'warning' | 'muted' | 'danger' | 'brand' }> = {
  PENDING_REVIEW: { word: 'waits for review', tone: 'brand' },
  ACTIVE: { word: 'verified', tone: 'success' },
  REJECTED: { word: 'rejected', tone: 'danger' },
  ARCHIVED: { word: 'archived', tone: 'muted' },
};

export function DetailChip({ status }: { status: string }) {
  const s = DETAIL_STATUS[status] ?? { word: status.toLowerCase(), tone: 'muted' as const };
  return (
    <Chip tone={s.tone} {...(status === 'ACTIVE' ? { glyph: 'done' as const } : status === 'PENDING_REVIEW' ? { glyph: 'partial' as const } : {})}>
      {s.word}
    </Chip>
  );
}

/** A submitted bank account's facts, the account number masked until someone with `bank_account:reveal` asks. */
export function BankFacts({ bank, revealed, onReveal }: { bank: DeskBankView; revealed: string | null; onReveal: (() => void) | null }) {
  return (
    <Facts
      items={[
        { label: 'Holder', value: bank.holderName },
        {
          label: 'Account',
          value: (
            <span className={d.row} style={{ justifyContent: 'flex-end' }}>
              <span className={d.mono}>{revealed ?? `••••${bank.last4}`}</span>
              {onReveal && !revealed ? (
                <button type="button" className={d.linkButton} onClick={onReveal}>
                  reveal <StepUpMark label="needs your authenticator code" />
                </button>
              ) : null}
            </span>
          ),
        },
        { label: 'IFSC', value: <span className={d.mono}>{bank.ifsc}</span> },
        {
          label: 'Rails',
          value: (
            <span className={b.rails}>
              {bank.rails.map((r) => (
                <RailMark key={r} rail={r} />
              ))}
            </span>
          ),
        },
        { label: 'Submitted', value: dateTime(bank.submittedAt) },
        ...(bank.reviewNote ? [{ label: 'Note', value: bank.reviewNote }] : []),
        ...(bank.alsoOnFile.length > 0 ? [{ label: 'Also on file for', value: <Chip tone="warning">{bank.alsoOnFile.join(', ')}</Chip> }] : []),
      ]}
    />
  );
}

export function WalletFacts({ wallet }: { wallet: DeskWalletView }) {
  return (
    <Facts
      items={[
        {
          label: 'Address',
          value: (
            <span className={d.row} style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
              <span className={d.mono}>{wallet.address}</span>
              <CopyButton value={wallet.address} label="wallet address" />
            </span>
          ),
        },
        { label: 'Used for', value: `${wallet.label} · ${wallet.purpose === 'BOTH' ? 'sends and receives' : wallet.purpose.toLowerCase()}` },
        { label: 'Submitted', value: dateTime(wallet.submittedAt) },
        ...(wallet.reviewNote ? [{ label: 'Note', value: wallet.reviewNote }] : []),
        ...(wallet.alsoOnFile.length > 0 ? [{ label: 'Also on file for', value: <Chip tone="warning">{wallet.alsoOnFile.join(', ')}</Chip> }] : []),
      ]}
    />
  );
}

/** The bank account number, opened on request: one audited command, kept for the page's life. */
export function useReveal() {
  const cmd = useCommand();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const reveal = async (bankAccountId: string) => {
    const out = await cmd.run('Reveal the bank account number', () => revealBankAccountAction({ bankAccountId }));
    if (out.ok) setRevealed((r) => ({ ...r, [bankAccountId]: out.result.accountNumber }));
  };
  return { cmd, revealed, reveal };
}

/** Who applied: how the desk reaches them, what they trade elsewhere and how much, and whether the Exchange is open to them. */
export function ApplicantSheet({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const t = detail.trader;
  const a = detail.applicant;
  const [phone, setPhone] = useState<string | null>(null);
  const approved = t.status === 'APPROVED' || t.status === 'PAUSED';
  return (
    <Sheet title="Applicant" hint={`${a.fullName} · ${a.entityType === 'COMPANY' ? 'company' : 'individual'} · ${a.clientRef}`} label="Applicant" flush>
      <Group title="Reach" label="Reach">
        <Facts
          items={[
            { label: 'Email', value: a.email ?? <span className={d.muted}>—</span> },
            { label: 'Telegram', value: a.telegram ?? <span className={d.muted}>—</span> },
            {
              label: 'Phone',
              value: a.phoneLast4 ? (
                <span className={d.row} style={{ justifyContent: 'flex-end' }}>
                  <span className={d.mono}>{phone ?? `••••${a.phoneLast4}`}</span>
                  {!phone && perms.configure ? (
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
              ) : (
                <span className={d.muted}>—</span>
              ),
            },
          ]}
        />
      </Group>
      <Group title="Trading" label="Trading">
        <Facts
          items={[
            { label: 'P2P experience', value: a.experience ? EXPERIENCE[a.experience] : <span className={d.muted}>—</span> },
            ...(a.profileLink
              ? [
                  {
                    label: 'Profile',
                    value: (
                      <a className={d.linkButton} href={a.profileLink} target="_blank" rel="noreferrer noopener" title={a.profileLink}>
                        {(() => {
                          try {
                            return new URL(a.profileLink).host;
                          } catch {
                            return a.profileLink;
                          }
                        })()}
                      </a>
                    ),
                  },
                ]
              : []),
            ...(t.typicalInr || a.dailyInr ? [{ label: 'INR typical / day', value: `${t.typicalInr ? inr(t.typicalInr) : '—'} / ${a.dailyInr ? inr(a.dailyInr) : '—'}` }] : []),
            ...(t.typicalUsdt || a.dailyUsdt ? [{ label: 'USDT typical / day', value: `${t.typicalUsdt ? usdt(t.typicalUsdt, { unit: false }) : '—'} / ${a.dailyUsdt ? usdt(a.dailyUsdt) : '—'}` }] : []),
            { label: 'Owns the details', value: a.ownershipConfirmedAt ? `confirmed ${dateTime(a.ownershipConfirmedAt)}` : 'not recorded' },
          ]}
        />
      </Group>
      <Group title="Exchange" label="Exchange">
        <p className={b.quiet} style={{ color: 'var(--text-secondary)' }}>
          {a.exchangeAccess ? 'Open — this trader is also a client of the desk.' : 'Closed — a trader only; its workspace is Traders alone.'}
        </p>
        {!a.exchangeAccess && approved && perms.configure ? (
          <div className={d.actions}>
            <GuardedAction
              label="Open the Exchange for this client"
              trigger="ghost"
              stepUp
              busy={cmd.busy}
              reasonLabel="Reason"
              consequence="The client can request quotes and trade on the Exchange as well as provide liquidity."
              onConfirm={async (reason) => (await cmd.run(`Open the Exchange for ${a.clientRef}`, (key) => setExchangeAccessAction({ clientId: t.clientId, exchangeAccess: true, reason }, key))).ok}
            />
          </div>
        ) : null}
      </Group>
      {cmd.error ? (
        <p className={d.errorLine} role="alert" style={{ padding: '0 var(--space-5) var(--space-4)' }}>
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </Sheet>
  );
}

/** The bank account and wallet every order settles with, as registered and verified. */
export function RegisteredSheet({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const { cmd, revealed, reveal } = useReveal();
  const bank = detail.bank;
  const wallet = detail.wallet;
  return (
    <Sheet title="Registered details" hint="What every order settles with, until a change is approved." label="Registered details" flush>
      <Group title="Bank account" hint={<DetailChip status={bank.status} />} label="Registered bank account">
        <span className={b.who}>
          <BankMark ifsc={bank.ifsc} name={bank.bankName} size={36} />
          <span className={b.whoText}>
            <span className={b.whoName}>{bank.bankName}</span>
            <span className={b.whoSub}>{bank.holderName}</span>
          </span>
        </span>
        <BankFacts bank={bank} revealed={revealed[bank.bankAccountId] ?? null} onReveal={perms.reveal ? () => void reveal(bank.bankAccountId) : null} />
      </Group>
      <Group title="TRC20 wallet" hint={<DetailChip status={wallet.status} />} label="Registered TRC20 wallet">
        <span className={b.who}>
          <UsdtOnTron size={36} />
          <span className={b.whoText}>
            <span className={b.whoName}>{wallet.label}</span>
            <span className={b.whoSub}>USDT on TRON</span>
          </span>
        </span>
        <WalletFacts wallet={wallet} />
      </Group>
      {cmd.error ? (
        <p className={d.errorLine} role="alert" style={{ padding: '0 var(--space-5) var(--space-4)' }}>
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </Sheet>
  );
}

