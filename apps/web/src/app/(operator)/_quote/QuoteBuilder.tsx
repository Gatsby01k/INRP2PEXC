'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Money, Rate, computeP2pEconomics, inrToUsdt } from '@inrp2p/kernel';
import type { DeskRequest } from '@inrp2p/desk';
import { Button, CopyButton } from '@inrp2p/ui';
import { createAndSendQuoteAction, declineRequestAction, withdrawRequestAction } from '../../../server/actions/desk.ts';
import { assignRequestAction } from '../../../server/actions/traders-desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { useHotkey } from '../../../components/useHotkey.ts';
import { Age } from '../_desk/clock.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { Checkbox, RateField } from '../_desk/fields.tsx';
import { inr, money, rate, rateDelta, signedUsdt, time, usdt } from '../_desk/format.ts';
import { Icon } from '../_desk/icons.tsx';
import { Chip, KeyValues, Kbd, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import t from '../_trade/trade.module.css';

/** In-app quotes are short; a shareable link needs at least the policy minimum (D-01 rev 3). */
const IN_APP_VALIDITY = 90;
const LINK_VALIDITY = 180;

export interface QuotePerms {
  readonly quote: boolean;
  readonly decline: boolean;
  readonly withdraw: boolean;
  readonly assign: boolean;
}

const EXCLUSION_TEXT: Record<string, string> = {
  OFFLINE: 'offline', PAUSED: 'paused', NOT_APPROVED: 'not approved', RESERVE_NOT_SET: 'reserve not set', RESERVE_SHORT: 'reserve short',
  DESTINATIONS_INACTIVE: 'settlement details inactive', ASSIGNMENTS_DISABLED: 'assignments off', NO_SIDE: 'side not offered', NO_RATE: 'no rate',
  NO_LIMITS: 'no order size', BLOCK_PAUSED: 'side paused', NO_CAPACITY: 'no capacity', BELOW_MINIMUM: 'below their minimum', ABOVE_MAXIMUM: 'above their maximum',
  NOT_ENOUGH_CAPACITY: 'not enough capacity', ALREADY_OFFERED: 'already declined or let lapse', OWN_REQUEST: 'own request',
  NETWORK_DEPOSIT_SHORT: 'network deposit short of TRX', NETWORK_FEES_UNKNOWN: 'network fees not current', NEEDS_CLIENT_RATE: 'name the client’s rate first',
};

/**
 * The quote builder (UX_FLOWS F4), for a P2P deal (ADR 0019): the dealer sets the client's rate, routes the request to a
 * trader at that rate, and once the trader has accepted sends the quote. The rupees are one amount for client and trader,
 * so what INRP2P earns is USDT — computed, never typed, with the same kernel function the command uses, so what the builder
 * previews is what the quote will say (FI-02, FI-03). A rate other than the client's target is a counter, and says so.
 * Sending is one intent — create and send, with the link when asked for — reached by the button or by Q.
 */
export function QuoteBuilder({ request, perms, linkBase, autoFocus = false }: { request: DeskRequest; perms: QuotePerms; linkBase: string; autoFocus?: boolean }) {
  const cmd = useCommand();
  const scope = useRef<HTMLDivElement>(null);
  const rateInput = useRef<HTMLInputElement>(null);
  const traderLive = request.trader?.live;
  // The trader who accepted, on its route: the only place a quote can go. The server holds it to exactly that order.
  const route = traderLive && traderLive.status === 'ACCEPTED' && request.trader?.liveRouteId
    ? { routeId: request.trader.liveRouteId, name: `Trader ${request.trader.liveTraderRef ?? ''}`, rate: traderLive.rate }
    : null;
  const planned = request.trader?.livePlannedClientRate ?? null;
  const [clientRate, setClientRate] = useState(planned ? trimRate(planned) : request.targetRate ? trimRate(request.targetRate) : '');
  const [withLink, setWithLink] = useState(true);
  const [link, setLink] = useState<string | null>(null);
  const open = request.status === 'OPEN';

  useEffect(() => {
    if (autoFocus) rateInput.current?.focus();
  }, [autoFocus]);
  // A P2P order is sized at the client's rate: once a trader holds one, the rate is the order's (the server refuses another).
  useEffect(() => {
    if (planned) setClientRate(trimRate(planned));
  }, [planned]);

  const preview = useMemo(() => {
    if (!route || clientRate === '' || clientRate.endsWith('.')) return null;
    try {
      const c = Rate.parse(clientRate, 'CLIENT');
      const r = Rate.parse(route.rate, 'ROUTE');
      return request.fixedSide === 'BASE'
        ? computeP2pEconomics({ direction: request.direction, fixedSide: 'BASE', amount: Money.parse(request.amount, 'USDT'), clientRate: c, routeRate: r })
        : computeP2pEconomics({ direction: request.direction, fixedSide: 'QUOTE', amount: Money.parse(request.amount, 'INR'), clientRate: c, routeRate: r });
    } catch {
      return null;
    }
  }, [clientRate, route?.rate, request.amount, request.direction, request.fixedSide]);

  // What the deal must also carry, as the command prices it: on GasFree its network comes out of INRP2P's margin (ADR 0022);
  // on TRX the trader's deposit pays it. What is left must reach the minimum net margin, or the command refuses the quote.
  const network = request.network ?? null;
  const net = useMemo(() => {
    if (!preview || !network) return null;
    const gasFree = network.resourceMode === 'GASFREE';
    if (gasFree && network.gasFreeAllowanceUsdtMinor === null) return null;
    const fee = gasFree ? Money.ofMinor(BigInt(network.gasFreeAllowanceUsdtMinor!), 'USDT') : Money.zero('USDT');
    const feeLabel = gasFree ? 'GasFree, out of the margin' : 'paid by the trader’s TRX deposit';
    const netMargin = preview.grossMarginBase.sub(fee);
    const min = inrToUsdt(Money.ofMinor(BigInt(network.minNetMarginMinor), 'INR'), Rate.parse(clientRate, 'CLIENT'), 'UP');
    return { fee, feeLabel, netMargin, min, short: min.sub(netMargin) };
  }, [preview, network, clientRate]);
  const negative = preview?.grossMarginBase.isNegative() ?? false;
  const unprofitable = net !== null && net.netMargin.minor < net.min.minor;
  const counter = request.targetRate !== null && preview !== null && Rate.parse(clientRate, 'CLIENT').micro !== Rate.parse(request.targetRate, 'CLIENT').micro;
  const ready = open && route !== null && Boolean(preview) && net !== null && !unprofitable && !cmd.busy;

  const sendQuote = useCallback(() => {
    void cmd
      .run(`Send ${counter ? 'counter ' : ''}quote to ${request.clientName}`, (key) =>
        createAndSendQuoteAction(
          { requestId: request.requestId, routeId: route!.routeId, clientRate, validitySeconds: withLink ? LINK_VALIDITY : IN_APP_VALIDITY, withLink },
          key,
        ),
      )
      .then((r) => {
        if (r.ok) setLink(r.result.link);
      });
  }, [cmd, counter, request.clientName, request.requestId, route?.routeId, clientRate, withLink]);
  const send = ready ? sendQuote : null;
  useHotkey(scope, 'q', send);

  const sell = request.direction === 'SELL_USDT';
  const asked = money(request.amount, request.amountCurrency);

  return (
    <div ref={scope} className={d.stack} data-testid="quote-panel">

      {!perms.quote ? (
        <Notice>Quoting needs the dealer role.</Notice>
      ) : !request.routes ? (
        <Notice>Pricing needs economics:view.</Notice>
      ) : open ? (
        <PanelSection title="Price" aside={counter && request.targetRate ? <Chip tone="brand">Counter to {rate(request.targetRate)}</Chip> : undefined}>
          <RateField
            label="Client rate (INR per USDT)"
            value={clientRate}
            onChange={setClientRate}
            inputRef={rateInput}
            onEnter={() => send?.()}
            aside={
              <span className={d.row} style={{ gap: 2 }}>
                <Kbd label="Up">
                  <Icon name="arrowUp" size={10} />
                </Kbd>
                <Kbd label="Down">
                  <Icon name="arrowDown" size={10} />
                </Kbd>
                ₹0.01
              </span>
            }
            hint={sell ? 'What the client receives per USDT they sell' : 'What the client pays per USDT they buy'}
          />
          {request.targetRate || route?.rate ? (
            <div className={d.actions}>
              {request.targetRate ? (
                <button type="button" className={d.linkButton} onClick={() => setClientRate(trimRate(request.targetRate!))}>
                  Use target {rate(request.targetRate)}
                </button>
              ) : null}
            </div>
          ) : null}

          {preview && route ? (
            <div className={t.econ} aria-label="Quote economics" data-testid="quote-economics" data-compact="">
              <div className={t.econItem}>
                <span className={t.econLabel}>Client {sell ? 'receives' : 'pays'}</span>
                <span className={t.econValue}>{inr(preview.clientInr.toDecimalString())}</span>
                <span className={t.econSub}>{usdt(preview.base.toDecimalString())}</span>
              </div>
              <div className={t.econItem} data-kind="route">
                <span className={t.econLabel}>Trader’s rate</span>
                <span className={t.econValue}>{rate(route.rate)}</span>
                <span className={t.econSub}>{route.name}</span>
              </div>
              <div className={t.econItem}>
                <span className={t.econLabel}>Spread</span>
                <span className={t.econValue}>{rateDelta(route.rate, clientRate).text.replace(/^[+−±]/, '')}</span>
                <span className={t.econSub}>per USDT</span>
              </div>
              <div className={t.econItem} {...(negative ? { 'data-negative': '' } : {})}>
                <span className={t.econLabel}>Gross margin</span>
                <span className={t.econValue}>{signedUsdt(preview.grossMarginBase.toDecimalString())}</span>
                <span className={t.econSub}>computed, not typed</span>
              </div>
              {net ? (
                <>
                  <div className={t.econItem}>
                    <span className={t.econLabel}>Network</span>
                    <span className={t.econValue}>{signedUsdt(net.fee.negate().toDecimalString())}</span>
                    <span className={t.econSub}>{net.feeLabel}</span>
                  </div>
                  <div className={t.econItem} data-kind="margin" {...(unprofitable ? { 'data-negative': '' } : {})}>
                    <span className={t.econLabel}>Net margin</span>
                    <span className={t.econValue}>{signedUsdt(net.netMargin.toDecimalString())}</span>
                    <span className={t.econSub}>minimum {usdt(net.min.toDecimalString())}</span>
                  </div>
                </>
              ) : null}
            </div>
          ) : route ? (
            <Notice>Enter a client rate to see what the client gets and what INRP2P earns.</Notice>
          ) : (
            <Notice>Set the client’s rate, then route the request to a trader below. The quote goes out once a trader accepts.</Notice>
          )}

          {preview && !net ? (
            <Notice tone="danger" role="alert">
              GasFree’s fees were not read within the hour, so no quote can carry its network. The worker reads them every 10 minutes (RUNBOOKS gasfree).
            </Notice>
          ) : unprofitable && net ? (
            <div className={d.guard} data-tone="danger">
              <p className={d.guardTitle}>This rate does not pay for the deal</p>
              <p className={d.guardBody}>
                After the network it leaves {usdt(net.netMargin.toDecimalString())}, {usdt(net.short.toDecimalString())} short of the minimum. Move the rate {sell ? 'down' : 'up'}: the network is inside the client’s price, never added on top.
              </p>
            </div>
          ) : null}

          <Checkbox label={`Create a shareable link (valid ${withLink ? '3:00' : '1:30 in app'})`} checked={withLink} onChange={setWithLink} />

          <Button intent="primary" fullWidth shortcut="Q" disabled={!send} loading={cmd.busy} onClick={() => send?.()}>
            {counter ? 'Send counter' : 'Send quote'}
          </Button>
        </PanelSection>
      ) : null}

      {link ? (
        <PanelSection title="Shareable link" testId="quote-link">
          <div className={t.address}>
            <span className={t.addressValue}>{`${linkBase}/q/${link}`}</span>
            <CopyButton value={`${linkBase}/q/${link}`} label="quote link" />
          </div>
          <Notice icon="lock">Shown once — only its hash is stored. Opening it changes nothing; accepting still needs a code sent to an authorized person at the client.</Notice>
        </PanelSection>
      ) : null}

      <PanelSection title="Request">
        <KeyValues
          items={[
            { label: 'Client asks', value: <span className={d.num}>{`${sell ? 'Sell' : 'Buy'} ${asked}`}</span>, strong: true },
            { label: 'Target rate', value: request.targetRate ? rate(request.targetRate) : 'none — desk sets the rate' },
            { label: sell ? 'Pay INR to' : 'Send USDT to', value: <span className={d.mono}>{request.destination}</span> },
            { label: 'Waiting', value: <Age at={request.createdAt} /> },
          ]}
        />
        {!open ? <Notice icon="clock">This request is {request.status.toLowerCase()}. Nothing more can be quoted on it.</Notice> : null}
      </PanelSection>
      {request.trader && open ? <TraderSection request={request} canAssign={perms.assign} plannedRate={clientRate} /> : null}

      {open && (perms.decline || perms.withdraw) ? (
        <PanelSection title="Close without quoting">
          <div className={d.actions}>
            {perms.decline ? (
              <GuardedAction
                label="Decline request"
                trigger="ghost"
                tone="danger"
                busy={cmd.busy}
                consequence="The desk refuses this request. Any quote on it is cancelled and the client is told it was declined."
                reasonLabel="Reason (the client sees that it was declined)"
                onConfirm={async (reasonText) => (await cmd.run(`Decline ${request.ref}`, (key) => declineRequestAction({ requestId: request.requestId, reason: reasonText }, key))).ok}
              />
            ) : null}
            {perms.withdraw ? (
              <GuardedAction
                label="Withdraw for the client"
                trigger="ghost"
                busy={cmd.busy}
                consequence="Closes the request as withdrawn — use it when the client told the desk they no longer want it. Any quote on it is cancelled."
                reasonLabel="What the client said"
                onConfirm={async (reasonText) => (await cmd.run(`Withdraw ${request.ref}`, (key) => withdrawRequestAction({ requestId: request.requestId, reason: reasonText }, key))).ok}
              />
            ) : null}
          </div>
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

/** "102.000000" → "102.00": the builder shows a rate the way a dealer types it; the value keeps every digit that matters. */
function trimRate(value: string): string {
  const [w, f = ''] = value.split('.');
  const kept = f.replace(/0+$/, '');
  return `${w}.${kept.padEnd(2, '0')}`;
}

/**
 * The request's trader side (docs/TRADERS.md): route it to the best eligible trader, see the offer and its answer,
 * and — once the trader has accepted — quote on its rate (the route is picked for the dealer above, and the server
 * holds the quote to exactly what the trader accepted). When nobody is eligible, it says why each was left out.
 */
function TraderSection({ request, canAssign, plannedRate }: { request: DeskRequest; canAssign: boolean; plannedRate: string }) {
  const cmd = useCommand();
  const [miss, setMiss] = useState<string | null>(null);
  const live = request.trader?.live ?? null;
  const last = request.trader?.history.find((h) => h.status === 'DECLINED' || h.status === 'EXPIRED' || h.status === 'WITHDRAWN' || h.status === 'RELEASED');
  const assign = async () => {
    setMiss(null);
    const out = await cmd.run(`Route ${request.ref} to a trader`, (key) =>
      assignRequestAction({ requestId: request.requestId, plannedClientRate: plannedRate }, key),
    );
    if (!out.ok && out.code === 'TRADER_NONE_ELIGIBLE') {
      const excluded = (out.details?.excluded ?? {}) as Record<string, number>;
      const parts = Object.entries(excluded).map(([k, n]) => `${n} ${EXCLUSION_TEXT[k] ?? k}`);
      setMiss(parts.length > 0 ? `No trader can take it: ${parts.join(', ')}.` : 'No trader can take it right now.');
    }
  };
  return (
    <PanelSection title="Trader" testId="trader-section">
      {live ? (
        <KeyValues
          items={[
            { label: 'Order', value: `${live.ref} · ${request.trader?.liveTraderRef ?? ''}` },
            { label: 'Status', value: live.status === 'OFFERED' ? 'offered — waiting for the trader' : live.status === 'ACCEPTED' ? 'accepted — quote on its rate' : live.status.toLowerCase().replace('_', ' ') },
            { label: 'Trader rate', value: <span className={d.num}>{`${rate(live.rate)} · ${usdt(live.usdt)} · ${inr(live.inr)}`}</span> },
            ...(live.status === 'OFFERED' ? [{ label: 'Answer by', value: time(live.offerExpiresAt) }] : []),
            ...(live.status === 'ACCEPTED' && live.holdUntil ? [{ label: 'Held until', value: time(live.holdUntil) }] : []),
          ]}
        />
      ) : (
        <>
          {last ? (
            <Notice>
              {last.ref} ({last.traderRef}): {last.status.toLowerCase()}
              {last.closeNote ? ` — ${last.closeNote}` : ''}
            </Notice>
          ) : null}
          {canAssign ? (
            <div className={d.actions}>
              <Button size="sm" disabled={cmd.busy || plannedRate === ''} onClick={() => void assign()}>
                Route to a trader
              </Button>
            </div>
          ) : (
            <Notice>Routing to a trader needs traders:assign.</Notice>
          )}
          <p className={d.fieldHint}>The trader’s order is sized at the client’s rate above — the rupees are one amount for both — so set it first.</p>
        </>
      )}
      {miss ? <Notice tone="warning">{miss}</Notice> : null}
      {cmd.error && !miss ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </PanelSection>
  );
}
