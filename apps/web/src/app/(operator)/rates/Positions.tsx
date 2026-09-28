'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { RoutePosition } from '@inrp2p/desk';
import { Button, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { confirmRouteSettlementAction, recordRouteSettlementAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { AmountField, SelectField } from '../_desk/fields.tsx';
import { dateTime, money, parseAmount, share, sub } from '../_desk/format.ts';
import { Chip, Empty, Meter, Notice, Side } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import r from './rates.module.css';

type Flow = 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE';

/**
 * Route positions (UX_FLOWS F5b): per obligation, what the route delivers and what the exchange delivers, and what
 * is left of each — measured the way FI-64 measures it. Recording a settlement files its evidence; confirming it
 * (⧗) posts the movement and allocates that side in the same transaction — there is no separate allocate step.
 * Direct payouts appear read-only: confirming the client leg already allocated them, and recording them again
 * would count the route side twice.
 */
export function Positions({
  positions,
  accounts,
  canRecord,
  canConfirm,
}: {
  positions: readonly RoutePosition[];
  accounts: readonly { accountId: string; label: string; bankName: string }[];
  canRecord: boolean;
  canConfirm: boolean;
}) {
  if (positions.length === 0) return <Empty title="No open route obligations" body="Every route has settled what it owes and what it is owed." />;
  return (
    <ul className={r.positions}>
      {positions.map((p) => (
        <Position key={p.obligationId} p={p} accounts={accounts} canRecord={canRecord} canConfirm={canConfirm} />
      ))}
    </ul>
  );
}

function SideFigure({ title, total, remaining }: { title: string; total: RoutePosition['routeDelivers']; remaining: RoutePosition['routeDeliversRemaining'] }) {
  const settled = sub(total.amount, remaining.amount, total.currency);
  return (
    <div className={r.sideFigure}>
      <span className={r.figureLabel}>{title}</span>
      <span className={r.figureValue}>{money(total.amount, total.currency)}</span>
      <Meter size="sm" label={`${money(settled, total.currency)} settled of ${money(total.amount, total.currency)}`} parts={[{ value: share(settled, total.amount, total.currency), tone: 'success' }]} />
      <span className={r.figureSub}>{remaining.amount === '0' || /^0(\.0+)?$/.test(remaining.amount) ? 'settled' : `${money(remaining.amount, remaining.currency)} to settle`}</span>
    </div>
  );
}

function Position({ p, accounts, canRecord, canConfirm }: { p: RoutePosition; accounts: readonly { accountId: string; label: string; bankName: string }[]; canRecord: boolean; canConfirm: boolean }) {
  const cmd = useCommand();
  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState<Flow>('FROM_ROUTE_TO_EXCHANGE');
  const [amount, setAmount] = useState('');
  const [utr, setUtr] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  const side = flow === 'TO_ROUTE' ? p.exchangeDeliversRemaining : p.routeDeliversRemaining;
  const pending = p.settlements.filter((s) => !s.readOnly && s.status === 'RECORDED');
  const typed = parseAmount(amount, side.currency);
  const recordable = canRecord && (p.status === 'OPEN' || p.status === 'PARTIALLY_SETTLED');

  return (
    <li className={r.position} data-testid={`position-${p.ref}`} {...(pending.length > 0 ? { 'data-attention': '' } : {})}>
      <div className={r.positionHead}>
        <div className={d.stackTight} style={{ gap: 2 }}>
          <span className={d.row}>
            <Side direction={p.direction} />
            {p.tradeRef ? (
              <Link href={`/orders/${encodeURIComponent(p.tradeRef)}`} className={d.link}>
                {p.tradeRef}
              </Link>
            ) : (
              <strong>{p.ref}</strong>
            )}
            <span className={d.muted}>{p.clientName ?? ''}</span>
          </span>
          <span className={d.meta}>
            {p.ref} · {p.routeName} · {p.executionMode === 'DIRECT_TO_CLIENT' ? 'direct to client' : 'to exchange'} · opened {dateTime(p.openedAt)}
          </span>
        </div>
        <SideFigure title="Route delivers" total={p.routeDelivers} remaining={p.routeDeliversRemaining} />
        <SideFigure title="Exchange delivers" total={p.exchangeDelivers} remaining={p.exchangeDeliversRemaining} />
        <div className={r.positionActions}>
          <Chip tone={p.status === 'PARTIALLY_SETTLED' ? 'brand' : p.status === 'SETTLED' ? 'success' : 'neutral'}>{p.status === 'PARTIALLY_SETTLED' ? 'Partly settled' : p.status.toLowerCase()}</Chip>
          {pending.length > 0 ? <Chip tone="warning">{pending.length} to confirm</Chip> : null}
          {recordable ? (
            <Button size="sm" intent={open ? 'ghost' : 'secondary'} onClick={() => setOpen((v) => !v)}>
              {open ? 'Close' : 'Record settlement'}
            </Button>
          ) : null}
        </div>
      </div>

      {p.settlements.length > 0 ? (
        <ul className={r.settlements}>
          {p.settlements.map((s) => (
            <li key={s.id} className={r.settlement}>
              <span className={d.num}>
                <strong>{money(s.amount, s.asset)}</strong> {s.side === 'ROUTE_DELIVERS' ? 'from the route' : 'to the route'}
              </span>
              <span className={d.muted}>
                {s.ref}
                {s.reference ? ` · ${s.asset === 'INR' ? `UTR ${maskUtr(s.reference)}` : `tx ${shortenHash(s.reference)}`}` : ''}
                {s.readOnly ? ` · direct payout${s.legRef ? ` ${s.legRef}` : ''}` : ''}
              </span>
              <Chip tone={s.status === 'CONFIRMED' ? 'success' : s.status === 'FAILED' ? 'danger' : 'warning'}>{s.status === 'RECORDED' ? 'Recorded' : s.status.toLowerCase()}</Chip>
              {!s.readOnly && s.status === 'RECORDED' && canConfirm ? (
                <Button
                  size="sm"
                  intent="primary"
                  disabled={cmd.busy}
                  shortcut={<StepUpMark label="needs your authenticator code" />}
                  onClick={() => cmd.run(`Confirm route settlement ${s.ref}`, (k) => confirmRouteSettlementAction({ routeSettlementId: s.id }, k))}
                >
                  Confirm
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {open && recordable ? (
        <div className={d.guard}>
          <p className={d.guardTitle}>Record a route settlement against {p.ref}</p>
          <div className={d.formGrid}>
            <SelectField<Flow>
              label="Direction"
              value={flow}
              onChange={setFlow}
              options={[
                { value: 'FROM_ROUTE_TO_EXCHANGE', label: 'Route → exchange' },
                { value: 'TO_ROUTE', label: 'Exchange → route' },
              ]}
            />
            <AmountField
              label={`Amount (${side.currency})`}
              currency={side.currency}
              value={amount}
              onChange={setAmount}
              hint={`Remaining ${money(side.amount, side.currency)}`}
              aside={
                <button type="button" className={d.linkButton} onClick={() => setAmount(side.amount)}>
                  All of it
                </button>
              }
            />
          </div>
          {side.currency === 'INR' ? (
            <div className={d.formGrid}>
              <UTRField value={utr} onChange={setUtr} />
              <SelectField label="Exchange account" value={accountId} onChange={setAccountId} options={accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} · ${a.label}` }))} />
            </div>
          ) : (
            <Notice>USDT route settlements are recorded with their transaction hash from the USDT treasury.</Notice>
          )}
          <p className={d.guardBody}>Recording files the evidence. Confirming it — with your authenticator — posts the movement and settles this side. There is no separate step after it.</p>
          <div className={d.actions}>
            <Button
              intent="primary"
              size="sm"
              disabled={cmd.busy || typed === null || !typed.isPositive() || side.currency !== 'INR' || normalizeUtr(utr).length < 6}
              onClick={() =>
                void cmd
                  .run(`Record ${money(amount, side.currency)} against ${p.ref}`, (k) =>
                    recordRouteSettlementAction({ routeObligationId: p.obligationId, flow, amount, rail: 'IMPS', utr: normalizeUtr(utr), inrAccountId: accountId || null }, k),
                  )
                  .then((out) => {
                    if (out.ok) {
                      setAmount('');
                      setUtr('');
                      setOpen(false);
                    }
                    return out;
                  })
              }
            >
              Record settlement
            </Button>
          </div>
        </div>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </li>
  );
}
