'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import type { ClientDeskDeal, ClientQuoteView } from '@inrp2p/quotes';
import type { DeskPagePrice } from '@inrp2p/traders';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDate } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { requestDeskPriceAction } from '../../../../server/actions/desk-deals.ts';
import { AddDestination } from '../../destinations/AddDestination.tsx';
import { InfoIcon } from '../../_workspace/icons.tsx';
import { Field } from '../../_workspace/Field.tsx';
import { useServerClock } from '../../exchange/useServerClock.ts';
import { inr, previewDeal, rate as rateText, sentence, usdt } from '../../desk/_ui/format.ts';
import { DeskQuoteCard } from '../_ui/DeskQuoteCard.tsx';
import { DestinationPick, type PickOption } from '../_ui/DestinationPick.tsx';
import shell from '../../shell.module.css';
import styles from '../desks.module.css';

type Side = 'SELL_USDT' | 'BUY_USDT';

export interface DeskDealProps {
  readonly desk: {
    readonly handle: string;
    readonly displayName: string;
    readonly about: string | null;
    readonly live: boolean;
    readonly prices: Readonly<Record<Side, DeskPagePrice | null>>;
    readonly completedDeals: number;
  };
  readonly blocked: boolean;
  readonly maxDeal: string | null;
  readonly liveQuote: ClientQuoteView | null;
  readonly deals: readonly ClientDeskDeal[];
  readonly banks: readonly PickOption[];
  readonly wallets: readonly PickOption[];
  readonly anyWallet: boolean;
  readonly who: { readonly canAccept: boolean; readonly isAdmin: boolean; readonly hasAuthenticator: boolean; readonly email: string; readonly clientName: string };
  readonly start: { readonly direction: Side | null; readonly fixed: 'BASE' | 'QUOTE'; readonly amount: string };
  readonly now: string;
}

const STATE: Record<string, string> = { COMPLETED: 'Completed', CANCELLED: 'Cancelled' };

/**
 * A deal with a desk, in the client's workspace: which way and how much at the desk's live price, where the money lands,
 * then a firm price held for a minute — and the acceptance that opens the trade. The price the client holds is the
 * server's: after asking, the page is drawn again from it, so a reload shows the same price with the same countdown.
 */
