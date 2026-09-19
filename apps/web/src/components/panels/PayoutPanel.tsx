'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { DeskTrade } from '@inrp2p/desk';
import { Button, CapacityMeter, MoneyInput, PayerSelector, SettlementProgress, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import { formatInr, formatUsdt, maskUtr, shortenHash } from '@inrp2p/ui/format';
import {
  confirmIncomingAction, confirmPayoutAction, createPayoutLegAction, recordEvidenceAction, sendPayoutLegAction,
} from '../../server/actions/desk.ts';
import { useCommand } from '../useCommand.tsx';
import styles from './panel.module.css';

const money = (amount: string, currency: 'INR' | 'USDT') =>
  currency === 'INR' ? formatInr(Money.parse(amount, 'INR')) : formatUsdt(Money.parse(amount, 'USDT'), { unit: true });

export interface PayoutPanelProps {
  readonly trade: DeskTrade;
  readonly canCreate: boolean;
  readonly canSend: boolean;
  readonly canRecord: boolean;
  readonly canConfirm: boolean;
  readonly focus?: string;
}

/**
 * The settlement panel (UX_FLOWS W6). It shows what the trade owes, what is in flight and what each leg is
 * waiting for, and it offers exactly the next step: create a leg, mark it sent, record its reference, confirm it.
 * Every button runs one domain command; none of the arithmetic here decides anything — the obligation, the
 * capacity and the route side are all checked again inside the command's transaction.
 */
export function PayoutPanel({ trade, canCreate, canSend, canRecord, canConfirm, focus }: PayoutPanelProps) {
  const cmd = useCommand();
  const asset = trade.payoutOptions.asset;
  const [payer, setPayer] = useState<'EXCHANGE_ACCOUNT' | 'ROUTE'>('EXCHANGE_ACCOUNT');
  const [accountId, setAccountId] = useState<string>(trade.payoutOptions.accounts[0]?.accountId ?? '');
  const [walletId, setWalletId] = useState<string>(trade.payoutOptions.wallets[0]?.walletId ?? '');
  const [amount, setAmount] = useState<string>('');
  const [utrs, setUtrs] = useState<Record<string, string>>({});
  const [hashes, setHashes] = useState<Record<string, string>>({});

  const unallocated = Money.parse(trade.unallocated, asset);
  const clientLeg = trade.legs.find((l) => l.side === 'CLIENT_TO_EXCHANGE' && l.status === 'PROCESSING');
  const payoutLegs = trade.legs.filter((l) => l.side === 'EXCHANGE_TO_CLIENT' && l.status !== 'CANCELLED');
  const canOpenNewLeg = canCreate && unallocated.isPositive() && !trade.hold;

  return (
    <aside className={styles.panel} aria-label={`Settlement for ${trade.ref}`} data-testid="payout-panel">
      <div className={styles.head}>
        <span className={styles.ref}>{trade.ref}</span>
        <span className={styles.client}>
          {trade.clientName} · {trade.direction === 'SELL_USDT' ? 'SELL' : 'BUY'}
        </span>
      </div>

      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>Obligation</dt>
          <dd className="ix-num">{money(trade.payout.amount, trade.payout.currency)}</dd>
        </div>
        <div className={styles.row}>
          <dt>Confirmed</dt>
          <dd className="ix-num">{money(trade.paid, asset)}</dd>
        </div>
        <div className={styles.row}>
          <dt>In flight</dt>
          <dd className="ix-num">{money(Money.parse(trade.committed, asset).sub(Money.parse(trade.paid, asset)).toDecimalString(), asset)}</dd>
        </div>
        <div className={styles.row}>
          <dt>Unallocated</dt>
          <dd className="ix-num">{money(trade.unallocated, asset)}</dd>
        </div>
        {trade.expectedMargin ? (
          <div className={styles.row}>
            <dt>Expected margin</dt>
            <dd className="ix-num">{formatInr(Money.parse(trade.expectedMargin, 'INR'), { sign: 'always' })}</dd>
          </div>
        ) : null}
      </dl>

      {asset === 'INR' ? (
        <SettlementProgress
          received={Money.parse(trade.paid, 'INR')}
          total={Money.parse(trade.payout.amount, 'INR')}
          inFlight={Money.parse(trade.committed, 'INR').sub(Money.parse(trade.paid, 'INR'))}
        />
      ) : null}

      {clientLeg ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Client funds</h3>
          <p className={styles.notice}>
            {money(clientLeg.amount, clientLeg.asset)} detected{clientLeg.reference ? ` · ${clientLeg.referenceKind === 'TX' ? shortenHash(clientLeg.reference) : maskUtr(clientLeg.reference)}` : ''}
          </p>
          <div className={styles.actions}>
            <Button
              intent="primary"
              disabled={!canConfirm}
              onClick={() => cmd.run(`Confirm client funds on ${trade.ref}`, (key) => confirmIncomingAction({ legId: clientLeg.id }, key))}
            >
              Confirm received
            </Button>
          </div>
          {!canConfirm ? <p className={styles.notice}>Confirming incoming funds needs the settlement role.</p> : null}
        </section>
      ) : null}

      {canOpenNewLeg ? (
        <section className={styles.section} data-testid="new-leg">
          <h3 className={styles.sectionTitle}>New payout leg</h3>
          {asset === 'INR' ? (
            <PayerSelector value={payer} onChange={setPayer} executionMode={trade.payoutOptions.routeDirectAvailable ? 'DIRECT_TO_CLIENT' : 'TO_EXCHANGE'} />
          ) : null}

          {payer === 'EXCHANGE_ACCOUNT' && asset === 'INR' ? (
            <div className={styles.accounts} role="radiogroup" aria-label="Pay from">
              {trade.payoutOptions.accounts.map((a) => (
                <label key={a.accountId} className={`${styles.account} ${accountId === a.accountId ? styles.accountSelected : ''}`}>
                  <input type="radio" name="payout-account" checked={accountId === a.accountId} onChange={() => setAccountId(a.accountId)} />
                  <span className={styles.accountBody}>
                    <span>
                      {a.bankName} · {a.label}
                    </span>
                    <CapacityMeter
                      accountLabel={`Available today ${formatInr(Money.parse(a.availableToday, 'INR'))}`}
                      capacity={Money.parse(a.capacityToday, 'INR')}
                      used={Money.parse(a.capacityToday, 'INR').sub(Money.parse(a.availableToday, 'INR'))}
                      reserved={Money.ofMinor(0n, 'INR')}
                      status="ACTIVE"
                    />
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {asset === 'USDT' ? (
            <div className={styles.accounts} role="radiogroup" aria-label="Pay from">
              {trade.payoutOptions.wallets.map((wlt) => (
                <label key={wlt.walletId} className={`${styles.account} ${walletId === wlt.walletId ? styles.accountSelected : ''}`}>
                  <input type="radio" name="payout-wallet" checked={walletId === wlt.walletId} onChange={() => setWalletId(wlt.walletId)} />
                  <span className={styles.accountBody}>
                    <span>{wlt.label}</span>
                    <span className={styles.legMeta}>{formatUsdt(Money.parse(wlt.available, 'USDT'), { unit: true })} available</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          <MoneyInput
            label="Amount"
            currency={asset}
            value={amount}
            onChange={setAmount}
            hint={`Maximum ${money(trade.unallocated, asset)}`}
          />
          <div className={styles.actions}>
            <Button
              intent="primary"
              disabled={amount === '' || cmd.busy}
              onClick={() =>
                cmd.run(`Create ${money(amount || '0', asset)} payout leg on ${trade.ref}`, (key) =>
                  createPayoutLegAction(
                    {
                      tradeId: trade.tradeId,
                      amount,
                      payer,
                      ...(payer === 'EXCHANGE_ACCOUNT' && asset === 'INR' ? { inrAccountId: accountId } : {}),
                      ...(asset === 'USDT' ? { treasuryWalletId: walletId } : {}),
                    },
                    key,
                  ),
                ).then((r) => {
                  if (r.ok) setAmount('');
                  return r;
                })
              }
            >
              {payer === 'ROUTE' ? 'Create route-paid leg' : 'Reserve & create leg'}
            </Button>
          </div>
        </section>
      ) : null}

      {payoutLegs.length > 0 ? (
        <section className={styles.section} data-testid="legs">
          <h3 className={styles.sectionTitle}>Legs</h3>
          <div className={styles.legs}>
            {payoutLegs.map((leg) => (
              <div key={leg.id} className={styles.leg} data-testid={`leg-${leg.ref}`}>
                <div className={styles.legHead}>
                  <span>
                    <strong className="ix-num">{money(leg.amount, leg.asset)}</strong> · {leg.status.toLowerCase()}
                  </span>
                  <span className={styles.legMeta}>{leg.payer === 'ROUTE' ? (leg.routeName ?? 'route') : (leg.accountLabel ?? 'exchange')}</span>
                </div>

                {leg.status === 'PENDING' && canSend ? (
                  <div className={styles.actions}>
                    <Button onClick={() => cmd.run(`Mark ${leg.ref} sent`, (key) => sendPayoutLegAction({ legId: leg.id }, key))}>
                      {leg.payer === 'ROUTE' ? 'Route reported sent' : 'Mark sent'}
                    </Button>
                  </div>
                ) : null}

                {leg.status === 'PROCESSING' && !leg.reference && canRecord ? (
                  leg.asset === 'INR' ? (
                    <>
                      <UTRField value={utrs[leg.id] ?? ''} onChange={(v) => setUtrs((s) => ({ ...s, [leg.id]: v }))} />
                      <div className={styles.actions}>
                        <Button
                          disabled={(utrs[leg.id] ?? '').length < 6}
                          onClick={() =>
                            cmd.run(`Record the reference for ${leg.ref}`, (key) =>
                              recordEvidenceAction({ legId: leg.id, rail: 'IMPS', utr: normalizeUtr(utrs[leg.id] ?? '') }, key),
                            )
                          }
                        >
                          Save UTR
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="ix-field">
                        <label htmlFor={`tx-${leg.id}`}>Transaction hash</label>
                        <input
                          id={`tx-${leg.id}`}
                          className="ix-input"
                          value={hashes[leg.id] ?? ''}
                          onChange={(e) => setHashes((s) => ({ ...s, [leg.id]: e.target.value.trim() }))}
                        />
                      </div>
                      <div className={styles.actions}>
                        <Button
                          disabled={(hashes[leg.id] ?? '').length < 64}
                          onClick={() =>
                            cmd.run(`Record the transaction for ${leg.ref}`, (key) =>
                              recordEvidenceAction({ legId: leg.id, txHash: hashes[leg.id] ?? '', logIndex: 0, fromAddress: trade.payoutOptions.wallets.find((wlt) => wlt.walletId === walletId)?.address ?? '' }, key),
                            )
                          }
                        >
                          Save transaction
                        </Button>
                      </div>
                    </>
                  )
                ) : null}

                {leg.reference ? (
                  <span className={styles.legMeta}>{leg.referenceKind === 'TX' ? shortenHash(leg.reference) : maskUtr(leg.reference)}</span>
                ) : null}

                {leg.status === 'PROCESSING' && leg.reference && canConfirm ? (
                  <div className={styles.actions}>
                    <Button
                      intent="primary"
                      shortcut={<StepUpMark label="needs your authenticator code" />}
                      onClick={() => cmd.run(`Confirm payout ${money(leg.amount, leg.asset)} · ${leg.ref}`, (key) => confirmPayoutAction({ legId: leg.id }, key))}
                    >
                      Confirm
                    </Button>
                  </div>
                ) : null}

                {leg.failureReason ? <span className={styles.legMeta}>{leg.failureReason}</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {focus === 'utr' && payoutLegs.every((l) => l.status !== 'PROCESSING') ? (
        <p className={styles.notice}>No leg is waiting for a reference on this trade.</p>
      ) : null}
      {cmd.error ? (
        <p className={styles.error} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </aside>
  );
}
