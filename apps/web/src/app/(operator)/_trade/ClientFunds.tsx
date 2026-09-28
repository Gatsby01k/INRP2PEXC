'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { DeskTrade } from '@inrp2p/desk';
import { Button, CopyButton, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { confirmIncomingAction, recordIncomingFiatAction, revertIncomingAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { AmountField, SelectField } from '../_desk/fields.tsx';
import { money, parseAmount, share, sub, time } from '../_desk/format.ts';
import { LegStatusChip, Meter, Notice } from '../_desk/ui.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

export interface CollectionAccount {
  readonly accountId: string;
  readonly label: string;
  readonly bankName: string;
  readonly last4: string;
}

type Rail = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';

/**
 * The client's own leg. For a SELL the USDT arrives at the trade's unique deposit address and the chain decides
 * when it is final (D-02); the desk only confirms what the scanner saw. For a BUY the client pays INR and quotes
 * a reference: the desk records it (T2), checks the collection account, and confirms it (⧗) — or says it never
 * arrived, which sends the trade back to waiting.
 */
export function ClientFunds({ trade, perms, collectionAccounts = [] }: { trade: DeskTrade; perms: TradePerms; collectionAccounts?: readonly CollectionAccount[] }) {
  const sell = trade.direction === 'SELL_USDT';
  const asset = trade.receivable.currency;
  const legs = trade.legs.filter((l) => l.side === 'CLIENT_TO_EXCHANGE');
  const outstanding = sub(trade.receivable.amount, trade.received, asset);
  const waiting = trade.lifecycle === 'AWAITING_FIRST_LEG' || trade.lifecycle === 'FIRST_LEG_DETECTED';
  const inFlight = legs.filter((l) => l.status === 'PROCESSING').reduce((acc, l) => acc.add(Money.parse(l.amount, asset)), Money.ofMinor(0n, asset));

  return (
    <PanelSection title={sell ? 'USDT from the client' : 'INR from the client'} aside={`${money(trade.received, asset, { exact: sell })} of ${money(trade.receivable.amount, asset, { exact: sell })}`} testId="client-funds">
      <Meter
        label={`${money(trade.received, asset)} confirmed of ${money(trade.receivable.amount, asset)}`}
        parts={[
          { value: share(trade.received, trade.receivable.amount, asset), tone: 'success' },
          { value: share(inFlight.toDecimalString(), trade.receivable.amount, asset), tone: 'flight' },
        ]}
      />

      {sell && trade.deposit ? (
        <div className={d.stackTight}>
          <span className={d.fieldLabel}>Unique deposit address · TRC20</span>
          <div className={t.address}>
            <span className={t.addressValue}>{trade.deposit.address}</span>
            <CopyButton value={trade.deposit.address} label="deposit address" />
          </div>
          <span className={d.fieldHint}>
            Expects {trade.deposit.expected ? money(trade.deposit.expected, 'USDT', { exact: true }) : money(trade.receivable.amount, 'USDT', { exact: true })} · address {trade.deposit.status.toLowerCase()}. Attributed by address only — never by amount or sender.
          </span>
        </div>
      ) : null}

      {legs.length > 0 ? (
        <ul className={t.legs}>
          {legs.map((leg) => (
            <IncomingLeg key={leg.id} tradeRef={trade.ref} leg={leg} perms={perms} />
          ))}
        </ul>
      ) : waiting ? (
        <Notice icon="clock">{sell ? 'Nothing has arrived at the address yet. The scanner reports it the moment it does.' : 'The client has not quoted a payment reference yet.'}</Notice>
      ) : null}

      {!sell && waiting && perms.recordIncoming && Money.parse(outstanding, 'INR').isPositive() ? (
        <RecordIncoming trade={trade} outstanding={outstanding} accounts={collectionAccounts} />
      ) : null}
    </PanelSection>
  );
}

function IncomingLeg({ tradeRef, leg, perms }: { tradeRef: string; leg: DeskTrade['legs'][number]; perms: TradePerms }) {
  const cmd = useCommand();
  const pending = leg.status === 'PROCESSING';
  return (
    <li className={t.leg} {...(pending && perms.confirmIncoming ? { 'data-attention': '' } : {})} {...(leg.status === 'FAILED' ? { 'data-dim': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>{money(leg.amount, leg.asset, { exact: leg.asset === 'USDT' })}</span>
        <LegStatusChip status={leg.status} />
      </div>
      <div className={t.legMeta}>
        <span>{leg.ref}</span>
        {leg.reference ? <span className={d.mono}>{leg.referenceKind === 'TX' ? `tx ${shortenHash(leg.reference)}` : `UTR ${maskUtr(leg.reference)}`}</span> : null}
        <span>{leg.confirmedAt ? `confirmed ${time(leg.confirmedAt)}` : `${leg.asset === 'USDT' ? 'detected' : 'recorded'} ${time(leg.createdAt)}`}</span>
      </div>
      {leg.failureReason ? <Notice tone="danger">{leg.failureReason}</Notice> : null}
      {pending ? (
        <div className={t.legNext}>
          <span className={t.legNextLabel}>{leg.asset === 'USDT' ? 'Next · confirm on chain' : 'Next · check the collection account'}</span>
          <div className={d.actions}>
            {perms.confirmIncoming ? (
              <Button
                intent="primary"
                size="sm"
                disabled={cmd.busy}
                shortcut={<StepUpMark label="needs your authenticator code" />}
                onClick={() => cmd.run(`Confirm client funds on ${tradeRef}`, (key) => confirmIncomingAction({ legId: leg.id }, key))}
              >
                Confirm received
              </Button>
            ) : (
              <span className={d.muted}>Confirming client funds needs the settlement role.</span>
            )}
            {leg.asset === 'INR' && perms.failPayout ? (
              // A bank payment is the desk's to judge; an on-chain one is the chain's, so only INR offers this.
              <GuardedAction
                label="Not received"
                trigger="ghost"
                tone="danger"
                stepUp
                busy={cmd.busy}
                consequence="The recorded payment is closed as failed and the trade goes back to waiting for the client’s INR. Use it only when the collection account shows no matching credit."
                reasonLabel="What the account shows"
                placeholder="no matching credit found in the collection account"
                onConfirm={async (reason) => (await cmd.run(`Mark the client's INR on ${tradeRef} as not received`, (key) => revertIncomingAction({ legId: leg.id, reason }, key))).ok}
              />
            ) : null}
          </div>
          {leg.asset === 'USDT' ? <span className={d.fieldHint}>Confirmation checks the transaction is final on TRON; it is refused until it is.</span> : null}
        </div>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </li>
  );
}

function RecordIncoming({ trade, outstanding, accounts }: { trade: DeskTrade; outstanding: string; accounts: readonly CollectionAccount[] }) {
  const cmd = useCommand();
  const [amount, setAmount] = useState(outstanding);
  const [utr, setUtr] = useState('');
  const [rail, setRail] = useState<Rail>('IMPS');
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  const typed = parseAmount(amount, 'INR');
  const over = typed !== null && typed.minor > Money.parse(outstanding, 'INR').minor;
  const ready = !cmd.busy && typed !== null && typed.isPositive() && normalizeUtr(utr).length >= 6 && accountId !== '';

  return (
    <div className={d.guard}>
      <p className={d.guardTitle}>Record the client’s INR payment</p>
      <p className={d.guardBody}>Recording files the reference; nothing counts until it is confirmed against the collection account. A UTR can belong to one transfer only.</p>
      <div className={d.formGrid}>
        <AmountField label="Amount received" currency="INR" value={amount} onChange={setAmount} {...(over ? { error: `More than the client still owes (${money(outstanding, 'INR')}).` } : {})} />
        <SelectField<Rail> label="Rail" value={rail} onChange={setRail} options={(['IMPS', 'NEFT', 'RTGS', 'UPI'] as const).map((r) => ({ value: r, label: r }))} />
      </div>
      <UTRField value={utr} onChange={setUtr} label="Client’s UTR / reference" />
      {accounts.length === 0 ? (
        <Notice tone="warning">No active account can collect INR. Open one on INR accounts.</Notice>
      ) : (
        <SelectField label="Into" value={accountId} onChange={setAccountId} options={accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${a.label}` }))} />
      )}
      <div className={d.actions}>
        <Button
          intent="primary"
          size="sm"
          disabled={!ready || over}
          onClick={() =>
            void cmd
              .run(`Record the client's INR on ${trade.ref}`, (key) => recordIncomingFiatAction({ tradeId: trade.tradeId, rail, utr: normalizeUtr(utr), amount, inrAccountId: accountId }, key))
              .then((r) => {
                if (r.ok) setUtr('');
                return r;
              })
          }
        >
          Record payment
        </Button>
      </div>
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
