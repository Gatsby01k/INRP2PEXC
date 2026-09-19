'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Money, Rate } from '@inrp2p/kernel';
import type { ExchangeView } from '@inrp2p/portal';
import { BankAccountRow, Button, DirectionToggle, EmptyState, FirmQuote, type FirmQuoteState, MoneyInput, WalletRow } from '@inrp2p/ui';
import { useCommand } from '../../../components/useCommand.tsx';
import { acceptQuoteAction, rejectQuoteAction, requestQuoteAction, withdrawRequestAction } from '../../../server/actions/client.ts';
import styles from '../shell.module.css';

type Direction = 'SELL_USDT' | 'BUY_USDT';

/**
 * One screen, three states, and the screen decides which by looking at what the desk has said — never by
 * remembering what the client last clicked. A reloaded page therefore shows the truth, which for a countdown
 * that decides whether money moves is the only acceptable behaviour.
 */
export function ExchangeScreen({ view, canAccept, serverTime }: { view: ExchangeView; canAccept: boolean; serverTime: string }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const quote = view.quote;
  const request = view.request;

  // A live quote runs out on its own. The page has to notice, because the accept button must stop working at the
  // same instant the server stops honouring it — a button that still looks live after expiry is a lie.
  useEffect(() => {
    if (!quote || quote.status !== 'SENT' || !quote.expiresAt) return;
    const ms = Date.parse(quote.expiresAt) - Date.parse(serverTime);
    if (ms <= 0) {
      router.refresh();
      return;
    }
    const timer = setTimeout(() => router.refresh(), ms + 500);
    return () => clearTimeout(timer);
  }, [quote, serverTime, router]);

  if (view.openTradeRef && quote?.status === 'ACCEPTED') {
    return (
      <section className={styles.panel} aria-label="Trade open">
        <span className={styles.sectionTitle}>Accepted</span>
        <p>
          {quote.ref} is now trade {view.openTradeRef}.
        </p>
        <Link href={`/trades/${view.openTradeRef}`}>
          <Button intent="primary" fullWidth>
            Open the trade
          </Button>
        </Link>
      </section>
    );
  }

  if (quote && (quote.status === 'SENT' || quote.status === 'EXPIRED')) {
    const expiresAt = quote.expiresAt ? new Date(quote.expiresAt) : undefined;
    const live = quote.status === 'SENT';
    const state: FirmQuoteState = live ? 'LOCKED' : 'EXPIRED';
    return (
      <>
        <section className={styles.panel} aria-label="Your quote">
          <span className={styles.sectionTitle}>{quote.ref}</span>
          <FirmQuote
            state={state}
            direction={quote.direction}
            base={Money.parse(quote.base.amount, 'USDT')}
            inr={Money.parse(quote.inr.amount, 'INR')}
            rate={Rate.parse(quote.clientRate, 'CLIENT')}
            network="TRC20"
            destinationLabel={quote.destination}
            now={new Date(serverTime)}
            settlementNote="INR in one or more transfers, tracked per payment reference"
            busy={busy}
            {...(expiresAt ? { expiresAt } : {})}
            {...(live && canAccept
              ? {
                  onAccept: () => {
                    void run('Accept this quote', (key) => acceptQuoteAction({ quoteRef: quote.ref }, key)).then((out) => {
                      if (out.ok) router.refresh();
                    });
                  },
                  onDecline: () => {
                    void run('Decline this quote', (key) => rejectQuoteAction({ quoteRef: quote.ref }, key)).then((out) => {
                      if (out.ok) router.refresh();
                    });
                  },
                }
              : {})}
            {...(!live ? { onRequestNew: () => router.refresh() } : {})}
          />
          {live && !canAccept ? (
            <p className={styles.notice}>Your account can see quotes but not accept them. Someone with acceptance rights has to decide on this one.</p>
          ) : null}
          {error ? (
            <p className="ix-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
        {dialog}
      </>
    );
  }

  if (request && (request.status === 'OPEN' || request.status === 'QUOTED')) {
    return (
      <>
        <section className={styles.panel} aria-label="Request being priced">
          <span className={styles.sectionTitle}>{request.ref}</span>
          <p>
            We are pricing {request.currency === 'USDT' ? `${request.amount} USDT` : `₹${request.amount}`} to {request.destination}. You will be told as soon as a
            quote is ready.
          </p>
          <Button
            intent="ghost"
            loading={busy}
            onClick={() => {
              void run('Withdraw this request', (key) => withdrawRequestAction({ requestRef: request.ref }, key)).then((out) => {
                if (out.ok) router.refresh();
              });
            }}
          >
            Withdraw the request
          </Button>
          {error ? (
            <p className="ix-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
        {dialog}
      </>
    );
  }

  return (
    <>
      {request?.status === 'DECLINED' ? (
        <p className={styles.notice} role="status">
          {request.statusReason ? `Your last request was declined: ${request.statusReason}` : 'Your last request was declined.'}
        </p>
      ) : null}
      <RequestForm view={view} busy={busy} error={error} onSubmit={(payload) => run('Request a quote', (key) => requestQuoteAction(payload, key)).then((out) => {
        if (out.ok) router.refresh();
      })} />
      {dialog}
    </>
  );
}

interface RequestPayload {
  direction: Direction;
  fixedSide: 'BASE' | 'QUOTE';
  amount: string;
  bankAccountId?: string | null;
  walletId?: string | null;
}

function RequestForm({
  view,
  busy,
  error,
  onSubmit,
}: {
  view: ExchangeView;
  busy: boolean;
  error: string | null;
  onSubmit: (payload: RequestPayload) => void;
}) {
  const [direction, setDirection] = useState<Direction>('SELL_USDT');
  const [amount, setAmount] = useState('');
  const banks = view.destinations.banks;
  const wallets = view.destinations.wallets.filter((w) => w.purpose !== 'SOURCE');
  const [bankId, setBankId] = useState(banks[0]?.id ?? '');
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? '');
  const sell = direction === 'SELL_USDT';
  const destinationMissing = sell ? bankId === '' : walletId === '';

  if (banks.length === 0 && wallets.length === 0) {
    return (
      <EmptyState
        title="Add somewhere to be paid first"
        body="A quote needs a destination, so the desk knows where the money goes. Add a bank account or a wallet under Accounts."
        action={
          <Link href="/accounts">
            <Button intent="primary">Go to Accounts</Button>
          </Link>
        }
      />
    );
  }

  return (
    <form
      className={styles.panel}
      aria-label="Request a quote"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          direction,
          fixedSide: 'BASE',
          amount,
          ...(sell ? { bankAccountId: bankId } : { walletId }),
        });
      }}
    >
      <DirectionToggle value={direction} onChange={setDirection} />
      <MoneyInput
        label={sell ? 'Sell' : 'Buy'}
        currency="USDT"
        size="display"
        suffix="USDT · TRC20"
        value={amount}
        onChange={setAmount}
        hint="The desk prices this and sends you a firm quote."
      />
      <div>
        <span className={styles.sectionTitle}>{sell ? 'Receive to' : 'Deliver to'}</span>
        {sell
          ? banks.map((b) => (
              <BankAccountRow
                key={b.id}
                bankName={b.bankName}
                holderName={b.holderName}
                last4={b.last4}
                status={b.status}
                rail={b.rails[0] ?? 'IMPS'}
                selected={b.id === bankId}
                onSelect={() => setBankId(b.id)}
              />
            ))
          : wallets.map((w) => (
              <WalletRow key={w.id} address={w.address} network="TRC20" label={w.label} status={w.status} selected={w.id === walletId} onSelect={() => setWalletId(w.id)} />
            ))}
      </div>
      <Button type="submit" intent="primary" size="lg" fullWidth loading={busy} disabled={amount === '' || destinationMissing}>
        Request quote
      </Button>
      {error ? (
        <p className="ix-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
