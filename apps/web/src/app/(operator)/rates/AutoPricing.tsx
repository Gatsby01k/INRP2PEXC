'use client';

import { useState } from 'react';
import type { AutoPricingView } from '@inrp2p/desk';
import { setPricingPolicyAction } from '../../../server/actions/pricing.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { TextField } from '../_desk/fields.tsx';
import { dateTime, pair, rate, usdt } from '../_desk/format.ts';
import { Chip, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

const age = (s: number | null) => (s === null ? '—' : s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const whole = (v: string) => (/^\d{1,4}$/.test(v) ? Number.parseInt(v, 10) : null);

/**
 * Automatic prices (ADR 0025): whether clients of the exchange get a firm price at once, the market references the prices
 * are bounded by, the guard-rails, and what the last day did. Every change is a person's, with the reason and a fresh
 * authenticator code; switching on is refused while either reference is stale.
 */

/** ADR 0028: why a request closed without a price, in the desk's words. */
const UNPRICED: Record<string, string> = {
  NO_MARKET: 'with the market stale',
  NETWORK_UNKNOWN: 'with network fees unknown',
  NO_OFFER: 'too large or small for any firm offer',
  NOT_COMPETITIVE: 'no firm offer at the market',
  NO_BID: 'no bid in time',
  OUTSIDE_LIMIT: 'only past the client’s own price',
};
export function AutoPricing({ view, canSet }: { view: AutoPricingView; canSet: boolean }) {
  const cmd = useCommand();
  const p = view.policy;
  const [premium, setPremium] = useState(String(p.maxPremiumBps));
  const [maxAge, setMaxAge] = useState(String(p.referenceMaxAgeSeconds));
  const [window, setWindow] = useState(String(p.rfqWindowSeconds));
  const [traders, setTraders] = useState(String(p.rfqMaxTraders));
  const stale = view.references.some((r) => !r.fresh);
  const set = (label: string, change: Omit<Parameters<typeof setPricingPolicyAction>[0], 'expectedPolicyId' | 'reason'>) => async (reason: string) =>
    (await cmd.run(label, (k) => setPricingPolicyAction({ expectedPolicyId: p.id, ...change, reason }, k))).ok;
  const limits = { premium: whole(premium), maxAge: whole(maxAge), window: whole(window), traders: whole(traders) };
  const limitsChanged = limits.premium !== p.maxPremiumBps || limits.maxAge !== p.referenceMaxAgeSeconds || limits.window !== p.rfqWindowSeconds || limits.traders !== p.rfqMaxTraders;
  const limitsValid = Object.values(limits).every((v) => v !== null);

  return (
    <div className={d.stack}>
      {cmd.dialog}
      <div className={d.row}>
        <Chip tone={p.autoQuote ? 'success' : 'neutral'}>{p.autoQuote ? 'Automatic prices on' : 'Automatic prices off'}</Chip>
        <Chip tone={p.rfq ? 'success' : 'neutral'}>{p.rfq ? 'Price requests on' : 'Price requests off'}</Chip>
        {canSet ? (
          <>
            <GuardedAction
              label={p.autoQuote ? 'Switch automatic prices off' : 'Switch automatic prices on'}
              tone={p.autoQuote ? 'danger' : 'neutral'}
              stepUp
              reasonLabel="Reason"
              minReason={10}
              disabled={!p.autoQuote && stale}
              disabledReason={!p.autoQuote && stale ? 'A market reference is missing or stale.' : null}
              consequence={p.autoQuote
                ? 'New requests wait for a person again. Prices already given keep their terms until they run out.'
                : 'Clients get a firm 60-second price the moment they ask, from the traders’ firm offers, never worse than the market reference, the deal’s network as their own line. A request nothing prices is answered at once — nothing waits for a person. Nothing is priced when the reference is stale.'}
              busy={cmd.busy}
              onConfirm={set(p.autoQuote ? 'Switch automatic prices off' : 'Switch automatic prices on', { autoQuote: !p.autoQuote })}
            />
            <GuardedAction
              label={p.rfq ? 'Stop price requests' : 'Start price requests'}
              stepUp
              reasonLabel="Reason"
              minReason={10}
              consequence={p.rfq
                ? 'A request no firm offer prices is answered at once: there is no price for it now.'
                : `A request no firm offer prices is put to up to ${p.rfqMaxTraders} traders for ${p.rfqWindowSeconds} seconds; the best bid becomes the client’s firm price.`}
              busy={cmd.busy}
              onConfirm={set(p.rfq ? 'Stop price requests' : 'Start price requests', { rfq: !p.rfq })}
            />
          </>
        ) : null}
      </div>

      {stale ? <Notice tone="warning" icon="clock">A market reference is missing or older than {p.referenceMaxAgeSeconds} s: nothing is priced automatically until the worker reads the books again.</Notice> : null}

      <dl className={d.kv}>
        {view.references.map((r) => (
          <div key={r.direction}>
            <dt>Market {r.direction === 'SELL_USDT' ? 'bid' : 'ask'} · {pair(r.direction)}</dt>
            <dd>
              {r.rate ? rate(r.rate) : 'None'} <span className={d.muted}>{age(r.ageSeconds)}{r.source ? ` · ${r.source}` : ''}</span>
            </dd>
          </div>
        ))}
        <div>
          <dt>Last 24 hours</dt>
          <dd>
            {view.lastDay.quoted} priced · {view.lastDay.accepted} accepted · {usdt(view.lastDay.acceptedNetUsdt)} net · {view.lastDay.fromRfq} from price requests ·{' '}
            {view.lastDay.unpriced} without a price
            {view.lastDay.unpriced > 0 ? (
              <span className={d.muted}>
                {' '}
                ({Object.entries(view.lastDay.unpricedBy).map(([why, n]) => `${n} ${UNPRICED[why] ?? why}`).join(', ')})
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd>
            Set {dateTime(p.setAt)} by {p.setBy} <span className={d.muted}>— {p.reason}</span>
          </dd>
        </div>
      </dl>

      {canSet ? (
        <div className={d.row}>
          <TextField label="Past the market, at most (bps)" value={premium} onChange={setPremium} mono hint="0: never worse for the client than the market reference." />
          <TextField label="Reference at most (seconds old)" value={maxAge} onChange={setMaxAge} mono />
          <TextField label="Price request open for (seconds)" value={window} onChange={setWindow} mono />
          <TextField label="Traders asked, at most" value={traders} onChange={setTraders} mono />
          <GuardedAction
            label="Save guard-rails"
            stepUp
            reasonLabel="Reason"
            minReason={10}
            disabled={!limitsChanged || !limitsValid}
            disabledReason={!limitsValid ? 'Whole numbers only.' : !limitsChanged ? 'Nothing changed.' : null}
            consequence="Applies to every price from now on. Prices already given keep the policy they were made with."
            busy={cmd.busy}
            onConfirm={set('Save guard-rails', { maxPremiumBps: limits.premium!, referenceMaxAgeSeconds: limits.maxAge!, rfqWindowSeconds: limits.window!, rfqMaxTraders: limits.traders! })}
          />
        </div>
      ) : null}
    </div>
  );
}
