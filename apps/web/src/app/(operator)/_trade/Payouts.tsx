'use client';

import { useEffect, useRef, useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { DeskLeg, DeskTrade } from '@inrp2p/desk';
import { Button, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import {
  cancelPayoutAction, confirmPayoutAction, createPayoutLegAction, failPayoutAction, recordEvidenceAction, sendPayoutLegAction,
} from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { AmountField, Choices, SelectField, TextField } from '../_desk/fields.tsx';
import { money, parseAmount, share, time } from '../_desk/format.ts';
import { LegStatusChip, Meter, Notice } from '../_desk/ui.tsx';
import { SettlementFigures } from './Summary.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

type Payer = 'EXCHANGE_ACCOUNT' | 'ROUTE';

/**
 * Paying the client (UX_FLOWS F5, W6): what is owed and where it stands, a leg builder that shows each account's
 * capacity for today against the amount typed, and every leg with its one next step — mark sent, record the
 * reference, confirm — plus the two ways out (cancel a leg not yet sent, fail one that never arrived). Each button
 * is one command; the obligation, the capacity and the route side are all checked again inside it.
 */
export function Payouts({ trade, perms, focus }: { trade: DeskTrade; perms: TradePerms; focus?: string }) {
  const asset = trade.payoutOptions.asset;
  const legs = trade.legs.filter((l) => l.side === 'EXCHANGE_TO_CLIENT');
  const live = legs.filter((l) => l.status !== 'CANCELLED' && l.status !== 'FAILED');
  const closed = legs.filter((l) => l.status === 'CANCELLED' || l.status === 'FAILED');
  const fundsIn = ['FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED'].includes(trade.lifecycle);
  const canOpenLeg = perms.createPayout && fundsIn && !trade.hold && Money.parse(trade.unallocated, asset).isPositive();

  return (
    <>
      <PanelSection title={trade.direction === 'SELL_USDT' ? 'INR payout to the client' : 'USDT payout to the client'} aside={`${live.length} leg${live.length === 1 ? '' : 's'}`}>
        <SettlementFigures trade={trade} />
        {trade.hold && fundsIn ? (
          <Notice tone="danger" icon="lock">
            On hold: no leg can be created or sent until the blocking case is resolved.
          </Notice>
        ) : null}
        {!fundsIn && trade.lifecycle !== 'COMPLETED' && trade.lifecycle !== 'CANCELLED' ? (
          <Notice icon="clock">Payouts open once the client’s funds are confirmed.</Notice>
        ) : null}
      </PanelSection>

      {canOpenLeg ? <NewLeg trade={trade} autoFocus={focus === 'payout'} /> : null}

      {live.length > 0 || closed.length > 0 ? (
        <PanelSection title="Legs" testId="legs">
          <ul className={t.legs}>
            {[...live, ...closed].map((leg) => (
              <LegItem key={leg.id} trade={trade} leg={leg} perms={perms} autoFocus={focus === 'utr'} />
            ))}
          </ul>
        </PanelSection>
      ) : null}
      {focus === 'utr' && !live.some((l) => l.status === 'PROCESSING' || l.status === 'PENDING') ? <Notice>No leg is waiting for a reference on this trade.</Notice> : null}
    </>
  );
}

function NewLeg({ trade, autoFocus }: { trade: DeskTrade; autoFocus: boolean }) {
  const cmd = useCommand();
  const asset = trade.payoutOptions.asset;
  const direct = trade.payoutOptions.routeDirectAvailable;
  const [payer, setPayer] = useState<Payer>('EXCHANGE_ACCOUNT');
  const accounts = trade.payoutOptions.accounts;
  const wallets = trade.payoutOptions.wallets;
  // Default to the account with the most room today — the one least likely to refuse.
  const best = [...accounts].sort((a, b) => (Money.parse(b.availableToday, 'INR').minor > Money.parse(a.availableToday, 'INR').minor ? 1 : -1))[0];
  const [accountId, setAccountId] = useState(best?.accountId ?? '');
  const [walletId, setWalletId] = useState(wallets[0]?.walletId ?? '');
  const [amount, setAmount] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const unallocated = Money.parse(trade.unallocated, asset);
  const typed = parseAmount(amount, asset);
  const account = accounts.find((a) => a.accountId === accountId);
  const wallet = wallets.find((w) => w.walletId === walletId);
  const room = asset === 'INR' ? (payer === 'ROUTE' ? null : account ? Money.parse(account.availableToday, 'INR') : null) : wallet ? Money.parse(wallet.available, 'USDT') : null;

  const overTrade = typed !== null && typed.minor > unallocated.minor;
  const overRoom = typed !== null && room !== null && typed.minor > room.minor;
  const error = overTrade ? `More than the trade still owes (${money(trade.unallocated, asset)}).` : overRoom ? `More than ${asset === 'INR' ? 'this account has left today' : 'this wallet holds'} (${money(room!.toDecimalString(), asset)}).` : null;
  const ready = typed !== null && typed.isPositive() && !overTrade && !overRoom && !cmd.busy && (asset === 'USDT' ? walletId !== '' : payer === 'ROUTE' || accountId !== '');

  const fillMax = () => {
    const cap = room !== null && room.minor < unallocated.minor ? room : unallocated;
    setAmount(cap.toDecimalString());
    input.current?.focus();
  };

  const create = () => {
    if (!ready) return;
    void cmd
      .run(`Create ${money(amount, asset)} payout leg on ${trade.ref}`, (key) =>
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
      )
      .then((r) => {
        if (r.ok) setAmount('');
        return r;
      });
  };

  return (
    <PanelSection title="New payout leg" aside={`${money(trade.unallocated, asset)} unallocated`} testId="new-leg">
      {asset === 'INR' && direct ? (
        <Choices<Payer>
          legend="Paid by"
          value={payer}
          onChange={setPayer}
          choices={[
            { value: 'EXCHANGE_ACCOUNT', title: 'Exchange account', description: 'Uses today’s INR capacity' },
            {
              value: 'ROUTE',
              title: `Route pays directly${trade.payoutOptions.routeName ? ` · ${trade.payoutOptions.routeName}` : ''}`,
              description: direct ? 'One UTR completes the client leg and reduces the route side · no capacity used' : 'Not available: this trade’s route settles to the exchange',
              disabled: !direct,
            },
          ]}
        />
      ) : null}

      {asset === 'INR' && payer === 'EXCHANGE_ACCOUNT' ? (
        accounts.length === 0 ? (
          <Notice tone="warning">No active payout account. Open one on INR accounts first.</Notice>
        ) : (
          <Choices<string>
            legend="Pay from"
            value={accountId}
            onChange={setAccountId}
            choices={accounts.map((a) => {
              const short = typed !== null && Money.parse(a.availableToday, 'INR').minor < typed.minor;
              return {
                value: a.accountId,
                title: `${a.bankName} · ${a.label}`,
                aside: (
                  <span className={t.accountAvail} {...(short ? { 'data-short': '' } : {})}>
                    <strong>{money(a.availableToday, 'INR')}</strong> left today
                  </span>
                ),
                description: `••••${a.last4} · ${a.rails.join(' · ')}`,
                body: (
                  <Meter
                    size="sm"
                    label={`${money(a.availableToday, 'INR')} of ${money(a.capacityToday, 'INR')} available today`}
                    parts={[{ value: 100 - share(a.availableToday, a.capacityToday, 'INR'), tone: 'ink' }]}
                  />
                ),
              };
            })}
          />
        )
      ) : null}

      {asset === 'USDT' ? (
        <Choices<string>
          legend="Send from"
          value={walletId}
          onChange={setWalletId}
          choices={wallets.map((w) => ({ value: w.walletId, title: w.label, aside: <span className={t.accountAvail}><strong>{money(w.available, 'USDT')}</strong> free</span>, description: w.address }))}
        />
      ) : null}

      <AmountField
        label="Amount"
        currency={asset}
        value={amount}
        onChange={setAmount}
        error={error}
        inputRef={input}
        onEnter={create}
        hint={`Up to ${money(trade.unallocated, asset)} on this trade${room !== null && room.minor < unallocated.minor ? `, ${money(room.toDecimalString(), asset)} from this ${asset === 'INR' ? 'account today' : 'wallet'}` : ''} · Enter to create`}
        aside={
          <button type="button" className={d.linkButton} onClick={fillMax}>
            Fill max
          </button>
        }
      />
      <div className={d.actions}>
        <Button intent="primary" disabled={!ready} loading={cmd.busy} onClick={create}>
          {payer === 'ROUTE' ? 'Create route-paid leg' : asset === 'INR' ? 'Reserve & create leg' : 'Create leg'}
        </Button>
      </div>
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </PanelSection>
  );
}

function LegItem({ trade, leg, perms, autoFocus }: { trade: DeskTrade; leg: DeskLeg; perms: TradePerms; autoFocus: boolean }) {
  const cmd = useCommand();
  const [utr, setUtr] = useState('');
  const [hash, setHash] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [replaceReason, setReplaceReason] = useState('');
  const first = useRef<HTMLDivElement>(null);
  const route = leg.payer === 'ROUTE';
  const dim = leg.status === 'CANCELLED' || leg.status === 'FAILED';
  const canSend = route ? perms.routeSent : perms.sendPayout;
  const awaitingRef = leg.status === 'PROCESSING' && !leg.reference;
  const awaitingConfirm = leg.status === 'PROCESSING' && Boolean(leg.reference);
  const attention = (leg.status === 'PENDING' && canSend) || (awaitingRef && perms.recordUtr) || (awaitingConfirm && perms.confirmPayout);

  useEffect(() => {
    if (!autoFocus || !attention) return;
    first.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [autoFocus, attention]);

  const saveUtr = (replace?: string) =>
    cmd.run(`Record the reference for ${leg.ref}`, (key) =>
      recordEvidenceAction({ legId: leg.id, rail: 'IMPS', utr: normalizeUtr(utr), ...(replace ? { replaceReason: replace } : {}) }, key),
    );
  const saveHash = () =>
    cmd.run(`Record the transaction for ${leg.ref}`, (key) =>
      recordEvidenceAction({ legId: leg.id, txHash: hash.trim().replace(/^0x/, ''), logIndex: 0, fromAddress: leg.walletAddress ?? '' }, key),
    );

  return (
    <li className={t.leg} data-testid={`leg-${leg.ref}`} {...(attention ? { 'data-attention': '' } : {})} {...(dim ? { 'data-dim': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>{money(leg.amount, leg.asset, { exact: leg.asset === 'USDT' })}</span>
        <LegStatusChip status={leg.status} />
      </div>
      <div className={t.legMeta}>
        <span>{leg.ref}</span>
        <span>
          <strong>{route ? `Route · ${leg.routeName ?? 'direct'}` : leg.asset === 'INR' ? (leg.accountLabel ?? 'Exchange account') : 'Treasury'}</strong>
        </span>
        {leg.reference ? <span className={d.mono}>{leg.referenceKind === 'TX' ? `tx ${shortenHash(leg.reference)}` : `UTR ${maskUtr(leg.reference)}`}</span> : null}
        <span>
          {leg.confirmedAt ? `confirmed ${time(leg.confirmedAt)}` : leg.sentAt ? `sent ${time(leg.sentAt)}` : `created ${time(leg.createdAt)}`}
        </span>
      </div>
      {leg.failureReason ? <Notice {...(leg.status === 'FAILED' ? { tone: 'danger' as const } : {})}>{leg.failureReason}</Notice> : null}

      {!dim && leg.status !== 'COMPLETED' ? (
        <div className={t.legNext} ref={first}>
          {leg.status === 'PENDING' ? (
            <>
              <span className={t.legNextLabel}>Next · send it</span>
              <div className={d.actions}>
                {canSend ? (
                  <Button intent="primary" size="sm" disabled={cmd.busy || trade.hold} onClick={() => cmd.run(`Mark ${leg.ref} sent`, (key) => sendPayoutLegAction({ legId: leg.id }, key))}>
                    {route ? 'Route reported sent' : 'Mark sent'}
                  </Button>
                ) : (
                  <span className={d.muted}>Sending needs the settlement role.</span>
                )}
                {perms.cancelPayout ? (
                  <GuardedAction
                    label="Cancel leg"
                    trigger="ghost"
                    stepUp
                    busy={cmd.busy}
                    consequence={`The leg is withdrawn before anything is sent${leg.asset === 'INR' && !route ? ' and its capacity reservation is released' : ''}. The amount returns to unallocated.`}
                    reasonLabel="Why"
                    onConfirm={async (reason) => (await cmd.run(`Cancel ${leg.ref}`, (key) => cancelPayoutAction({ legId: leg.id, reason }, key))).ok}
                  />
                ) : null}
              </div>
            </>
          ) : null}

          {awaitingRef ? (
            <>
              <span className={t.legNextLabel}>Next · record the {leg.asset === 'INR' ? 'bank reference' : 'transaction'}</span>
              {perms.recordUtr ? (
                leg.asset === 'INR' ? (
                  <>
                    <UTRField value={utr} onChange={setUtr} />
                    <div className={d.actions}>
                      <Button intent="primary" size="sm" disabled={cmd.busy || utr.length < 6} onClick={() => void saveUtr()}>
                        Save UTR
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <TextField label="Transaction hash" value={hash} onChange={(v) => setHash(v.trim())} mono hint={leg.walletAddress ? `From ${leg.walletAddress}` : undefined} />
                    <div className={d.actions}>
                      <Button intent="primary" size="sm" disabled={cmd.busy || hash.replace(/^0x/, '').length < 64} onClick={() => void saveHash()}>
                        Save transaction
                      </Button>
                    </div>
                  </>
                )
              ) : (
                <span className={d.muted}>Recording a reference needs the settlement role.</span>
              )}
            </>
          ) : null}

          {awaitingConfirm ? (
            <>
              <span className={t.legNextLabel}>Next · confirm it arrived</span>
              <div className={d.actions}>
                {perms.confirmPayout ? (
                  <Button
                    intent="primary"
                    size="sm"
                    disabled={cmd.busy}
                    shortcut={<StepUpMark label="needs your authenticator code" />}
                    onClick={() => cmd.run(`Confirm payout ${money(leg.amount, leg.asset)} · ${leg.ref}`, (key) => confirmPayoutAction({ legId: leg.id }, key))}
                  >
                    Confirm
                  </Button>
                ) : (
                  <span className={d.muted}>Confirming needs the settlement role.</span>
                )}
                {perms.changeUtr && leg.asset === 'INR' && !replacing ? (
                  <button type="button" className={d.linkButton} onClick={() => setReplacing(true)}>
                    Replace reference
                  </button>
                ) : null}
              </div>
              {replacing ? (
                <div className={d.guard}>
                  <p className={d.guardTitle}>Replace the recorded reference?</p>
                  <p className={d.guardBody}>The old reference is voided, not deleted; both stay on the record with your reason.</p>
                  <UTRField value={utr} onChange={setUtr} label="Correct UTR / reference" />
                  <TextField label="Why" value={replaceReason} onChange={setReplaceReason} />
                  <div className={d.actions}>
                    <Button
                      intent="primary"
                      size="sm"
                      disabled={cmd.busy || utr.length < 6 || replaceReason.trim().length < 3}
                      shortcut={<StepUpMark label="needs your authenticator code" />}
                      onClick={() =>
                        void saveUtr(replaceReason.trim()).then((r) => {
                          if (r.ok) setReplacing(false);
                        })
                      }
                    >
                      Replace reference
                    </Button>
                    <Button intent="ghost" size="sm" onClick={() => setReplacing(false)}>
                      Keep as is
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {leg.status === 'PROCESSING' && perms.failPayout ? (
            <GuardedAction
              label="Mark failed"
              trigger="ghost"
              tone="danger"
              stepUp
              busy={cmd.busy}
              consequence={`Records that ${money(leg.amount, leg.asset)} never reached the client${leg.asset === 'INR' && !route ? ', returns the capacity it used to today' : ''} and opens a “bank transfer failed” case asking for a replacement leg.`}
              reasonLabel="What the bank or route said"
              onConfirm={async (reason) => (await cmd.run(`Mark ${leg.ref} failed`, (key) => failPayoutAction({ legId: leg.id, reason }, key))).ok}
            />
          ) : null}
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

/** The account picker for INR the desk collects or refunds through (BUY first leg, refunds). */
export function AccountSelect({ label, accounts, value, onChange }: { label: string; accounts: readonly { accountId: string; label: string; bankName: string; last4: string }[]; value: string; onChange: (v: string) => void }) {
  return <SelectField label={label} value={value} onChange={onChange} options={accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${a.label}` }))} />;
}
