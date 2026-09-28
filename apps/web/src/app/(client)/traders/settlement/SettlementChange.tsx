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
 * The form behind "Submit a new bank account or wallet". It sends the details to `trader.propose_settlement_change`
 * and nothing else: the desk decides, and the current details stay in force until it does.
 */
export function SettlementChange({ working, current, openOrders }: { working: boolean; current: { bank: string | null; wallet: string | null }; openOrders: number }) {
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

  const assistant: AssistantState = {
    mood: 'ready',
    label: 'Settlement details',
    title: working ? 'Your current details keep working' : 'Replace a detail in your application',
    body: working ? 'The desk reviews what you submit. Nothing changes until it approves, and never on an order in progress.' : 'The desk reviews it before anything settles through it.',
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
                Pending review until the desk approves. Orders keep settling through your current details
                {openOrders > 0 ? `, and the ${openOrders === 1 ? 'order' : `${openOrders} orders`} in progress finish with them` : ''}.
              </span>
            </p>
          ) : null}
          <div className={styles.navRow}>
            <Link className={shell.textAction} href="/traders">
              Cancel
            </Link>
            <button type="submit" className={shell.action} disabled={!ready || busy} aria-busy={busy || undefined}>
              Submit for review
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
