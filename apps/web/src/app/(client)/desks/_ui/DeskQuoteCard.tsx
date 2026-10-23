'use client';

import { useRouter } from 'next/navigation';
import { Rate } from '@inrp2p/kernel';
import type { ClientQuoteView } from '@inrp2p/quotes';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstTime, formatRate } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { acceptQuoteAction } from '../../../../server/actions/client.ts';
import { playSound } from '../../_assistant/sound.ts';
import { ArrowIcon, InfoIcon, LockIcon } from '../../_workspace/icons.tsx';
import { legAmount } from '../../exchange/amounts.ts';
import { Countdown } from '../../exchange/QuoteCard.tsx';
import shell from '../../shell.module.css';
import ex from '../../exchange/exchange.module.css';

/**
 * A desk's firm price (ADR 0020), as an execution ticket: what the client gets, for what, at the desk's rate, how long it
 * is held, where it lands, and how a deal with this desk settles — rupees straight between them, the USDT in the deal's
 * own escrow. Accepting opens the trade and takes the client to it. When the price lapses, a new one is a tap away.
 */
export function DeskQuoteCard({ quote, deskName, canAccept, now, onAgain, againLabel = 'Get a new price' }: { quote: ClientQuoteView; deskName: string; canAccept: boolean; now: number; onAgain: () => void; againLabel?: string }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const expiresAt = new Date(quote.expiresAt!);
  const lapsed = now >= expiresAt.getTime();
  const sell = quote.direction === 'SELL_USDT';
  const rate = formatRate(Rate.parse(quote.clientRate, 'CLIENT'));
  const usdt = legAmount(quote.base.amount, 'USDT');
  const inr = legAmount(quote.inr.amount, 'INR');

  const accept = async () => {
    const out = await run(`Accept ${deskName}’s price`, (key) => acceptQuoteAction({ quoteRef: quote.ref }, key));
    if (out.ok) {
      playSound('success');
      router.push(`/trades/${out.result.tradeRef}?opened=1`);
    }
  };

  return (
    <>
      <section className={`${shell.surface} ${ex.ticket}`} aria-label="Firm price">
        <header className={ex.quoteHead}>
          <div className={ex.quoteId}>
            <span className={shell.label}>Firm price from {deskName}</span>
            <span className={ex.quoteRef}>
              {quote.ref}
              <span className={ex.side}>{sell ? 'Sell USDT' : 'Buy USDT'}</span>
            </span>
          </div>
          <Countdown sentAt={quote.sentAt ? new Date(quote.sentAt) : null} expiresAt={expiresAt} now={now} />
        </header>

        <div className={ex.hero}>
          <span className={ex.heroLabel}>You receive</span>
          <span className={ex.heroFigure}>
            {sell ? `₹${inr}` : usdt}
            <span className={ex.heroUnit}>{sell ? 'INR' : 'USDT'}</span>
          </span>
          <span className={ex.heroSub}>{sell ? `You send ${usdt} USDT` : `You pay ₹${inr}`} · exactly, nothing is deducted</span>
        </div>

        <div className={ex.rate}>
          <span className={ex.rateMain}>
            <span className={ex.rateLock} aria-hidden="true">
              <LockIcon />
            </span>
            <span>
              <span className={ex.rateValue}>{rate}</span>
              <span className={ex.rateUnit}>per USDT</span>
            </span>
          </span>
          <span className={ex.rateNote}>{lapsed ? 'This price has lapsed' : `Held until ${formatIstTime(expiresAt)}`}</span>
        </div>

        <dl className={ex.terms}>
          <div>
            <dt>{sell ? 'Rupees paid to' : 'USDT delivered to'}</dt>
            <dd>{quote.destination}</dd>
          </div>
          <div>
            <dt>How it settles</dt>
            <dd>
              {sell
                ? `You send the USDT to the deal’s own escrow address, held by INRP2P. ${deskName} pays the rupees straight to your account; once you confirm they arrived, the USDT is released.`
                : `${deskName} puts the USDT into the deal’s own escrow, held by INRP2P. You pay the rupees straight to ${deskName}’s account, from your own; once they are confirmed, the USDT is released to your wallet.`}
            </dd>
          </div>
        </dl>

        {lapsed ? (
          <button type="button" className={`${shell.action} ${shell.wide}`} data-tone="ink" onClick={onAgain}>
            {againLabel}
            <ArrowIcon className={shell.actionIcon} />
          </button>
        ) : canAccept ? (
          <div className={ex.decide}>
            <button type="button" className={`${shell.action} ${shell.wide}`} onClick={() => void accept()} disabled={busy} aria-busy={busy || undefined}>
              {busy ? <ArcLoader size="sm" label="Accepting" tone="inherit" /> : null}
              <span>Accept at {rate}</span>
              {busy ? null : <ArrowIcon className={shell.actionIcon} />}
            </button>
          </div>
        ) : (
          <p className={shell.info} data-tone="warning">
            <InfoIcon className={shell.infoIcon} />
            <span>Your account can see prices but not accept them. Someone with acceptance rights has to decide on this one.</span>
          </p>
        )}
        {error ? (
          <p className={shell.error} role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {dialog}
    </>
  );
}