export function DeskDealScreen(props: DeskDealProps) {
  const { desk, liveQuote, who } = props;
  const router = useRouter();
  const now = useServerClock(props.now, true);
  const firstSide: Side = props.start.direction && desk.prices[props.start.direction] ? props.start.direction : desk.prices.SELL_USDT ? 'SELL_USDT' : 'BUY_USDT';
  const [side, setSide] = useState<Side>(firstSide);
  const [fixed, setFixed] = useState<'BASE' | 'QUOTE'>(props.start.fixed);
  const [amount, setAmount] = useState(props.start.amount || '1000');
  const [bankId, setBankId] = useState(props.banks[0]?.id ?? '');
  const [walletId, setWalletId] = useState(props.wallets[0]?.id ?? '');
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const { run, busy, error, dialog } = useCommand();
  // A bank account or wallet just added is the one to use.
  useEffect(() => {
    if (!props.banks.some((b) => b.id === bankId) && props.banks[0]) setBankId(props.banks[0].id);
    if (!props.wallets.some((w) => w.id === walletId) && props.wallets[0]) setWalletId(props.wallets[0].id);
  }, [props.banks, props.wallets, bankId, walletId]);

  const price = desk.prices[side];
  const sells = side === 'SELL_USDT';
  const deal = useMemo(() => (price ? previewDeal({ direction: side, fixedSide: fixed, amount, rate: price.rate, feeBps: 0 }) : null), [price, side, fixed, amount]);
  const priced = deal && typeof deal !== 'string' ? deal : null;
  const base = priced?.base.minor ?? null;
  const limitMax = price ? (props.maxDeal && Money.parse(props.maxDeal, 'USDT').minor < Money.parse(price.max, 'USDT').minor ? props.maxDeal : price.max) : null;
  const tooSmall = price && base !== null && base < Money.parse(price.min, 'USDT').minor;
  const tooLarge = limitMax && base !== null && base > Money.parse(limitMax, 'USDT').minor;
  const destination = sells ? bankId : walletId;
  const ready = desk.live && !props.blocked && priced !== null && !tooSmall && !tooLarge && destination !== '';

  const ask = async (input: { direction: Side; fixedSide: 'BASE' | 'QUOTE'; amount: string }) => {
    const sell = input.direction === 'SELL_USDT';
    const out = await run(`Price from ${desk.displayName}`, (key) =>
      requestDeskPriceAction({ handle: desk.handle, ...input, ...(sell ? { bankAccountId: bankId } : { walletId }) }, key),
    );
    if (out.ok) {
      setShowForm(false);
      router.refresh();
    }
  };

  const quoteLive = liveQuote && !showForm;

  return (
    <>
      <main className={shell.main}>
        {props.blocked ? (
          <p className={shell.info} data-tone="warning">
            <InfoIcon className={shell.infoIcon} />
            <span>{desk.displayName} is not dealing with your account. Your earlier deals with it stay in History.</span>
          </p>
        ) : null}

        {quoteLive ? (
          <DeskQuoteCard
            quote={liveQuote}
            deskName={desk.displayName}
            canAccept={who.canAccept}
            now={now}
            onAgain={() => void ask({ direction: liveQuote.direction, fixedSide: 'BASE', amount: liveQuote.base.amount })}
          />
        ) : !desk.live || (!desk.prices.SELL_USDT && !desk.prices.BUY_USDT) ? (
          <section className={shell.card}>
            <h2 className={shell.cardTitle}>{desk.live ? 'No prices right now' : `${desk.displayName} is not taking deals right now`}</h2>
            <p className={shell.muted}>The desk sets its prices through the day. Come back a little later.</p>
          </section>
        ) : (
          <section className={shell.surface} aria-label="Your deal">
            <div className={styles.sides} role="group" aria-label="I want to">
              {(['SELL_USDT', 'BUY_USDT'] as const).map((s) => (
                <button key={s} type="button" className={styles.side} aria-pressed={side === s} disabled={!desk.prices[s]} onClick={() => setSide(s)}>
                  <span className={styles.sideLabel}>{s === 'SELL_USDT' ? 'Sell USDT' : 'Buy USDT'}</span>
                  <span className={styles.sideRate}>{desk.prices[s] ? `${rateText(desk.prices[s]!.rate)} per USDT` : 'Not offered'}</span>
                </button>
              ))}
            </div>
            <Field
              label={sells ? (fixed === 'BASE' ? 'You send' : 'You receive') : fixed === 'BASE' ? 'You receive' : 'You pay'}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              adornment={fixed === 'BASE' ? 'USDT' : '₹'}
              action={
                <button type="button" className={shell.textAction} onClick={() => setFixed(fixed === 'BASE' ? 'QUOTE' : 'BASE')}>
                  {fixed === 'BASE' ? 'in ₹' : 'in USDT'}
                </button>
              }
            />
            <div className={styles.result} aria-live="polite">
              <span className={styles.resultLabel}>{sells ? (fixed === 'BASE' ? 'You receive' : 'You send') : fixed === 'BASE' ? 'You pay' : 'You receive'}</span>
              <span className={styles.resultFigure}>{priced ? (fixed === 'BASE' ? inr(priced.clientInr.toDecimalString()) : usdt(priced.base.toDecimalString())) : '—'}</span>
            </div>
            {price ? (
              <p className={styles.meta}>
                <span>
                  Rate <strong>{rateText(price.rate)}</strong> per USDT
                </span>
                <span>
                  {usdt(price.min, false)}–{usdt(limitMax ?? price.max)} per deal
                </span>
              </p>
            ) : null}
            {typeof deal === 'string' ? <p className={shell.error}>{deal}</p> : null}
            {tooSmall ? <p className={shell.error}>The smallest deal here is {usdt(price!.min)}.</p> : null}
            {tooLarge ? <p className={shell.error}>The largest deal with you here is {usdt(limitMax!)}.</p> : null}

            <DestinationPick
              kind={sells ? 'bank' : 'wallet'}
              options={sells ? props.banks : props.wallets}
              value={destination}
              onChange={sells ? setBankId : setWalletId}
              canAdd={who.isAdmin}
              onAdd={() => setAdding(true)}
            />

            {error ? (
              <p className={shell.error} role="alert">
                {sentence(error)}
              </p>
            ) : null}
            <button type="button" className={`${shell.action} ${shell.wide}`} disabled={!ready || busy} aria-busy={busy || undefined} onClick={() => void ask({ direction: side, fixedSide: fixed, amount })}>
              {busy ? <ArcLoader size="sm" label="Asking" tone="inherit" /> : null}
              Get a firm price
            </button>
            <p className={shell.muted}>The price is held for a minute, with exactly what you send and receive. Nothing is committed until you accept it.</p>
          </section>
        )}
        {quoteLive ? (
          <button type="button" className={shell.textAction} onClick={() => setShowForm(true)}>
            Change the amount
          </button>
        ) : null}
      </main>

      <aside className={shell.aside}>
        <section className={`${shell.card} ${styles.deskCard}`} aria-label={desk.displayName}>
          <div className={styles.deskHead}>
            <span className={styles.monogram} aria-hidden="true">
              {desk.displayName.trim().charAt(0).toUpperCase()}
            </span>
            <span className={styles.rowText}>
              <p className={styles.deskName}>{desk.displayName}</p>
              <span className={shell.muted}>{desk.completedDeals === 1 ? '1 deal completed' : `${desk.completedDeals} deals completed`} on INRP2P</span>
            </span>
          </div>
          {desk.about ? <p className={styles.about}>{desk.about}</p> : null}
          <ol className={styles.steps}>
            <li>A firm price for a minute, with exactly what you send and receive.</li>
            <li>{sells ? 'You send the USDT into the deal’s escrow; the desk pays the rupees straight to your account.' : 'The desk puts the USDT into escrow; you pay the rupees straight to the desk’s account.'}</li>
            <li>Once the rupees are confirmed, INRP2P releases the USDT — never before.</li>
          </ol>
        </section>
        {props.deals.length > 0 ? (
          <section className={shell.card} aria-labelledby="your-deals">
            <h2 id="your-deals" className={shell.cardTitle}>
              Your deals here
            </h2>
            <ul className={styles.trades}>
              {props.deals.map((d) => (
                <li key={d.tradeRef}>
                  <Link className={styles.trade} href={`/trades/${d.tradeRef}`}>
                    <span className={styles.rowText}>
                      <span>
                        {d.direction === 'SELL_USDT' ? 'Sold' : 'Bought'} {usdt(d.usdt)}
                      </span>
                      <span className={styles.tradeRef}>
                        {d.tradeRef} · {formatIstDate(new Date(d.openedAt))}
                      </span>
                    </span>
                    <span className={shell.muted}>{STATE[d.state] ?? 'In progress'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>

      <AddDestination
        open={adding}
        kind={sells ? 'bank' : 'wallet'}
        onClose={() => setAdding(false)}
        hasAuthenticator={who.hasAuthenticator}
        email={who.email}
        holderName={who.clientName}
        firstOfKind={sells ? props.banks.length === 0 : !props.anyWallet}
        next="deal"
        onAdded={() => router.refresh()}
      />
      {dialog}
    </>
  );
}
