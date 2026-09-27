'use client';

import { type FocusEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader, DirectionToggle, sanitizeAmountInput } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { requestQuoteAction } from '../../../server/actions/client.ts';
import { ArrowIcon, BankIcon, InfoIcon, WalletIcon } from '../_workspace/icons.tsx';
import type { Direction, RequestDraft } from './ExchangeScreen.tsx';
import { LEGS, LegInput, sideOf } from './Legs.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

const hasAmount = (value: string) => /[1-9]/.test(value);

/**
 * Asking the desk for a price: a direction, an amount on either side, and where the money goes.
 *
 * The robot hears about the real changes and nothing else — the first move in the form, a value, a direction, the
 * client on the call to action, a request that cannot go as it is, one on its way, one the desk now has.
 */
export function RequestForm({ view, draft }: { view: ExchangeView; draft?: RequestDraft }) {
  const { run, busy, error, dialog } = useCommand();
  const [direction, setDirection] = useState<Direction>(draft?.direction ?? 'SELL_USDT');
  const [fixedSide, setFixedSide] = useState<'BASE' | 'QUOTE'>('BASE');
  const [amount, setAmount] = useState(draft?.amount ?? '');
  const [missing, setMissing] = useState(false);
  const banks = view.destinations.banks;
  const wallets = view.destinations.wallets.filter((w) => w.purpose !== 'SOURCE');
  const [bankId, setBankId] = useState(banks[0]?.id ?? '');
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? '');
  const sell = direction === 'SELL_USDT';
  const destinationId = sell ? bankId : walletId;
  const inputs = useRef<Record<'BASE' | 'QUOTE', HTMLInputElement | null>>({ BASE: null, QUOTE: null });
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
    robotCues.emit({ kind: 'direction', direction: next });
  };
  const changeAmount = (side: 'BASE' | 'QUOTE', raw: string) => {
    const next = sanitizeAmountInput(raw, side === 'BASE' ? 'USDT' : 'INR');
    if (next === null) return;
    setFixedSide(side);
    setAmount(next);
    if (hasAmount(next)) setMissing(false);
    robotCues.emit({ kind: 'value' });
  };

  const submit = async () => {
    if (!hasAmount(amount)) {
      setMissing(true);
      robotCues.emit({ kind: 'problem' });
      inputs.current[fixedSide]?.focus();
      return;
    }
    robotCues.emit({ kind: 'wait', on: true });
    const out = await run('Request a quote', (key) =>
      requestQuoteAction({ direction, fixedSide, amount, ...(sell ? { bankAccountId: bankId } : { walletId }) }, key),
    );
    robotCues.emit({ kind: 'wait', on: false });
    robotCues.emit(out.ok ? { kind: 'submitted' } : { kind: 'problem' });
  };

  const request = view.request;
  const legs = LEGS[direction];
  const destinations = sell ? banks : wallets;

  return (
    <>
      <form
        className={shell.surface}
        aria-label="Request a quote"
        data-robot-target="panel"
        onPointerDownCapture={engage}
        onFocusCapture={engage}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {request?.status === 'DECLINED' ? (
          <p className={shell.info} data-tone="warning" role="status">
            <InfoIcon className={shell.infoIcon} />
            <span>
              The desk declined {request.ref}
              {request.statusReason ? `: “${request.statusReason}”` : '.'} You can send a new request.
            </span>
          </p>
        ) : view.openTradeRef ? (
          <p className={shell.info}>
            <InfoIcon className={shell.infoIcon} />
            <span>
              Your last quote became trade {view.openTradeRef}.{' '}
              <Link className={shell.textAction} href={`/trades/${view.openTradeRef}`}>
                View the trade
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
                onChange={(raw) => changeAmount(side, raw)}
              />
            );
          })}
          <p id={hintId} className={styles.hint} {...(missing ? { role: 'alert' } : {})}>
            {missing ? 'Enter an amount in either box.' : 'Type in either box — the desk prices the other side.'}
          </p>
        </div>

        <fieldset className={styles.destinations}>
          <legend className={shell.label}>{sell ? 'Receive INR to' : 'Deliver USDT to'}</legend>
          {destinations.length === 0 ? (
            <p className={shell.info} data-tone="warning">
              <InfoIcon className={shell.infoIcon} />
              <span>
                {sell ? 'INR payouts need a bank account on file.' : 'USDT deliveries need a TRC20 wallet on file.'} The desk adds destinations to your account —{' '}
                <Link className={shell.textAction} href="/destinations">
                  see Destinations
                </Link>
                .
              </span>
            </p>
          ) : sell ? (
            banks.map((b) => (
              <label key={b.id} className={styles.option}>
                <input className={styles.radio} type="radio" name="destination" value={b.id} checked={b.id === bankId} onChange={() => setBankId(b.id)} />
                <span className={styles.optionIcon}>
                  <BankIcon />
                </span>
                <span className={styles.optionText}>
                  <span className={styles.optionName}>
                    {b.bankName} •••• {b.last4}
                    {b.verified ? <span className={styles.tag}>Verified</span> : null}
                  </span>
                  <span className={styles.optionMeta}>
                    {b.holderName}
                    {b.rails.length > 0 ? ` · ${b.rails.join(' / ')}` : ''}
                  </span>
                </span>
                <span className={styles.optionCheck} aria-hidden="true" />
              </label>
            ))
          ) : (
            wallets.map((w) => (
              <label key={w.id} className={styles.option}>
                <input className={styles.radio} type="radio" name="destination" value={w.id} checked={w.id === walletId} onChange={() => setWalletId(w.id)} />
                <span className={styles.optionIcon}>
                  <WalletIcon />
                </span>
                <span className={styles.optionText}>
                  <span className={styles.optionName} title={w.address}>
                    TRC20 · {shortenAddress(w.address)}
                  </span>
                  <span className={styles.optionMeta}>{w.label}</span>
                </span>
                <span className={styles.optionCheck} aria-hidden="true" />
              </label>
            ))
          )}
        </fieldset>

        <p className={shell.info}>
          <InfoIcon className={shell.infoIcon} />
          <span>The desk prices this and sends you a firm quote with the time it is held for. Nothing is committed until you accept it.</span>
        </p>

        <button
          type="submit"
          className={`${shell.action} ${shell.wide}`}
          data-robot-target="cta"
          disabled={busy || destinationId === ''}
          aria-busy={busy || undefined}
          onPointerEnter={() => markCta('hover', true)}
          onPointerLeave={() => markCta('hover', false)}
          onFocus={() => markCta('focus', true)}
          onBlur={() => markCta('focus', false)}
        >
          {busy ? <ArcLoader size="sm" label="Sending your request" tone="inherit" /> : null}
          <span>Request quote</span>
          {busy ? null : <ArrowIcon className={shell.actionIcon} />}
        </button>
        {error ? (
          <p className={shell.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
      {dialog}
    </>
  );
}
