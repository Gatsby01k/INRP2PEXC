'use client';

import { type CSSProperties, useId, useState } from 'react';
import { groupDigits } from '@inrp2p/ui/format';
import { type OwnDeskCopy, TRADER_TERMS } from '../../../../content/site.ts';
import { Led } from '../led/Led.tsx';
import { marketMid, useMarket } from '../market.ts';
import styles from './earnings.module.css';

type Copy = OwnDeskCopy['earnings'];

/** Whole units, grouped as the rest of the site groups them (D-11). */
const whole = (n: number): string => groupDigits(String(Math.max(0, Math.round(n))));

/** A percentage the way a trader says it: `6%`, `5.75%`. */
const pct = (n: number): string => `${Number(n.toFixed(2))}%`;

/**
 * What a trader's USDT earns: an example they set — how much USDT they hold, how often it turns over in a month, and
 * their margin over the market (the programme's band, TRADER_TERMS) — and what they keep of it after INRP2P's fee, in
 * rupees at the market's own rate (ADR 0025's reference, read once for the page) or, without one, in USDT. The robot
 * above the card wears the margin on its visor.
 *
 * Every figure here is the example's arithmetic on the trader's own choices: the margin is the price they set, the fee is
 * the fee policy's. Nothing is anybody's record. The first render — the server's — is the example's starting point in
 * USDT; the market's rate fills in rupees once it is read.
 */
export function Earnings({ copy, robot }: { copy: Copy; robot: { src: string; srcSet?: string | undefined; sizes?: string | undefined; width?: number | string | undefined; height?: number | string | undefined } }) {
  const id = useId();
  const { low, typical, high } = TRADER_TERMS.margin;
  const margins: readonly number[] = [low, typical, high];
  const [amount, setAmount] = useState<number>(copy.amounts[1] ?? copy.amounts[0] ?? 10_000);
  const [turnsAt, setTurnsAt] = useState(1);
  const [margin, setMargin] = useState<number>(typical);
  const market = useMarket();
  const mid = marketMid(market);

  const perMonth = copy.turnOptions[turnsAt]?.perMonth ?? 1;
  const turnover = amount * perMonth;
  const fee = TRADER_TERMS.feeBps / 100;
  const keepUsdt = (turnover * (margin - fee)) / 100;
  const keepShare = (margin - fee) / margin;

  return (
    <div className={styles.earnings}>
      {/* The robot leans over the card with the trader's margin on its visor; it hops when the margin changes. */}
      <div className={styles.robot} aria-hidden="true">
        <span key={margin} className={styles.robotHop}>
          <img {...robot} alt="" className={styles.robotImg} loading="lazy" decoding="async" />
          <span className={styles.visor}>
            <Led text={`+${margin}%`} pitch={5} rows={13} className={styles.visorLed} />
          </span>
        </span>
      </div>

      <div className={styles.card}>
        <div className={styles.head}>
          <h3 className={styles.title}>{copy.title}</h3>
          {mid ? (
            <span className={styles.live}>
              <span className={styles.liveDot} aria-hidden="true" />
              <span className="ix-visually-hidden">{copy.live} </span>₹{mid.toFixed(2)}
            </span>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.legend}>{copy.liquidity}</legend>
          <div className={styles.chips}>
            {copy.amounts.map((a) => (
              <label key={a} className={styles.chip}>
                <input type="radio" name={`${id}-amount`} value={a} checked={amount === a} onChange={() => setAmount(a)} />
                <span>{whole(a)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.field}>
          <legend className={styles.legend}>{copy.turns}</legend>
          <div className={styles.chips}>
            {copy.turnOptions.map((t, i) => (
              <label key={t.label} className={styles.chip}>
                <input type="radio" name={`${id}-turns`} value={i} checked={turnsAt === i} onChange={() => setTurnsAt(i)} />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.field}>
          <legend className={styles.legend}>{copy.margin}</legend>
          <div className={styles.margins} style={{ '--at': margins.indexOf(margin) } as CSSProperties}>
            <span className={styles.marginThumb} aria-hidden="true" />
            {margins.map((m) => (
              <label key={m} className={styles.margin}>
                <input type="radio" name={`${id}-margin`} value={m} checked={margin === m} onChange={() => setMargin(m)} />
                <span>{m}%</span>
              </label>
            ))}
          </div>
        </fieldset>

        <output className={styles.result} aria-live="polite">
          <span className={styles.resultLabel}>{copy.result}</span>
          <span className={styles.figure}>
            {mid ? (
              <>
                <span className={styles.rupee}>₹</span>
                {whole(keepUsdt * mid)}
              </>
            ) : (
              <>
                {whole(keepUsdt)}
                <span className={styles.unit}> USDT</span>
              </>
            )}
          </span>
          <span className={styles.sub}>
            {mid ? `≈ ${whole(keepUsdt)} ${copy.inUsdt}` : copy.inUsdt} · {copy.turnover} {whole(turnover)} USDT
          </span>
          <span className={styles.bar} aria-hidden="true">
            <span className={styles.barYours} style={{ flexGrow: keepShare }} />
            <span className={styles.barOurs} style={{ flexGrow: 1 - keepShare }} />
          </span>
          <span className={styles.barLabels}>
            <span>
              {copy.yours} <b>{pct(margin - fee)}</b>
            </span>
            <span>
              {copy.ours} <b>{pct(fee)}</b>
            </span>
          </span>
        </output>
        <p className={styles.note}>{copy.note}</p>
      </div>
    </div>
  );
}
