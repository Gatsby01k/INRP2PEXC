'use client';

import { useMemo, useState } from 'react';
import type { DeskPriceView } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setDeskPricesAction } from '../../../../server/actions/desks.ts';
import { Field, Switch } from '../../_workspace/Field.tsx';
import { InfoIcon } from '../../_workspace/icons.tsx';
import { useServerClock } from '../../exchange/useServerClock.ts';
import { DESK_SIDE, inr, percent, previewDeal, rate as rateText, rateGap, relative, sentence, usdt } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../desk.module.css';

type Direction = 'SELL_USDT' | 'BUY_USDT';
interface Draft {
  rate: string;
  min: string;
  max: string;
  live: boolean;
}

const HOURS = [
  { hours: 6, label: '6 h' },
  { hours: 12, label: '12 h' },
  { hours: 24, label: '24 h' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
] as const;

const plainRate = (r: string) => {
  const [whole = '0', fraction = ''] = r.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
};
const draftOf = (p: DeskPriceView | null): Draft => ({ rate: p ? plainRate(p.rate) : '', min: p ? p.min.replace(/\.?0+$/, '') : '100', max: p ? p.max.replace(/\.?0+$/, '') : '10000', live: p?.live ?? true });
const clean = (v: string) => v.replace(/[^0-9.]/g, '');

const EXAMPLE = '1000';

/**
 * Both sides of the desk's book, side by side: the rate, the smallest and largest deal, and whether the side is offered
 * — with what a client of an example size sends and receives at it, and what the desk gets. "Prices live" at the top
 * switches the page's prices on and off in one step; editing a side is saved with its validity.
 */
export function PricesEditor({
  pricing,
  canCommit,
}: {
  pricing: { prices: Readonly<Record<Direction, DeskPriceView | null>>; capacity: { SELL_USDT: string | null; BUY_USDT: string | null }; feeBps: number; now: string };
  canCommit: boolean;
}) {
  const now = useServerClock(pricing.now, false);
  const [drafts, setDrafts] = useState<Record<Direction, Draft>>({ SELL_USDT: draftOf(pricing.prices.SELL_USDT), BUY_USDT: draftOf(pricing.prices.BUY_USDT) });
  const [hours, setHours] = useState<number>(24);
  const { run, busy, error, dialog } = useCommand();
  const [saved, setSaved] = useState(false);

  const anyLive = (['SELL_USDT', 'BUY_USDT'] as const).some((d) => pricing.prices[d]?.offered);
  const until = (['SELL_USDT', 'BUY_USDT'] as const).map((d) => pricing.prices[d]).filter((p): p is DeskPriceView => p !== null && p.offered).map((p) => Date.parse(p.validUntil)).sort()[0];
  const set = (d: Direction, patch: Partial<Draft>) => {
    setSaved(false);
    setDrafts((x) => ({ ...x, [d]: { ...x[d], ...patch } }));
  };

  const valid = (d: Direction) => {
    const x = drafts[d];
    return x.rate !== '' && Number(x.rate) > 0 && x.min !== '' && x.max !== '' && Number(x.min) > 0 && Number(x.max) >= Number(x.min);
  };
  const sides = (['SELL_USDT', 'BUY_USDT'] as const).filter((d) => drafts[d].rate !== '');
  const canSave = canCommit && sides.length > 0 && sides.every(valid) && !busy;
  const crossed = drafts.SELL_USDT.rate && drafts.BUY_USDT.rate && Number(drafts.SELL_USDT.rate) >= Number(drafts.BUY_USDT.rate);

  const save = async (liveOverride?: boolean) => {
    const list = (liveOverride === undefined ? sides : (['SELL_USDT', 'BUY_USDT'] as const).filter((d) => pricing.prices[d] !== null)).map((d) => {
      const src = liveOverride === undefined ? drafts[d] : draftOf(pricing.prices[d]);
      return { direction: d, rate: src.rate, min: src.min, max: src.max, live: liveOverride ?? src.live };
    });
    if (list.length === 0) return;
    const out = await run(liveOverride === undefined ? 'Save prices' : liveOverride ? 'Prices live' : 'Prices off', (key) => setDeskPricesAction({ prices: list, validForHours: hours }, key));
    if (out.ok) {
      setSaved(true);
      if (liveOverride !== undefined) setDrafts((x) => ({ SELL_USDT: { ...x.SELL_USDT, live: liveOverride }, BUY_USDT: { ...x.BUY_USDT, live: liveOverride } }));
    }
  };

  const examples = useMemo(
    () =>
      Object.fromEntries(
        (['SELL_USDT', 'BUY_USDT'] as const).map((d) => [d, drafts[d].rate ? previewDeal({ direction: d, fixedSide: 'BASE', amount: EXAMPLE, rate: drafts[d].rate, feeBps: pricing.feeBps }) : null]),
      ) as Record<Direction, ReturnType<typeof previewDeal>>,
    [drafts, pricing.feeBps],
  );

  return (
    <main className={shell.main}>
      <section className={`${shell.card}`} aria-labelledby="live-title">
        <div className={styles.switchRow}>
          <div className={styles.checkText}>
            <h2 id="live-title" className={shell.cardTitle}>
              Prices live
            </h2>
            <span className={shell.muted}>
              {anyLive && until ? `Clients on your page are priced now · until ${formatIstDateTime(new Date(until))} (${relative(until, now)})` : 'Your page shows no prices; links still work at their own rate.'}
            </span>
          </div>
          <Switch checked={anyLive} label="Prices live" disabled={!canCommit || busy || (pricing.prices.SELL_USDT === null && pricing.prices.BUY_USDT === null)} onChange={(next) => void save(next)} />
        </div>
      </section>

      <div className={styles.grid2}>
        {(['SELL_USDT', 'BUY_USDT'] as const).map((d) => {
          const x = drafts[d];
          const ex = examples[d];
          const priced = ex && typeof ex !== 'string' ? ex : null;
          const capacity = pricing.capacity[d];
          return (
            <section key={d} className={shell.card} aria-labelledby={`side-${d}`}>
              <div className={styles.switchRow}>
                <div className={styles.checkText}>
                  <h2 id={`side-${d}`} className={shell.cardTitle}>
                    {DESK_SIDE[d].you}
                  </h2>
                  <span className={shell.muted}>{d === 'SELL_USDT' ? 'What you pay a client for USDT' : 'What a client pays you for USDT'}</span>
                </div>
                <Switch checked={x.live} label={`Offer: ${DESK_SIDE[d].you}`} disabled={!canCommit} onChange={(next) => set(d, { live: next })} />
              </div>
              <Field label="Rate, ₹ per USDT" inputMode="decimal" adornment="₹" value={x.rate} placeholder={d === 'SELL_USDT' ? '104.60' : '105.40'} onChange={(e) => set(d, { rate: clean(e.target.value) })} disabled={!canCommit} />
              <div className={styles.row2}>
                <Field label="Smallest deal" inputMode="decimal" adornment="USDT" value={x.min} onChange={(e) => set(d, { min: clean(e.target.value) })} disabled={!canCommit} />
                <Field label="Largest deal" inputMode="decimal" adornment="USDT" value={x.max} onChange={(e) => set(d, { max: clean(e.target.value) })} disabled={!canCommit} error={x.min && x.max && Number(x.max) < Number(x.min) ? 'Below the smallest deal.' : null} />
              </div>
              {priced ? (
                <dl className={styles.preview} aria-label={`A client deal of ${EXAMPLE} USDT`}>
                  <div className={styles.previewRow}>
                    <dt>{d === 'SELL_USDT' ? `A client selling ${usdt(EXAMPLE)} gets` : `A client buying ${usdt(EXAMPLE)} pays`}</dt>
                    <dd>{inr(priced.clientInr.toDecimalString())}</dd>
                  </div>
                  <div className={styles.previewRow}>
                    <dt>{d === 'SELL_USDT' ? 'You receive' : 'You put in escrow'}</dt>
                    <dd>{usdt(priced.routeBase.toDecimalString())}</dd>
                  </div>
                  <div className={styles.previewRow} data-quiet="">
                    <dt>INRP2P fee · {percent(pricing.feeBps)}</dt>
                    <dd>{usdt(priced.platformFeeBase.toDecimalString())}</dd>
                  </div>
                </dl>
              ) : null}
              <p className={shell.muted}>
                {capacity === null ? 'You do not offer this side on Traders.' : d === 'SELL_USDT' ? `You can pay up to ${inr(capacity)} right now.` : `You can deliver up to ${usdt(capacity)} right now.`}
              </p>
            </section>
          );
        })}
      </div>

      <section className={shell.card} aria-labelledby="hold-title">
        <div className={shell.cardHead}>
          <h2 id="hold-title" className={shell.cardTitle}>
            Hold these prices for
          </h2>
          {drafts.SELL_USDT.rate && drafts.BUY_USDT.rate ? <span className={shell.muted}>Spread {rateGap(drafts.BUY_USDT.rate, drafts.SELL_USDT.rate)} per USDT</span> : null}
        </div>
        <div className={styles.choices}>
          {HOURS.map((h) => (
            <button key={h.hours} type="button" className={styles.choice} aria-pressed={hours === h.hours} onClick={() => setHours(h.hours)} disabled={!canCommit}>
              {h.label}
            </button>
          ))}
        </div>
        <p className={shell.info}>
          <InfoIcon className={shell.infoIcon} />
          <span>Prices switch themselves off when their time runs out, so your page never deals on a price you forgot. Update them before then to keep dealing.</span>
        </p>
        {crossed ? (
          <p className={shell.info} data-tone="warning">
            <InfoIcon className={shell.infoIcon} />
            <span>You would pay {rateText(drafts.SELL_USDT.rate)} for USDT and sell it for {rateText(drafts.BUY_USDT.rate)} — at or below what you pay.</span>
          </p>
        ) : null}
        {error ? (
          <p className={shell.error} role="alert">
            {sentence(error)}
          </p>
        ) : null}
        <div className={styles.cardActions}>
          <button type="button" className={shell.action} disabled={!canSave} aria-busy={busy || undefined} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save prices'}
          </button>
          {saved ? <span className={shell.muted}>Saved. Clients see them now.</span> : null}
          {!canCommit ? <span className={shell.muted}>Someone who can accept quotes for your account sets prices.</span> : null}
        </div>
      </section>
      {dialog}
    </main>
  );
}
