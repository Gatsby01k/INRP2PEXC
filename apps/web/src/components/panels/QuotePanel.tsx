'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Money, Rate, computeTradeEconomics } from '@inrp2p/kernel';
import type { DeskRequest } from '@inrp2p/desk';
import { Button, CopyButton, MoneyInput, RateComparison } from '@inrp2p/ui';
import { createAndSendQuoteAction, declineRequestAction } from '../../server/actions/desk.ts';
import { useCommand } from '../useCommand.tsx';
import { useHotkey } from '../useHotkey.ts';
import styles from './panel.module.css';

/** In-app quotes are short; a shareable link needs at least the policy minimum (D-01 rev 3). */
const IN_APP_VALIDITY = 90;
const LINK_VALIDITY = 180;

export interface QuotePanelProps {
  readonly request: DeskRequest;
  readonly canQuote: boolean;
  readonly canDecline: boolean;
  readonly linkBase: string;
}

/**
 * The quote builder (UX_FLOWS F4). The dealer sets the client rate; the INR and the margin are **computed**,
 * never typed, with the same kernel function the command uses — so what the panel previews is what the quote
 * will say (FI-02, FI-03). Sending is one intent: create and send, with the link when asked for.
 */
export function QuotePanel({ request, canQuote, canDecline, linkBase }: QuotePanelProps) {
  const cmd = useCommand();
  const panel = useRef<HTMLElement>(null);
  const routes = request.routes ?? [];
  const usable = routes.filter((r) => r.rate !== null);
  const [routeId, setRouteId] = useState(usable[0]?.routeId ?? '');
  const [rate, setRate] = useState(request.targetRate ?? '');
  const [withLink, setWithLink] = useState(true);
  const [reason, setReason] = useState('');
  const [link, setLink] = useState<string | null>(null);

  const route = routes.find((r) => r.routeId === routeId);
  const preview = useMemo(() => {
    if (!route?.rate || rate === '') return null;
    try {
      const clientRate = Rate.parse(rate, 'CLIENT');
      const routeRate = Rate.parse(route.rate, 'ROUTE');
      return request.fixedSide === 'BASE'
        ? computeTradeEconomics({ direction: request.direction, fixedSide: 'BASE', amount: Money.parse(request.amount, 'USDT'), clientRate, routeRate })
        : computeTradeEconomics({ direction: request.direction, fixedSide: 'QUOTE', amount: Money.parse(request.amount, 'INR'), clientRate, routeRate });
    } catch {
      return null;
    }
  }, [rate, route?.rate, request.amount, request.direction, request.fixedSide]);

  const negative = preview?.grossMargin.isNegative() ?? false;
  const counter = request.targetRate !== null && rate !== request.targetRate;

  // One intent, reached by the button or by the Q the button advertises.
  const ready = Boolean(preview) && !cmd.busy && !(negative && reason.trim().length < 10);
  const sendQuote = useCallback(() => {
    void cmd
      .run(`Send ${counter ? 'counter ' : ''}quote to ${request.clientName}`, (key) =>
        createAndSendQuoteAction(
          {
            requestId: request.requestId,
            routeId,
            clientRate: rate,
            validitySeconds: withLink ? LINK_VALIDITY : IN_APP_VALIDITY,
            withLink,
            ...(negative ? { negativeMarginReason: reason } : {}),
          },
          key,
        ),
      )
      .then((r) => {
        if (r.ok) setLink(r.result.link);
      });
  }, [cmd, counter, request.clientName, request.requestId, routeId, rate, withLink, negative, reason]);

  const send = ready ? sendQuote : null;
  useHotkey(panel, 'q', send);

  return (
    <aside ref={panel} className={styles.panel} aria-label={`Quote ${request.ref}`} data-testid="quote-panel">
      <div className={styles.head}>
        <span className={styles.ref}>{request.ref}</span>
        <span className={styles.client}>
          {request.clientName} · {request.direction === 'SELL_USDT' ? 'SELL' : 'BUY'}
        </span>
      </div>

      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>Client asks</dt>
          <dd className="ix-num">
            {request.amount} {request.amountCurrency}
          </dd>
        </div>
        {request.targetRate ? (
          <div className={styles.row}>
            <dt>Target rate</dt>
            <dd className="ix-num">₹{request.targetRate}</dd>
          </div>
        ) : null}
        <div className={styles.row}>
          <dt>Destination</dt>
          <dd>{request.destination}</dd>
        </div>
      </dl>

      {!canQuote ? (
        <p className={styles.notice}>Quoting needs the dealer role.</p>
      ) : usable.length === 0 ? (
        <p className={styles.error} role="alert">
          No route has a published rate for this direction. Publish one on Rates before quoting.
        </p>
      ) : (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Price</h3>
          <div className="ix-field">
            <label htmlFor="quote-route">Route</label>
            <select id="quote-route" className="ix-input" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              {usable.map((r) => (
                <option key={r.routeId} value={r.routeId}>
                  {r.name} · ₹{r.rate}
                  {r.stale ? ' (stale)' : ''}
                </option>
              ))}
            </select>
          </div>
          {route?.stale ? <p className={styles.notice}>That route rate is old. Publishing a fresh one may be refused otherwise.</p> : null}

          <MoneyInput label="Client rate (INR per USDT)" currency="INR" value={rate} onChange={setRate} hint="What the client gets per USDT" />

          {/* Rate, spread, volume, what the client gets and the expected margin — all of it, once. */}
          {preview && route?.rate ? (
            <RateComparison audience="operator" clientRate={Rate.parse(rate, 'CLIENT')} routeRate={Rate.parse(route.rate, 'ROUTE')} economics={preview} />
          ) : null}

          {negative ? (
            <div className="ix-field">
              <label htmlFor="neg-reason">Why send a negative margin?</label>
              <input id="neg-reason" className="ix-input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          ) : null}

          <label className={styles.row}>
            <span>Create a shareable link</span>
            <input type="checkbox" checked={withLink} onChange={(e) => setWithLink(e.target.checked)} />
          </label>

          <div className={styles.actions}>
            <Button intent="primary" shortcut="Q" disabled={!send} onClick={() => send?.()}>
              {counter ? 'Send counter' : 'Send quote'}
            </Button>
            {canDecline ? (
              <Button
                intent="ghost"
                disabled={reason.trim().length < 3}
                onClick={() => cmd.run(`Decline ${request.ref}`, (key) => declineRequestAction({ requestId: request.requestId, reason }, key))}
              >
                Decline
              </Button>
            ) : null}
          </div>
          {canDecline ? <p className={styles.notice}>Declining needs a reason — type it in the field above.</p> : null}
        </section>
      )}

      {link ? (
        <section className={styles.section} data-testid="quote-link">
          <h3 className={styles.sectionTitle}>Shareable link</h3>
          <div className={styles.linkBox}>
            <span className={styles.linkValue}>{`${linkBase}/q/${link}`}</span>
            <CopyButton value={`${linkBase}/q/${link}`} label="Copy link" />
          </div>
          <p className={styles.notice}>The link is shown once. Anyone holding it can see the quote; accepting still needs a code sent to an authorized user.</p>
        </section>
      ) : null}

      {cmd.error ? (
        <p className={styles.error} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </aside>
  );
}
