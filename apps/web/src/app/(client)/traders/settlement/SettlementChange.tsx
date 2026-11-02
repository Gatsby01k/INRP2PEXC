'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCommand } from '../../../../components/useCommand.tsx';
import { proposeSettlementChangeAction } from '../../../../server/actions/traders.ts';
import { AssistantPanel } from '../../_assistant/AssistantPanel.tsx';
import type { AssistantState } from '../../_assistant/model.ts';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import { sentence } from '../_ui/format.ts';
import {
  type BankDraft, type WalletDraft, BankFields, EMPTY_BANK, EMPTY_WALLET, OWNERSHIP_TEXT, WalletFields, bankComplete, bankPayload, walletComplete, walletPayload,
} from '../_ui/SettlementFields.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * The form behind "Submit a new bank account or wallet" (`trader.propose_settlement_change`). Where a trader is paid is
 * changed only by someone who confirms it is them now (ADR 0026: a factor other than the sign-in — the command asks, and
 * `useCommand` offers the factors in place). Once approved, the new details wait out the programme's hold (ADR 0024),
 * every member is told, and the current details keep settling every order until then.
 */
export function SettlementChange({ working, current, openOrders, holdHours }: {
  working: boolean;
  current: { bank: string | null; wallet: string | null };
  openOrders: number;
  holdHours: number;
}) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [changeBank, setChangeBank] = useState(false);
  const [changeWallet, setChangeWallet] = useState(false);
  const [bank, setBank] = useState<BankDraft>(EMPTY_BANK);
  const [wallet, setWallet] = useState<WalletDraft>(EMPTY_WALLET);
  const [owned, setOwned] = useState(false);
  const ready = (changeBank || changeWallet) && (!changeBank || bankComplete(bank)) && (!changeWallet || walletComplete(wallet)) && owned;

  const submit = async () => {
    const out = await run('Submit new settlement details', (key) =>
      proposeSettlementChangeAction({ ...(changeBank ? { bank: bankPayload(bank) } : {}), ...(changeWallet ? { wallet: walletPayload(wallet) } : {}), confirmOwnership: owned }, key),
    );
    if (out.ok) router.push('/traders');
  };

  const hold = holdHours === 1 ? '1 hour' : `${holdHours} hours`;
  const assistant: AssistantState = {
    mood: 'ready',
    label: 'Settlement details',
    title: working ? 'Your current details keep working' : 'Replace a detail in your application',
    body: working ? `Everyone on your account is told at once and can stop it. It takes effect after ${hold}, between orders.` : 'It is checked before anything settles through it.',
  };

  return (
    <>
      <main className={`${shell.main} ${shell.centred}`}>
        <form
          className={shell.surface}
          aria-label="New settlement details"
          data-robot-target="panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void submit();
          }}
        >
          <div className={styles.choices}>
            <label className={styles.check}>
              <input type="checkbox" checked={changeBank} onChange={(e) => setChangeBank(e.target.checked)} />
              New bank account{current.bank ? ` (instead of ${current.bank})` : ''}
            </label>
            {changeBank ? <BankFields value={bank} onChange={setBank} /> : null}
            <label className={styles.check}>
              <input type="checkbox" checked={changeWallet} onChange={(e) => setChangeWallet(e.target.checked)} />
              New TRC20 wallet{current.wallet ? ` (instead of ${current.wallet})` : ''}
            </label>
            {changeWallet ? <WalletFields value={wallet} onChange={setWallet} /> : null}
            <label className={styles.check}>
              <input type="checkbox" checked={owned} onChange={(e) => setOwned(e.target.checked)} />
              {OWNERSHIP_TEXT}
            </label>
          </div>
          {working ? (
            <p className={shell.info}>
              <InfoIcon className={shell.infoIcon} />
              <span>
                For your safety it takes effect after {hold}: everyone on your account is told at once and any administrator can stop it. Until then orders keep settling through your
                current details{openOrders > 0 ? `, and the ${openOrders === 1 ? 'order' : `${openOrders} orders`} in progress finish with them` : ''}.
              </span>
            </p>
          ) : null}
          <div className={styles.navRow}>
            <Link className={shell.textAction} href="/traders">
              Cancel
            </Link>
            <button type="submit" className={shell.action} disabled={!ready || busy} aria-busy={busy || undefined}>
              {working ? 'Confirm and submit' : 'Submit for review'}
              <ArrowIcon className={shell.actionIcon} />
            </button>
          </div>
          {error ? (
            <p className={shell.error} role="alert">
              {sentence(error)}
            </p>
          ) : null}
        </form>
      </main>
      <AssistantPanel state={assistant} size="compact" />
      {dialog}
    </>
  );
}
