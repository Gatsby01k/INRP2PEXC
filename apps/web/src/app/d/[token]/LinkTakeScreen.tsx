'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientLinkState } from '@inrp2p/quotes';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../components/useCommand.tsx';
import { takeDeskLinkAction } from '../../../server/actions/desk-deals.ts';
import { AddDestination } from '../../(client)/destinations/AddDestination.tsx';
import { useServerClock } from '../../(client)/exchange/useServerClock.ts';
import { inr, rate as rateText, sentence, usdt } from '../../(client)/desk/_ui/format.ts';
import { DeskQuoteCard } from '../../(client)/desks/_ui/DeskQuoteCard.tsx';
import { DestinationPick, type PickOption } from '../../(client)/desks/_ui/DestinationPick.tsx';
import shell from '../../(client)/shell.module.css';
import { Amount } from '../../../components/Amount.tsx';
import styles from '../../public-desk/storefront.module.css';

/**
 * A deal link, taken by a signed-in client (ADR 0020 §2.9): the deal, where the client's money lands, and "Take this
 * deal" — which makes it the client's alone and returns a firm price at the link's rate, held for three minutes. Then the
 * acceptance that opens the trade. Someone else's, expired or revoked links say so.
 */
export function LinkTakeScreen({
  token,
  state,
  banks,
  wallets,
  anyWallet,
  who,
  now: serverNow,
}: {
  token: string;
  state: ClientLinkState;
  banks: readonly PickOption[];
  wallets: readonly PickOption[];
  anyWallet: boolean;
  who: { readonly canAccept: boolean; readonly isAdmin: boolean; readonly hasAuthenticator: boolean; readonly email: string; readonly clientName: string };
  now: string;
}) {
  const router = useRouter();
  const now = useServerClock(serverNow, true);
  const { link } = state;
  const sells = link.direction === 'SELL_USDT';
  const [bankId, setBankId] = useState(banks[0]?.id ?? '');
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? '');
  const [adding, setAdding] = useState(false);
  const { run, busy, error, dialog } = useCommand();
  useEffect(() => {
    if (!banks.some((b) => b.id === bankId) && banks[0]) setBankId(banks[0].id);
    if (!wallets.some((w) => w.id === walletId) && wallets[0]) setWalletId(wallets[0].id);
  }, [banks, wallets, bankId, walletId]);

  const left = Date.parse(link.expiresAt) - now;
  const takeable = (link.state === 'OPEN' || (link.state === 'TAKEN' && state.mine)) && left > 0 && link.desk.live;
  const destination = sells ? bankId : walletId;

  const take = async () => {
    const out = await run(`Take ${link.desk.displayName}’s deal`, (key) => takeDeskLinkAction({ token, ...(sells ? { bankAccountId: bankId } : { walletId }) }, key));
    if (out.ok) router.refresh();
  };

  const closed =
    link.state === 'DONE' ? 'This deal is done.' : link.state === 'REVOKED' ? 'The desk took this link back.' : left <= 0 ? 'This link has expired.' : link.state === 'TAKEN' && !state.mine ? 'Someone else took this deal.' : !link.desk.live ? `${link.desk.displayName} is not taking deals right now.` : null;

  return (
    <main className={styles.linkMain}>
      <a className={styles.linkDesk} href="/desks">
        <span className={styles.monogram} aria-hidden="true">
          {link.desk.displayName.trim().charAt(0).toUpperCase()}
        </span>
        <span className={styles.linkDeskName}>
          <strong>{link.desk.displayName}</strong>
          <span>A deal for you · {link.ref}</span>
        </span>
      </a>
      <h1 className={styles.dealTitle}>{sells ? `Sell ${usdt(link.base)} for ${inr(link.inr)}` : `Buy ${usdt(link.base)} for ${inr(link.inr)}`}</h1>

      {state.liveQuote ? (
        <DeskQuoteCard quote={state.liveQuote} deskName={link.desk.displayName} canAccept={who.canAccept} now={now} onAgain={() => void take()} againLabel="Get the price again" />
      ) : (
        <section className={styles.ticket} aria-label="The deal">
          <div className={styles.legs}>
            <div className={styles.leg}>
              <span className={styles.legLabel}>You send</span>
              <span className={styles.legFigure}><Amount value={sells ? usdt(link.base) : inr(link.inr)} /></span>
            </div>
            <div className={styles.leg}>
              <span className={styles.legLabel}>You receive</span>
              <span className={styles.legFigure}><Amount value={sells ? inr(link.inr) : usdt(link.base)} /></span>
            </div>
          </div>
          <p className={styles.rateLine}>
            <span>
              Rate <strong>{rateText(link.rate)}</strong> per USDT
            </span>
            {takeable ? <span>Until {formatIstDateTime(new Date(link.expiresAt))}</span> : null}
          </p>
          {closed ? (
            <div className={styles.closed}>
              <p className={styles.closedTitle}>{closed}</p>
              <p className={styles.hint}>Ask the desk for a new link, or see its live prices.</p>
              <a className={styles.signIn} href={`/desks/${link.desk.handle}`}>
                {link.desk.displayName}’s prices
              </a>
            </div>
          ) : (
            <>
              <DestinationPick kind={sells ? 'bank' : 'wallet'} options={sells ? banks : wallets} value={destination} onChange={sells ? setBankId : setWalletId} canAdd={who.isAdmin} onAdd={() => setAdding(true)} />
              {error ? (
                <p className={shell.error} role="alert">
                  {sentence(error)}
                </p>
              ) : null}
              <button type="button" className={`${styles.cta} ${styles.ctaButton}`} disabled={busy || destination === ''} aria-disabled={busy || destination === ''} onClick={() => void take()}>
                {busy ? <ArcLoader size="sm" label="Taking" tone="inherit" /> : null}
                Take this deal
              </button>
              <p className={styles.fine}>It becomes yours alone, at exactly this rate. You then have three minutes to accept the firm price.</p>
            </>
          )}
        </section>
      )}

      <AddDestination
        open={adding}
        kind={sells ? 'bank' : 'wallet'}
        onClose={() => setAdding(false)}
        hasAuthenticator={who.hasAuthenticator}
        email={who.email}
        holderName={who.clientName}
        firstOfKind={sells ? banks.length === 0 : !anyWallet}
        next="deal"
        onAdded={() => router.refresh()}
      />
      {dialog}
    </main>
  );
}
