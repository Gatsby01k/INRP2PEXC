'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { TraderNetworkView } from '@inrp2p/traders';
import { CopyButton, DepositAddress } from '@inrp2p/ui';
import { formatIstDateTime, shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { cancelNetworkWithdrawalAction, claimNetworkDepositAction, requestNetworkWithdrawalAction } from '../../../../server/actions/traders.ts';
import { AssistantPanel } from '../../_assistant/AssistantPanel.tsx';
import type { AssistantState } from '../../_assistant/model.ts';
import { InfoIcon } from '../../_workspace/icons.tsx';
import { inr, isZero, sentence, sideTitle, trx } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

function networkAssistant(n: TraderNetworkView): AssistantState {
  if (n.withdrawal) return { mood: 'waiting', label: 'Withdrawal', title: `${trx(n.withdrawal.amount)} on its way back`, body: n.withdrawal.status === 'APPROVED' ? 'Approved; the signer is sending it to your registered wallet.' : 'The desk approves it, then it is sent to your registered wallet.' };
  if (!n.perOrder) return { mood: 'waiting', label: 'Network fees', title: 'Fees are being updated', body: 'New orders resume as soon as the exchange has current TRON fees.' };
  if (n.short) return { mood: 'alert', label: 'Top up', title: 'Not enough TRX for a new order', body: `An order holds up to ${trx(n.perOrderNeed ?? n.perOrder.BUY_USDT)} until it finishes. Send TRX from your registered wallet.` };
  return { mood: 'ready', label: 'Network deposit', title: `${trx(n.available)} free`, body: n.ordersCovered !== null ? `Enough for ${n.ordersCovered} more ${n.ordersCovered === 1 ? 'order' : 'orders'} at today’s fees.` : 'Ready for your next order.' };
}

/** A clause about who bears an order's transfer costs, in the order's own words. */
function orderOutcome(o: TraderNetworkView['orders'][number]): string {
  if (o.open) return `${trx(o.held)} held until it finishes`;
  if (isZero(o.spent)) return 'Nothing spent; the hold is free again';
  if (!isZero(o.yours)) return `${trx(o.spent)} spent · ${trx(o.yours)} yours: the USDT went back because your side was not completed`;
  return `${trx(o.spent)} spent · paid back ${inr(o.repaidInr)} with your rewards`;
}

/**
 * The network deposit (ADR 0017 §2): the TRX the exchange's signer burns to send USDT for this trader's orders — top-ups
 * of each deal address, never anyone else's money and never the Security Reserve. Every order holds its worst case from
 * acceptance; what its transfers actually burn is spent; what the client's price already covered is paid back in INR
 * with the trader's rewards. Adding TRX is a transfer from the registered wallet to the budget wallet; taking it back is
 * a request the desk approves, to the same wallet, never more than is free.
 */
export function NetworkScreen({ network: n, canAct }: { network: TraderNetworkView; canAct: boolean }) {
  const claim = useCommand();
  const withdraw = useCommand();
  const [amount, setAmount] = useState('');
  const [txHash, setTxHash] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const check = async () => {
    setFound(null);
    const out = await claim.run('Check your TRX transfer', (key) => claimNetworkDepositAction({ txHash }, key));
    if (out.ok) {
      setTxHash('');
      setFound(out.result.credited ? `${trx(out.result.amount)} credited to your network deposit` : `${trx(out.result.amount)} was already credited`);
    }
  };
  const request = async () => {
    const out = await withdraw.run(`Withdraw ${amount} TRX`, (key) => requestNetworkWithdrawalAction({ amount }, key));
    if (out.ok) setAmount('');
  };
  const validAmount = /^\d+(\.\d{1,6})?$/.test(amount) && /[1-9]/.test(amount);

  return (
    <>
      <main className={shell.main}>
        <section className={shell.surface} aria-labelledby="network-figures" data-robot-target="panel">
          <span id="network-figures" className={shell.label}>
            Network deposit · TRX
          </span>
          <dl className={`${styles.figures} ${styles.figuresFlat}`}>
            <div className={styles.figure}>
              <dt>Free for new orders</dt>
              <dd>{trx(n.available)}</dd>
              <span className={styles.figureNote}>{n.ordersCovered !== null ? `about ${n.ordersCovered} ${n.ordersCovered === 1 ? 'order' : 'orders'} at today’s fees` : 'after what is held and on its way'}</span>
            </div>
            <div className={styles.figure}>
              <dt>Held for open orders</dt>
              <dd>{trx(n.held)}</dd>
              <span className={styles.figureNote}>the most their transfers can cost</span>
            </div>
            <div className={styles.figure}>
              <dt>Balance</dt>
              <dd>{trx(n.balance)}</dd>
              <span className={styles.figureNote}>deposited, less spent and withdrawn</span>
            </div>
            <div className={styles.figure}>
              <dt>Paid back with rewards</dt>
              <dd>{inr(n.repaidInrTotal)}</dd>
              <span className={styles.figureNote}>what client prices covered, in INR</span>
            </div>
          </dl>
          <p className={styles.note}>
            Sending USDT on TRON burns TRX. For your orders it comes from this deposit, not from your Security Reserve or anyone else’s money: each order holds
            {n.perOrder ? <> up to <span className="ix-num">{trx(n.perOrder.BUY_USDT)}</span> (Buy USDT: paying you, or returning the client’s USDT) or <span className="ix-num">{trx(n.perOrder.SELL_USDT)}</span> (Sell USDT)</> : ' its worst case'} until it finishes, and the rest is free again. The network fee is in the client’s price, so what you spend for it is paid back in INR with your rewards. A return caused by your side not being completed is yours.
          </p>
        </section>

        <div className={styles.stack}>
          <section className={shell.card} aria-labelledby="add-title">
            <h2 id="add-title" className={shell.cardTitle}>
              Add TRX
            </h2>
            {n.depositAddress ? (
              <>
                <DepositAddress
                  address={n.depositAddress}
                  amountText={n.short && n.perOrderNeed ? trx(n.perOrderNeed) : null}
                  network="TRC20"
                  tradeRef=""
                  purpose="network"
                  showQr
                  framed={false}
                />
                <p className={styles.note}>
                  Send from your registered wallet <span className="ix-num">{n.registeredWallet}</span>: the wallet it comes from is how the TRX is credited to you. Then hand in the transaction hash once TRON has made it final (about a minute).
                </p>
                <form
                  className={styles.editForm}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void check();
                  }}
                >
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Transaction hash (TxID)</span>
                    <span className={styles.inputBox}>
                      <input className={styles.input} autoComplete="off" spellCheck={false} maxLength={66} placeholder="64 characters" value={txHash} onChange={(e) => setTxHash(e.target.value.trim())} />
                    </span>
                  </label>
                  <div className={styles.formActions}>
                    <button type="submit" className={shell.secondaryAction} aria-busy={claim.busy} disabled={claim.busy || txHash.replace(/^0x/, '').length !== 64}>
                      {claim.busy ? 'Reading TRON…' : 'Credit my TRX'}
                    </button>
                  </div>
                </form>
                {found ? (
                  <p className={shell.info} role="status">
                    <InfoIcon className={shell.infoIcon} />
                    <span>{found}</span>
                  </p>
                ) : null}
              </>
            ) : (
              <p className={styles.note}>The network deposit address is not available yet. The desk has been told; please try again later.</p>
            )}
            {claim.error ? (
              <p className={shell.error} role="alert">
                {sentence(claim.error)}
              </p>
            ) : null}
          </section>

          <section className={shell.card} aria-labelledby="withdraw-title">
            <h2 id="withdraw-title" className={shell.cardTitle}>
              Withdraw
            </h2>
            {n.withdrawal ? (
              <>
                <p className={shell.info}>
                  <InfoIcon className={shell.infoIcon} />
                  <span>
                    {n.withdrawal.ref}: {trx(n.withdrawal.amount)} {n.withdrawal.status === 'APPROVED' ? 'approved, being sent' : 'requested'} · {formatIstDateTime(new Date(n.withdrawal.askedAt))}
                  </span>
                </p>
                {n.withdrawal.status === 'REQUESTED' && canAct ? (
                  <div className={styles.formActions}>
                    <button type="button" className={shell.textAction} disabled={withdraw.busy} onClick={() => void withdraw.run(`Cancel ${n.withdrawal!.ref}`, (key) => cancelNetworkWithdrawalAction({ withdrawalId: n.withdrawal!.id }, key))}>
                      Cancel the request
                    </button>
                  </div>
                ) : null}
              </>
            ) : canAct ? (
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
                    <span className={styles.inputAffix}>TRX</span>
                    <input className={styles.input} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, ''); if (/^\d*(\.\d{0,6})?$/.test(v)) setAmount(v); }} />
                  </span>
                  <span className={styles.fieldHint}>Up to {trx(n.available)}, less the transfer’s own fee. Sent to your registered wallet.</span>
                </label>
                <div className={styles.formActions}>
                  <button type="submit" className={shell.secondaryAction} disabled={withdraw.busy || !validAmount}>
                    Request withdrawal
                  </button>
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

        <section className={shell.card} aria-labelledby="orders-title">
          <h2 id="orders-title" className={shell.cardTitle}>
            Network costs by order
          </h2>
          {n.orders.length === 0 ? (
            <p className={styles.note}>No orders have used the deposit yet.</p>
          ) : (
            <ul className={styles.evidence}>
              {n.orders.map((o) => (
                <li key={o.orderRef}>
                  <span className={styles.orderText}>
                    <span className={styles.orderMain}>
                      {o.orderRef} · {sideTitle(o.side)}
                    </span>
                    <span className={styles.orderMeta}>{orderOutcome(o)}</span>
                  </span>
                  <span className={styles.next}>
                    <span className={styles.pill} data-tone={o.open ? 'waiting' : 'done'}>
                      <span className={styles.pillDot} aria-hidden="true" />
                      {o.open ? 'Held' : 'Settled'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={shell.card} aria-labelledby="history-title">
          <h2 id="history-title" className={shell.cardTitle}>
            Deposits and withdrawals
          </h2>
          {n.history.length === 0 ? (
            <p className={styles.note}>No TRX deposited yet.</p>
          ) : (
            <ul className={styles.evidence}>
              {n.history.map((h, i) => (
                <li key={`${h.at}:${i}`}>
                  <span className={styles.orderText}>
                    <span className={styles.orderMain}>
                      {h.kind === 'DEPOSIT' ? 'Deposit' : h.kind === 'WITHDRAWAL' ? 'Withdrawal' : 'Correction by the desk'} · {trx(h.amount)}
                    </span>
                    <span className={styles.orderMeta}>
                      {formatIstDateTime(new Date(h.at))}
                      {h.txHash ? ` · ${shortenHash(h.txHash)}` : ''}
                      {h.note ? ` · ${h.note}` : ''}
                    </span>
                  </span>
                  <span className={styles.next}>
                    <span className={styles.pill} data-tone={h.status === 'CREDITED' || h.status === 'COMPLETED' ? 'done' : ['REJECTED', 'CANCELLED', 'DEBITED'].includes(h.status) ? 'neutral' : 'waiting'}>
                      <span className={styles.pillDot} aria-hidden="true" />
                      {(h.status.charAt(0) + h.status.slice(1).toLowerCase()).replaceAll('_', ' ')}
                    </span>
                    {h.txHash ? <CopyButton value={h.txHash} label="Copy transaction hash" /> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <AssistantPanel state={networkAssistant(n)} size="compact">
        <div className={styles.navRow}>
          <Link className={shell.textAction} href="/traders">
            Traders
          </Link>
          <Link className={shell.textAction} href="/traders/reserve">
            Security Reserve
          </Link>
        </div>
      </AssistantPanel>
      {claim.dialog}
      {withdraw.dialog}
    </>
  );
}
