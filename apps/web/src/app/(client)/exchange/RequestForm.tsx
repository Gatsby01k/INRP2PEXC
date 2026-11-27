'use client';

import type { Protection } from '../../../server/client.ts';
import { type FocusEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader, DirectionToggle, sanitizeAmountInput } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { requestQuoteAction } from '../../../server/actions/client.ts';
import { ArrowIcon, BankIcon, ChevronDownIcon, InfoIcon, LockIcon, PlusIcon, SwapIcon, WalletIcon } from '../_workspace/icons.tsx';
import { AddDestination } from '../destinations/AddDestination.tsx';
import { BankMark } from '../../../components/PayMarks.tsx';
import { useMarket } from '../_workspace/useMarket.ts';
import type { Direction, RequestDraft } from './ExchangeScreen.tsx';
import { LEGS, LegInput, sideOf } from './Legs.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

const hasAmount = (value: string) => /[1-9]/.test(value);

/** Sizes a client usually asks for, one tap each (mock-up v3). */
const QUICK = [
  { label: '1k', amount: '1000' },
  { label: '5k', amount: '5000' },
  { label: '10k', amount: '10000' },
  { label: '50k', amount: '50000' },
] as const;

/** The client's own price as it types it (ADR 0033: a bound — never a worse price): digits and one point, four places at most. */
const sanitizeRate = (raw: string): string | null => {
  const v = raw.replace(/[^\d.]/g, '');
  return /^\d{0,4}(\.\d{0,4})?$/.test(v) ? v : null;
};

export interface Who {
  readonly isAdmin: boolean;
  /** What protects this person's changes (ADR 0026). */
  readonly protection: Protection;
  readonly email: string;
  readonly clientName: string;
}

/**
 * Asking the desk for a price, as a calculator: the direction, an amount on either side (with the sizes a desk is
 * usually asked for one tap away), where the money lands, and — for a client with a number in mind — the rate they
 * are after. Nothing here computes a price: the desk does, and answers with a firm quote.
 *
 * A client with nowhere to be paid yet is not stopped with a warning: the place the destination goes offers to add
 * one, in a sheet over the ticket, and the request is waiting with its amount when they come back.
 *
 * The robot hears about the real changes and nothing else — the first move in the form, a value, a direction, the
 * client on the call to action, a request that cannot go as it is, one on its way, one the desk now has.
 */
