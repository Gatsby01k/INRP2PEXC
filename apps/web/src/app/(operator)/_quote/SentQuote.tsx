'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { DeskQuote } from '@inrp2p/desk';
import { Button, CopyButton } from '@inrp2p/ui';
import { cancelQuoteAction, createQuoteLinkAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Age, Countdown, useDeskNow } from '../_desk/clock.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { dateTime, inr, rate, usdt } from '../_desk/format.ts';
import { Chip, KeyValues, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import t from '../_trade/trade.module.css';

/** The minimum a link must have left (D-01 rev 3); the command refuses anything shorter. */
const LINK_MIN_SECONDS = 120;

/**
 * A quote while the client decides: its terms, the time it has left on the server's clock, whether its link has been
 * opened — and the desk's two moves, adding a link to a quote sent without one, or withdrawing the quote, which
 * reopens the request for a new price.
 */
export function SentQuote({ quote, canCancel, canLink, linkBase }: { quote: DeskQuote; canCancel: boolean; canLink: boolean; linkBase: string }) {
  const cmd = useCommand();
  const now = useDeskNow();
  const [link, setLink] = useState<string | null>(null);
  const sell = quote.direction === 'SELL_USDT';
  const live = quote.status === 'SENT' && quote.expiresAt !== null && new Date(quote.expiresAt).getTime() > now;
  const secondsLeft = quote.expiresAt ? Math.floor((new Date(quote.expiresAt).getTime() - now) / 1000) : 0;

  return (
    <div className={d.stack} data-testid="sent-quote-panel">
      <PanelSection title="Terms">
        <div className={t.headline}>
          <div className={t.amounts}>
            <span>{sell ? usdt(quote.base) : inr(quote.quoteInr)}</span>
            <span className={t.arrow}>→</span>
            <span>{sell ? inr(quote.quoteInr) : usdt(quote.base)}</span>
          </div>
          <span className={t.at}>at {rate(quote.clientRate)} per USDT</span>
        </div>
        <KeyValues
          items={[
            { label: 'Status', value: quote.status === 'SENT' ? (live ? <Chip tone="brand" glyph="partial">Waiting for the client</Chip> : <Chip tone="muted">Expired</Chip>) : <Chip>{quote.status.toLowerCase()}</Chip> },
            ...(quote.expiresAt && quote.status === 'SENT' ? [{ label: 'Expires in', value: <strong className={d.num}><Countdown to={quote.expiresAt} /></strong> }] : []),
            { label: 'Sent', value: quote.sentAt ? `${dateTime(quote.sentAt)}${quote.sentByLabel ? ` · ${quote.sentByLabel}` : ''}` : '—' },
            { label: sell ? 'Pays INR to' : 'Sends USDT to', value: <span className={d.mono}>{quote.destination}</span> },
            { label: 'Request', value: quote.requestRef },
            ...(quote.routeName && quote.routeRate ? [{ label: 'Route', value: `${quote.routeName} · ${rate(quote.routeRate)}` }] : []),
            ...(quote.margin ? [{ label: 'Expected margin', value: <span className={d.positive}>{inr(quote.margin, { sign: true })}</span> }] : []),
          ]}
        />
        {quote.tradeRef ? (
          <Notice tone="success" icon="check">
            Accepted — <Link href={`/orders/${encodeURIComponent(quote.tradeRef)}`}>{quote.tradeRef}</Link>
          </Notice>
        ) : null}
      </PanelSection>

      <PanelSection title="Shareable link">
        {quote.link ? (
          <KeyValues
            items={[
              { label: 'Created', value: dateTime(quote.link.createdAt) },
              { label: 'Opened', value: quote.link.openCount === 0 ? 'not yet' : `${quote.link.openCount} time${quote.link.openCount === 1 ? '' : 's'}${quote.link.firstOpenedAt ? ` · first ${dateTime(quote.link.firstOpenedAt)}` : ''}` },
              ...(quote.link.revoked ? [{ label: 'State', value: 'revoked' }] : []),
            ]}
          />
        ) : link ? (
          <>
            <div className={t.address}>
              <span className={t.addressValue}>{`${linkBase}/q/${link}`}</span>
              <CopyButton value={`${linkBase}/q/${link}`} label="quote link" />
            </div>
            <Notice icon="lock">Shown once — only its hash is stored.</Notice>
          </>
        ) : live && canLink ? (
          secondsLeft >= LINK_MIN_SECONDS ? (
            <div className={d.actions}>
              <Button
                size="sm"
                disabled={cmd.busy}
                onClick={() =>
                  void cmd.run(`Create a link for ${quote.ref}`, (key) => createQuoteLinkAction({ quoteId: quote.quoteId }, key)).then((r) => {
                    if (r.ok) setLink(r.result.link);
                  })
                }
              >
                Create shareable link
              </Button>
            </div>
          ) : (
            <Notice>Less than 2:00 left — a link needs at least that. Send a fresh quote instead.</Notice>
          )
        ) : (
          <Notice>No link was made for this quote.</Notice>
        )}
        {quote.link ? <p className={d.fieldHint}>The link itself is never shown again after it is made; its hash is all the desk keeps.</p> : null}
      </PanelSection>

      {live && canCancel ? (
        <PanelSection title="Withdraw">
          <GuardedAction
            label="Cancel quote"
            trigger="ghost"
            tone="danger"
            busy={cmd.busy}
            consequence="The client can no longer accept it, the link stops working, and the request reopens for a new price."
            reasonLabel="Why"
            onConfirm={async (reason) => (await cmd.run(`Cancel ${quote.ref}`, (key) => cancelQuoteAction({ quoteId: quote.quoteId, reason }, key))).ok}
          />
          <p className={d.fieldHint}>
            Waiting <Age at={quote.sentAt ?? quote.expiresAt ?? new Date(now).toISOString()} /> so far.
          </p>
        </PanelSection>
      ) : null}

      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
