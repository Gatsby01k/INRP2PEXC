'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { RoutePosition, StripRoute } from '@inrp2p/desk';
import { Button, MoneyInput, RoutePositionRow, UTRField, normalizeUtr } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { confirmRouteSettlementAction, publishRouteRateAction, recordRouteSettlementAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import styles from './rates.module.css';

export interface RatesClientProps {
  readonly routes: readonly StripRoute[];
  readonly positions: readonly RoutePosition[];
  readonly accounts: readonly { accountId: string; label: string; bankName: string }[];
  readonly wallets: readonly { walletId: string; label: string; address: string }[];
  readonly canPublish: boolean;
  readonly canRecord: boolean;
  readonly canConfirm: boolean;
  readonly showPositions: boolean;
}

/**
 * Rates and route positions (UX_FLOWS F5b). Publishing a rate is one command; recording a route settlement is
 * another, and confirming it — the step that actually moves the ledger — is step-up protected. Direct payouts
 * appear here as read-only rows: they were created by confirming a client leg, and re-recording them would
 * double-count the route side (FI-64).
 */
export function RatesClient({ routes, positions, accounts, wallets, canPublish, canRecord, canConfirm, showPositions }: RatesClientProps) {
  const cmd = useCommand();
  const [rates, setRates] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [flows, setFlows] = useState<Record<string, 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE'>>({});
  const [utrs, setUtrs] = useState<Record<string, string>>({});
  const [accountFor, setAccountFor] = useState<Record<string, string>>({});

  return (
    <div className="ix-stack">
      <section className="ix-card">
        <h2 className="ix-sectionTitle">Route rates</h2>
        <div className={styles.rates}>
          {routes.map((r) => {
            const key = `${r.routeId}:${r.direction}`;
            return (
              <div key={key} className={styles.rateRow}>
                <div>
                  <div>{r.routeName}</div>
                  <div className="ix-muted">{r.direction === 'SELL_USDT' ? 'USDT → INR' : 'INR → USDT'}</div>
                </div>
                <div className="ix-num">{r.rate ? `₹${r.rate}` : 'no rate'}</div>
                <div className="ix-muted">{r.publishedAt ? formatIstDateTime(new Date(r.publishedAt)) : '—'}</div>
                {canPublish ? (
                  <div className={styles.publish}>
                    <MoneyInput label="New rate" currency="INR" value={rates[key] ?? ''} onChange={(v) => setRates((s) => ({ ...s, [key]: v }))} />
                    <Button
                      disabled={(rates[key] ?? '') === ''}
                      onClick={() =>
                        cmd
                          .run(`Publish ₹${rates[key]} on ${r.routeName}`, (k) =>
                            publishRouteRateAction({ routeId: r.routeId, direction: r.direction, rate: rates[key] ?? '' }, k),
                          )
                          .then((out) => {
                            if (out.ok) setRates((s) => ({ ...s, [key]: '' }));
                            return out;
                          })
                      }
                    >
                      Publish
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {showPositions ? (
        <section className="ix-card" data-testid="route-positions">
          <h2 className="ix-sectionTitle">Route positions</h2>
          {positions.length === 0 ? <p className="ix-muted">No open route obligations.</p> : null}
          <div className="ix-stack">
            {positions.map((p) => {
              const flow = flows[p.obligationId] ?? 'FROM_ROUTE_TO_EXCHANGE';
              const side = flow === 'TO_ROUTE' ? p.exchangeDeliversRemaining : p.routeDeliversRemaining;
              return (
                <div key={p.obligationId} className={styles.position} data-testid={`position-${p.ref}`}>
                  <RoutePositionRow
                    audience="operator"
                    routeName={p.routeName}
                    tradeRef={p.tradeRef ?? p.ref}
                    status={p.status}
                    executionMode={p.executionMode}
                    routeDelivers={{
                      total: Money.parse(p.routeDelivers.amount, p.routeDelivers.currency),
                      allocated: Money.parse(p.routeDelivers.amount, p.routeDelivers.currency).sub(
                        Money.parse(p.routeDeliversRemaining.amount, p.routeDeliversRemaining.currency),
                      ),
                      ...(p.settlements.some((s) => s.readOnly) ? { note: 'includes a direct payout to the client' } : {}),
                    }}
                    exchangeDelivers={{
                      total: Money.parse(p.exchangeDelivers.amount, p.exchangeDelivers.currency),
                      allocated: Money.parse(p.exchangeDelivers.amount, p.exchangeDelivers.currency).sub(
                        Money.parse(p.exchangeDeliversRemaining.amount, p.exchangeDeliversRemaining.currency),
                      ),
                    }}
                  />

                  {p.settlements.length > 0 ? (
                    <ul className={styles.settlements}>
                      {p.settlements.map((s) => (
                        <li key={s.id} className={styles.settlement}>
                          <span>
                            {s.ref} · {s.amount} {s.asset} · {s.status.toLowerCase()}
                            {s.readOnly ? ` · direct payout${s.legRef ? ` (${s.legRef})` : ''}` : ''}
                          </span>
                          {!s.readOnly && s.status === 'RECORDED' && canConfirm ? (
                            <Button
                              onClick={() => cmd.run(`Confirm route settlement ${s.ref}`, (k) => confirmRouteSettlementAction({ routeSettlementId: s.id }, k))}
                            >
                              Confirm
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {canRecord && (p.status === 'OPEN' || p.status === 'PARTIALLY_SETTLED') ? (
                    <div className={styles.record}>
                      <div className="ix-field">
                        <label htmlFor={`flow-${p.obligationId}`}>Direction</label>
                        <select
                          id={`flow-${p.obligationId}`}
                          className="ix-input"
                          value={flow}
                          onChange={(e) => setFlows((s) => ({ ...s, [p.obligationId]: e.target.value as 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE' }))}
                        >
                          <option value="FROM_ROUTE_TO_EXCHANGE">Route → exchange</option>
                          <option value="TO_ROUTE">Exchange → route</option>
                        </select>
                      </div>
                      <MoneyInput
                        label={`Amount (${side.currency})`}
                        currency={side.currency}
                        value={amounts[p.obligationId] ?? ''}
                        onChange={(v) => setAmounts((s) => ({ ...s, [p.obligationId]: v }))}
                        hint={`Remaining ${side.amount} ${side.currency}`}
                      />
                      {side.currency === 'INR' ? (
                        <>
                          <UTRField value={utrs[p.obligationId] ?? ''} onChange={(v) => setUtrs((s) => ({ ...s, [p.obligationId]: v }))} />
                          <div className="ix-field">
                            <label htmlFor={`acct-${p.obligationId}`}>Exchange account</label>
                            <select
                              id={`acct-${p.obligationId}`}
                              className="ix-input"
                              value={accountFor[p.obligationId] ?? accounts[0]?.accountId ?? ''}
                              onChange={(e) => setAccountFor((s) => ({ ...s, [p.obligationId]: e.target.value }))}
                            >
                              {accounts.map((a) => (
                                <option key={a.accountId} value={a.accountId}>
                                  {a.bankName} · {a.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      ) : (
                        <p className="ix-muted">USDT settlements are recorded with their transaction hash from the USDT screen.</p>
                      )}
                      <Button
                        disabled={(amounts[p.obligationId] ?? '') === '' || side.currency !== 'INR' || (utrs[p.obligationId] ?? '').length < 6}
                        onClick={() =>
                          cmd
                            .run(`Record ${amounts[p.obligationId]} ${side.currency} against ${p.ref}`, (k) =>
                              recordRouteSettlementAction(
                                {
                                  routeObligationId: p.obligationId,
                                  flow,
                                  amount: amounts[p.obligationId] ?? '',
                                  rail: 'IMPS',
                                  utr: normalizeUtr(utrs[p.obligationId] ?? ''),
                                  inrAccountId: accountFor[p.obligationId] ?? accounts[0]?.accountId ?? null,
                                },
                                k,
                              ),
                            )
                            .then((out) => {
                              if (out.ok) {
                                setAmounts((s) => ({ ...s, [p.obligationId]: '' }));
                                setUtrs((s) => ({ ...s, [p.obligationId]: '' }));
                              }
                              return out;
                            })
                        }
                      >
                        Record settlement
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {wallets.length === 0 ? null : <p className="ix-muted">Treasury wallets available for USDT route settlements: {wallets.length}.</p>}
        </section>
      ) : null}

      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