export function RequestForm({ view, draft, who }: { view: ExchangeView; draft?: RequestDraft; who: Who }) {
  const { run, busy, error, dialog } = useCommand();
  const [direction, setDirection] = useState<Direction>(draft?.direction ?? 'SELL_USDT');
  const [fixedSide, setFixedSide] = useState<'BASE' | 'QUOTE'>(draft?.fixedSide ?? 'BASE');
  const [amount, setAmount] = useState(draft?.amount ?? '');
  const [missing, setMissing] = useState(false);
  const [targetOpen, setTargetOpen] = useState(Boolean(draft?.targetRate));
  const [targetRate, setTargetRate] = useState(draft?.targetRate ?? '');
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<'bank' | 'wallet' | null>(null);
  const banks = view.destinations.banks;
  const wallets = view.destinations.wallets.filter((w) => w.purpose !== 'SOURCE');
  const [bankId, setBankId] = useState(banks[0]?.id ?? '');
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? '');
  const sell = direction === 'SELL_USDT';
  const bank = banks.find((b) => b.id === bankId) ?? banks[0];
  const wallet = wallets.find((w) => w.id === walletId) ?? wallets[0];
  const destinationId = (sell ? bank?.id : wallet?.id) ?? '';
  const options = sell ? banks.length : wallets.length;
  // Buying, the client pays from a bank account of its own that is on file — asked for before the price, not when the
  // seller's USDT is already locked and the time to pay is running.
  // A UPI ID of its own is enough to pay from (ADR 0029); one paused after a payer's report is not, until INRP2P decides (ADR 0030).
  const upiPayFrom = view.destinations.upiIds.filter((u) => u.status === 'ACTIVE');
  const payFromMissing = !sell && banks.length === 0 && upiPayFrom.length === 0;
  const inputs = useRef<Record<'BASE' | 'QUOTE', HTMLInputElement | null>>({ BASE: null, QUOTE: null });
  // The other side, about, at the market's rate for this direction — said as an estimate, never sent: the desk prices it.
  const market = useMarket();
  const marketRate = market ? Number((sell ? market.SELL_USDT : market.BUY_USDT) ?? NaN) : NaN;
  const typed = hasAmount(amount) ? Number(amount) : NaN;
  const about = Number.isFinite(marketRate) && marketRate > 0 && Number.isFinite(typed)
    ? fixedSide === 'BASE'
      ? `₹${(typed * marketRate).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
      : (typed / marketRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : null;
  const hintId = useId();

  const onCta = useRef({ hover: false, focus: false });
  const markCta = (key: 'hover' | 'focus', on: boolean) => {
    onCta.current[key] = on;
    robotCues.setFocus(onCta.current.hover || onCta.current.focus ? 'cta' : 'none');
  };
  useEffect(() => () => robotCues.setFocus('none'), []);
  const engaged = useRef(false);
  const engage = (e: PointerEvent | FocusEvent) => {
    if (engaged.current) return;
    if (e.target instanceof Element && e.target.closest('[data-robot-target="cta"]')) return;
    engaged.current = true;
    robotCues.emit({ kind: 'engage' });
  };

  const changeDirection = (next: Direction) => {
    if (next === direction) return;
    setDirection(next);
    setPicking(false);
    robotCues.emit({ kind: 'direction', direction: next });
  };
  const changeAmount = (side: 'BASE' | 'QUOTE', raw: string) => {
    const next = sanitizeAmountInput(raw, side === 'BASE' ? 'USDT' : 'INR');
    // Only a real change of the number is news to the robot: a refused character, or one that changes nothing, is not.
    if (next === null || (next === amount && side === fixedSide)) return;
    setFixedSide(side);
    setAmount(next);
    if (hasAmount(next)) setMissing(false);
    robotCues.emit({ kind: 'value' });
  };

  const submit = async () => {
    if (destinationId === '') {
      if (who.isAdmin) setAdding(sell ? 'bank' : 'wallet');
      return;
    }
    if (payFromMissing) {
      if (who.isAdmin) setAdding('bank');
      return;
    }
    if (!hasAmount(amount)) {
      setMissing(true);
      robotCues.emit({ kind: 'problem' });
      inputs.current[fixedSide]?.focus();
      return;
    }
    robotCues.emit({ kind: 'wait', on: true });
    const target = targetOpen && /[1-9]/.test(targetRate) ? targetRate : null;
    const out = await run('Request a quote', (key) =>
      requestQuoteAction({ direction, fixedSide, amount, targetRate: target, ...(sell ? { bankAccountId: destinationId } : { walletId: destinationId }) }, key),
    );
    robotCues.emit({ kind: 'wait', on: false });
    robotCues.emit(out.ok ? { kind: 'submitted' } : { kind: 'problem' });
  };

  const request = view.request;
  const legs = LEGS[direction];
  const noDestination = destinationId === '';

  return (
    <>
      <form
        className={`${shell.surface} ${styles.ticket}`}
        aria-label="Request a quote"
        data-robot-target="panel"
        onPointerDownCapture={engage}
        onFocusCapture={engage}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {request?.status === 'DECLINED' && request.noPrice ? (
          <p className={shell.info} data-tone="warning" role="status">
            <InfoIcon className={shell.infoIcon} />
            <span>
              {request.statusReason ?? 'Nobody took it. Nothing was committed — ask again whenever you like.'}{' '}
              {request.waitingUntil === null ? (
                <Link className={shell.textAction} href={`/exchange?again=${encodeURIComponent(request.ref)}`}>
                  Keep looking
                </Link>
              ) : null}
            </span>
          </p>
        ) : request?.status === 'DECLINED' ? (
          <p className={shell.info} data-tone="warning" role="status">
            <InfoIcon className={shell.infoIcon} />
            <span>
              The desk declined {request.ref}
              {request.statusReason ? `: “${request.statusReason}”` : '.'} You can send a new request.
            </span>
          </p>
        ) : view.makerDealRef ? (
          <p className={shell.info} data-tone="success" role="status">
            <InfoIcon className={shell.infoIcon} />
            <span>
              Another client met your price — your deal {view.makerDealRef} is under way.{' '}
              <Link className={shell.textAction} href={`/deals/${view.makerDealRef}`}>
                Open the deal
              </Link>
            </span>
          </p>
        ) : view.openTradeRef ? (
          <p className={shell.info}>
            <InfoIcon className={shell.infoIcon} />
            <span>
              Your last quote became trade {view.openTradeRef}.{' '}
              <Link className={shell.textAction} href={`/trades/${view.openTradeRef}`}>
                Open the trade
              </Link>
            </span>
          </p>
        ) : null}

        <div className={styles.direction} data-robot-target="toggle">
          <DirectionToggle value={direction} onChange={changeDirection} />
        </div>

        <div className={styles.legs} data-robot-target="amount">
          {legs.map((leg) => {
            const side = sideOf(leg.currency);
            return (
              <LegInput
                key={leg.currency}
                ref={(el) => {
                  inputs.current[side] = el;
                }}
                label={leg.label}
                currency={leg.currency}
                value={amount}
                fixed={fixedSide === side}
                invalid={missing && fixedSide === side}
                describedBy={hintId}
                {...(fixedSide !== side && about ? { about } : {})}
                onChange={(raw) => changeAmount(side, raw)}
                extra={
                  leg.currency === 'USDT' ? (
                    <span className={styles.chips} role="group" aria-label="Quick amounts in USDT">
                      {QUICK.map((q) => (
                        <button
                          key={q.amount}
                          type="button"
                          className={styles.chip}
                          aria-pressed={fixedSide === 'BASE' && amount === q.amount}
                          onClick={() => changeAmount('BASE', q.amount)}
                        >
                          {q.label}
                        </button>
                      ))}
                    </span>
                  ) : null
                }
              />
            );
          })}
          {/* The two sides meet at one round button: it turns the request round — sell becomes buy. */}
          <button
            type="button"
            className={styles.join}
            aria-label={sell ? 'Switch to buying USDT' : 'Switch to selling USDT'}
            onClick={() => changeDirection(sell ? 'BUY_USDT' : 'SELL_USDT')}
          >
            <SwapIcon />
          </button>
        </div>
        <p id={hintId} className={styles.hint} data-desk-only={missing ? undefined : ''} {...(missing ? { role: 'alert' } : {})}>
          {missing ? 'Enter an amount in either box.' : 'Type in either box — the desk prices the other side.'}
        </p>

        <fieldset className={styles.payTo}>
          <legend className={styles.payToLabel}>{sell ? 'INR paid to' : 'USDT delivered to'}</legend>
          {noDestination ? (
            <button type="button" className={styles.addDestination} onClick={() => setAdding(sell ? 'bank' : 'wallet')} disabled={!who.isAdmin}>
              <span className={styles.addIcon} aria-hidden="true">
                {who.isAdmin ? <PlusIcon /> : sell ? <BankIcon /> : <WalletIcon />}
              </span>
              <span className={styles.destinationText}>
                <span className={styles.destinationName}>{sell ? 'Add the bank account you are paid to' : 'Add the wallet USDT is delivered to'}</span>
                <span className={styles.destinationMeta}>
                  {who.isAdmin ? 'It takes a minute, and you stay on this page.' : `An administrator of ${who.clientName} adds it.`}
                </span>
              </span>
              {who.isAdmin ? <ArrowIcon className={styles.addArrow} /> : null}
            </button>
          ) : options === 1 ? (
            <div className={`${styles.destination} ${styles.destinationStatic}`}>
              <Chosen sell={sell} bank={bank} wallet={wallet} />
              <Link className={styles.change} href="/destinations">
                Manage
              </Link>
            </div>
          ) : (
            <>
              <button type="button" className={styles.destination} aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
                <Chosen sell={sell} bank={bank} wallet={wallet} />
                <span className={styles.change}>
                  Change
                  <ChevronDownIcon />
                </span>
              </button>
              {picking ? (
                <div className={styles.destinationList} role="radiogroup" aria-label={sell ? 'Bank account' : 'Wallet'}>
                  {sell
                    ? banks.map((b) => (
                        <label key={b.id} className={styles.destination}>
                          <input type="radio" name="destination" checked={b.id === bank?.id} onChange={() => (setBankId(b.id), setPicking(false))} />
                          <BankMark ifsc={b.ifsc} name={b.bankName} size={36} />
                          <span className={styles.destinationText}>
                            <span className={styles.destinationName}>
                              {b.bankName} •••• {b.last4}
                            </span>
                            <span className={styles.destinationMeta}>{b.holderName}</span>
                          </span>
                          <span className={styles.radioMark} aria-hidden="true" />
                        </label>
                      ))
                    : wallets.map((w) => (
                        <label key={w.id} className={styles.destination}>
                          <input type="radio" name="destination" checked={w.id === wallet?.id} onChange={() => (setWalletId(w.id), setPicking(false))} />
                          <span className={styles.monogram} data-kind="wallet" aria-hidden="true">
                            T
                          </span>
                          <span className={styles.destinationText}>
                            <span className={styles.destinationName}>{w.label}</span>
                            <span className={styles.destinationMeta}>TRC20 · {shortenAddress(w.address, 6, 6)}</span>
                          </span>
                          <span className={styles.radioMark} aria-hidden="true" />
                        </label>
                      ))}
                </div>
              ) : null}
            </>
          )}
        </fieldset>

        {sell || noDestination ? null : payFromMissing ? (
          <fieldset className={styles.payTo}>
            <legend className={styles.payToLabel}>You pay from</legend>
            <button type="button" className={styles.addDestination} onClick={() => setAdding('bank')} disabled={!who.isAdmin}>
              <span className={styles.addIcon} aria-hidden="true">
                {who.isAdmin ? <PlusIcon /> : <BankIcon />}
              </span>
              <span className={styles.destinationText}>
                <span className={styles.destinationName}>Add the bank account you pay from</span>
                <span className={styles.destinationMeta}>
                  {who.isAdmin ? 'Or a UPI ID, on Bank & wallets. The seller takes rupees only from your own.' : `An administrator of ${who.clientName} adds it.`}
                </span>
              </span>
              {who.isAdmin ? <ArrowIcon className={styles.addArrow} /> : null}
            </button>
          </fieldset>
        ) : (
          <p className={styles.hint} data-desk-only="">
            You pay from your own {banks[0] ? `account: ${banks[0].bankName} •••• ${banks[0].last4}` : `UPI ID: ${upiPayFrom[0]!.vpa}`}
            {banks.length + upiPayFrom.length > 1 ? ' or another of your own' : ''}.
          </p>
        )}

        <div className={styles.target}>
          {targetOpen ? (
            <div className={styles.targetRow}>
              <div className={`${styles.leg} ${styles.targetField}`} data-fixed="true">
                <label className={styles.legLabel} htmlFor={`${hintId}-target`}>
                  {sell ? 'Your price · not below' : 'Your price · not above'}
                </label>
                <div className={styles.legBox}>
                  <span className={styles.targetUnit}>₹</span>
                  <input
                    id={`${hintId}-target`}
                    className={`${styles.legInput} ${styles.targetInput}`}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="102.00"
                    value={targetRate}
                    onChange={(e) => {
                      const v = sanitizeRate(e.target.value);
                      if (v !== null) setTargetRate(v);
                    }}
                    autoFocus
                  />
                  <span className={styles.targetUnit}>per USDT</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.targetToggle}
                onClick={() => {
                  setTargetOpen(false);
                  setTargetRate('');
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <button type="button" className={styles.targetToggle} onClick={() => setTargetOpen(true)}>
              <PlusIcon />
              Set your price
            </button>
          )}
        </div>

        <div className={styles.cta}>
          <button
            type="submit"
            className={`${shell.action} ${shell.wide}`}
            data-robot-target="cta"
            disabled={busy || ((noDestination || payFromMissing) && !who.isAdmin)}
            aria-busy={busy || undefined}
            onPointerEnter={() => markCta('hover', true)}
            onPointerLeave={() => markCta('hover', false)}
            onFocus={() => markCta('focus', true)}
            onBlur={() => markCta('focus', false)}
          >
            {busy ? <ArcLoader size="sm" label="Sending your request" tone="inherit" /> : null}
            <span>{noDestination ? (sell ? 'Add a bank account to continue' : 'Add a wallet to continue') : payFromMissing ? 'Add a bank account to continue' : 'Request firm quote'}</span>
            {busy ? null : <ArrowIcon className={shell.actionIcon} />}
          </button>
          {error ? (
            <p className={shell.error} role="alert">
              {error}
            </p>
          ) : null}
          <p className={styles.fine} data-desk-only="">
            <LockIcon />
            <span>The desk replies with a firm rate, held for a short time. Nothing is committed until you accept it.</span>
          </p>
        </div>
      </form>
      {dialog}
      <AddDestination
        open={adding !== null}
        kind={adding ?? (sell ? 'bank' : 'wallet')}
        onClose={() => setAdding(null)}
        protection={who.protection}
        email={who.email}
        holderName={who.clientName}
        next="exchange"
        firstOfKind={(adding ?? (sell ? 'bank' : 'wallet')) === 'bank' ? banks.length === 0 : view.destinations.wallets.length === 0}
      />
    </>
  );
}

function Chosen({ sell, bank, wallet }: { sell: boolean; bank: ExchangeView['destinations']['banks'][number] | undefined; wallet: ExchangeView['destinations']['wallets'][number] | undefined }) {
  if (sell && bank) {
    return (
      <>
        <BankMark ifsc={bank.ifsc} name={bank.bankName} size={36} />
        <span className={styles.destinationText}>
          <span className={styles.destinationName}>
            {bank.bankName} •••• {bank.last4}
          </span>
          <span className={styles.destinationMeta}>{bank.holderName}</span>
        </span>
      </>
    );
  }
  if (!sell && wallet) {
    return (
      <>
        <span className={styles.monogram} data-kind="wallet" aria-hidden="true">
          T
        </span>
        <span className={styles.destinationText}>
          <span className={styles.destinationName}>{wallet.label}</span>
          <span className={styles.destinationMeta} title={wallet.address}>
            TRC20 · {shortenAddress(wallet.address, 6, 6)}
          </span>
        </span>
      </>
    );
  }
  return <SwapIcon />;
}
