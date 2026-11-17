import type { ReactNode } from 'react';
import type { ClientDestinations } from '@inrp2p/portal';
import { Amount } from '../../../components/Amount.tsx';
import { Coin } from '../../../components/Coin.tsx';
import { BankMark, RailMark } from '../../../components/PayMarks.tsx';
import { ClockIcon, RateIcon, ShieldIcon, WalletIcon, BoltIcon } from '../_workspace/icons.tsx';
import shell from '../shell.module.css';
import stage from './stage.module.css';

/**
 * A request as the client made it, on its sheet beside the stage: the side (Sell or Buy, as the switch it was chosen
 * with), what the client gives in a well, then a row each for where the money lands (the bank's own tile and the ways
 * it is paid, or the wallet), the target rate, the network's cost and when the request was sent — and at its foot the
 * one sentence that makes the deal safe. Read-only: what can still be done with it is passed in (`children`).
 */
export function RequestSheet({
  direction,
  amount,
  currency,
  destination,
  destinations,
  targetRate,
  sentAt,
  reference,
  networkFee,
  children,
}: {
  direction: 'SELL_USDT' | 'BUY_USDT';
  /** What the client gives, formatted for the well (no unit). */
  amount: string;
  currency: 'USDT' | 'INR';
  /** The destination as the projection words it: "HDFC Bank •••• 8219", or a wallet. */
  destination: string;
  destinations: ClientDestinations;
  targetRate: string | null;
  sentAt: string | null;
  reference: string | null;
  /** The network's line (ADR 0028), already worded: "2 USDT, out of what you send". */
  networkFee: string | null;
  children?: ReactNode;
}) {
  const sell = direction === 'SELL_USDT';
  const bank = sell ? destinations.banks.find((b) => destination.includes(b.last4) && destination.includes(b.bankName)) : undefined;
  const wallet = sell ? undefined : destinations.wallets.find((w) => destination.includes(w.label) || destination.includes(w.address.slice(-4)));
  return (
    <div className={`${shell.surface} ${stage.ask}`}>
      {/* The side, as the switch it was chosen with: here it says, it does not switch. */}
      <div className={stage.seg} aria-hidden="true">
        <span data-on={sell || undefined}>Sell USDT</span>
        <span data-on={!sell || undefined}>Buy USDT</span>
      </div>
      <span className="ix-visually-hidden">{sell ? 'Sell USDT' : 'Buy USDT'}</span>

      <div className={`${shell.well} ${stage.askWell}`}>
        <span className={shell.label}>{sell ? 'You sell' : 'You pay'}</span>
        <span className={stage.askRow}>
          <span className={stage.askFigure}>
            <Amount value={currency === 'INR' ? `₹${amount}` : amount} />
          </span>
          <span className={stage.askCoin}>
            <Coin currency={currency} size={32} />
            {currency}
            <small>{currency === 'USDT' ? 'TRC20' : 'Bank transfer'}</small>
          </span>
        </span>
      </div>

      <div className={stage.rows}>
        <div className={stage.rowl}>
          {bank ? (
            <BankMark ifsc={bank.ifsc} name={bank.bankName} size={38} />
          ) : sell ? (
            <span className={stage.tile}>
              <WalletIcon />
            </span>
          ) : (
            <Coin currency="USDT" size={38} />
          )}
          <span className={stage.rowText}>
            <span className={shell.label}>{sell ? 'INR paid to' : 'USDT delivered to'}</span>
            <b>{destination}</b>
          </span>
          {bank && bank.rails.length > 0 ? (
            <span className={stage.rowEnd}>
              {bank.rails.slice(0, 2).map((r) => (
                <RailMark key={r} rail={r} />
              ))}
            </span>
          ) : wallet ? (
            <span className={stage.rowEnd}>
              <span className={stage.mono}>TRC20</span>
            </span>
          ) : null}
        </div>
        {targetRate ? (
          <div className={stage.rowl}>
            <span className={stage.tile}>
              <RateIcon />
            </span>
            <span className={stage.rowText}>
              <span className={shell.label}>Your target rate</span>
              <b>{targetRate} per USDT</b>
            </span>
          </div>
        ) : null}
        {networkFee ? (
          <div className={stage.rowl}>
            <span className={stage.tile}>
              <BoltIcon />
            </span>
            <span className={stage.rowText}>
              <span className={shell.label}>Network fee</span>
              <b>{networkFee}</b>
            </span>
          </div>
        ) : null}
        {sentAt ? (
          <div className={stage.rowl}>
            <span className={stage.tile}>
              <ClockIcon />
            </span>
            <span className={stage.rowText}>
              <span className={shell.label}>Request</span>
              <b>Sent at {sentAt}</b>
            </span>
            {reference ? <span className={`${stage.rowEnd} ${stage.mono}`}>{reference}</span> : null}
          </div>
        ) : null}
      </div>

      {children ? <div className={stage.askFoot}>{children}</div> : null}

      <p className={stage.askNote}>
        <ShieldIcon />
        {sell ? 'Your USDT waits in escrow until the rupees are in your bank' : 'The seller’s USDT is locked in escrow before you pay anything'}
      </p>
    </div>
  );
}
