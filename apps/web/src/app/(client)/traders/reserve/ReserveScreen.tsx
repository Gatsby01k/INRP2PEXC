'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Money } from '@inrp2p/kernel';
import type { TraderHome } from '@inrp2p/traders';
import { CopyButton, DepositAddress, sanitizeAmountInput } from '@inrp2p/ui';
import { formatIstDateTime, shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { cancelWithdrawalAction, requestWithdrawalAction, reserveAddressAction } from '../../../../server/actions/traders.ts';
import { AssistantPanel } from '../../_assistant/AssistantPanel.tsx';
import type { AssistantState } from '../../_assistant/model.ts';
import { InfoIcon } from '../../_workspace/icons.tsx';
import { sentence, usdt } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

function reserveAssistant(home: TraderHome): AssistantState {
  const r = home.reserve!;
  if (r.withdrawal) return { mood: r.withdrawal.status === 'SENT' ? 'verifying' : 'waiting', label: 'Withdrawal', title: `${usdt(r.withdrawal.amount)} on its way back`, body: r.withdrawal.status === 'SENT' ? 'Sent to your registered wallet; confirming on-chain.' : 'The desk sends it to your registered wallet.' };
  if (/[1-9]/.test(r.shortfall)) return { mood: 'alert', label: 'Top up', title: 'Your reserve is below the requirement', body: `${usdt(r.shortfall)} more is needed before new orders can be assigned.` };
  if (r.engaged) return { mood: 'ready', label: 'Locked', title: `${usdt(r.locked)} locked`, body: 'It protects your open orders and anything unresolved on them.' };
  return { mood: 'ready', label: 'Reserve', title: `${usdt(r.balance)} held`, body: 'Nothing is locked while you are off with no open orders.' };
}

/**
 * The reserve, from the ledger: held, locked, available, on its way back. Adding to it is a transfer from the
 * trader's registered wallet to its own reserve address, credited when final on TRON. Taking back is a request the
 * desk fulfils to the same registered wallet — never more than is free, never the locked part.
 */
export function ReserveScreen({ home }: { home: TraderHome }) {
  const r = home.reserve!;
  const address = useCommand();
  const withdraw = useCommand();
  const [amount, setAmount] = useState('');
  const issueAddress = () => address.run('Show your reserve address', (key) => reserveAddressAction(key));
  const request = async () => {
    const out = await withdraw.run(`Withdraw ${amount} USDT`, (key) => requestWithdrawalAction({ amount }, key));
    if (out.ok) setAmount('');
  };

  return (
    <>
      <main className={shell.main}>
        <section className={shell.surface} aria-labelledby="reserve-figures" data-robot-target="panel">
          <span id="reserve-figures" className={shell.label}>
            Security Reserve
          </span>
          <dl className={`${styles.figures} ${styles.figuresFlat}`}>
            <div className={styles.figure}>
              <dt>Held</dt>
              <dd>{usdt(r.balance)}</dd>
              <span className={styles.figureNote}>{r.required ? `${usdt(r.required)} required` : 'Requirement not set'}</span>
            </div>
            <div className={styles.figure}>
              <dt>Locked</dt>
              <dd>{usdt(r.locked)}</dd>
              <span className={styles.figureNote}>{r.engaged ? 'while you provide liquidity or have open orders' : 'nothing locked now'}</span>
            </div>
            <div className={styles.figure}>
              <dt>Available for withdrawal</dt>
              <dd>{usdt(r.available)}</dd>
            </div>
            <div className={styles.figure}>
              <dt>Pending release</dt>
              <dd>{usdt(r.pendingRelease)}</dd>
              <span className={styles.figureNote}>on its way to your wallet</span>
            </div>
          </dl>
          <p className={styles.note}>A USDT reserve is locked while you provide liquidity. It protects open orders and unresolved obligations. Switching off keeps it locked until your last open order finishes.</p>
        </section>

        <div className={styles.split}>
          <section className={shell.card} aria-labelledby="add-title">
            <h2 id="add-title" className={shell.cardTitle}>
              Add to your reserve
            </h2>
            {r.depositAddress ? (
              <>
                <DepositAddress address={r.depositAddress} amount={/[1-9]/.test(r.shortfall) ? Money.parse(r.shortfall, 'USDT') : null} network="TRC20" tradeRef={home.ref ?? ''} purpose="reserve" showQr />
                <p className={styles.note}>Your own reserve address. Your registered wallet: {home.registered?.wallet}.</p>
              </>
            ) : home.canAct ? (
              <>
                <p className={styles.note}>Your reserve has its own TRC20 address. Show it to send USDT from your registered wallet.</p>
                <div className={styles.formActions}>
                  <button type="button" className={shell.secondaryAction} disabled={address.busy} onClick={() => void issueAddress()}>
                    Show my reserve address
                  </button>
                </div>
              </>
            ) : (
              <p className={styles.note}>Someone who can accept quotes for your account can show the reserve address.</p>
            )}
            {address.error ? (
              <p className={shell.error} role="alert">
                {sentence(address.error)}
              </p>
            ) : null}
          </section>

          <section className={shell.card} aria-labelledby="withdraw-title">
            <h2 id="withdraw-title" className={shell.cardTitle}>
              Withdraw
            </h2>
            {r.withdrawal ? (
              <>
                <p className={shell.info}>
                  <InfoIcon className={shell.infoIcon} />
                  <span>
                    {r.withdrawal.ref}: {usdt(r.withdrawal.amount)} {r.withdrawal.status === 'SENT' ? 'sent, confirming on-chain' : 'requested'} · {formatIstDateTime(new Date(r.withdrawal.askedAt))}
                  </span>
                </p>
                {r.withdrawal.status === 'REQUESTED' && home.canAct ? (
                  <div className={styles.formActions}>
                    <button type="button" className={shell.textAction} disabled={withdraw.busy} onClick={() => void withdraw.run(`Cancel ${r.withdrawal!.ref}`, (key) => cancelWithdrawalAction({ ref: r.withdrawal!.ref }, key))}>
                      Cancel the request
                    </button>
                  </div>
                ) : null}
              </>
            ) : home.canAct ? (
              <form
                className={styles.editForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  void request();
                }}
              >
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Amount</span>
                  <span className={styles.inputBox}>
                    <span className={styles.inputAffix}>USDT</span>
                    <input className={styles.input} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => { const v = sanitizeAmountInput(e.target.value, 'USDT'); if (v !== null) setAmount(v); }} />
                  </span>
                  <span className={styles.fieldHint}>Up to {usdt(r.available)} now. Sent to your registered wallet.</span>
                </label>
                <div className={styles.formActions}>
                  <button type="submit" className={shell.secondaryAction} disabled={withdraw.busy || !/[1-9]/.test(amount) || !/[1-9]/.test(r.available)}>
                    Request withdrawal
                  </button>
                  {/[1-9]/.test(r.available) ? (
                    <button type="button" className={shell.textAction} onClick={() => setAmount(r.available)}>
                      Use {usdt(r.available)}
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <p className={styles.note}>Someone who can accept quotes for your account can request a withdrawal.</p>
            )}
            {withdraw.error ? (
              <p className={shell.error} role="alert">
                {sentence(withdraw.error)}
              </p>
            ) : null}
          </section>
        </div>

        <section className={shell.card} aria-labelledby="history-title">
          <h2 id="history-title" className={shell.cardTitle}>
            History
          </h2>
          {r.history.length === 0 ? (
            <p className={styles.note}>No deposits or withdrawals yet.</p>
          ) : (
            <ul className={styles.evidence}>
              {r.history.map((h, i) => (
                <li key={`${h.at}:${i}`}>
                  <span className={styles.orderText}>
                    <span className={styles.orderMain}>
                      {h.kind === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} · {usdt(h.amount)}
                    </span>
                    <span className={styles.orderMeta}>
                      {formatIstDateTime(new Date(h.at))}
                      {h.txHash ? ` · ${shortenHash(h.txHash)}` : ''}
                    </span>
                  </span>
                  <span className={styles.next}>
                    <span className={styles.pill} data-tone={h.status === 'CREDITED' || h.status === 'COMPLETED' ? 'done' : h.status === 'REJECTED' || h.status === 'CANCELLED' ? 'neutral' : 'waiting'}>
                      <span className={styles.pillDot} aria-hidden="true" />
                      {h.status.charAt(0) + h.status.slice(1).toLowerCase()}
                    </span>
                    {h.txHash ? <CopyButton value={h.txHash} label="Copy transaction hash" /> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <AssistantPanel state={reserveAssistant(home)} size="compact">
        <div className={styles.navRow}>
          <Link className={shell.textAction} href="/traders">
            Traders
          </Link>
        </div>
      </AssistantPanel>
      {address.dialog}
      {withdraw.dialog}
    </>
  );
}
