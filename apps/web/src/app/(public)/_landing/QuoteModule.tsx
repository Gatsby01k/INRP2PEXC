'use client';

import { type CSSProperties, type ChangeEvent, type FocusEvent, type MouseEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { LayoutGroup, LazyMotion, MotionConfig, domMax, m } from 'framer-motion';
import { Money, type Direction } from '@inrp2p/kernel';
import { sanitizeAmountInput } from '@inrp2p/ui';
import { formatUsdtCompact, groupDigits } from '@inrp2p/ui/format';
import { Coin } from '../../../components/Coin.tsx';
import { ONBOARDING, type QuoteModuleCopy } from '../../../content/site.ts';
import { ArrowIcon, PointIcon } from './icons.tsx';
import { requestHref } from './request.ts';
import { marketEstimate } from './estimate.ts';
import { MARKET_RATE_PATH } from '../../../server/surface.ts';
import { INITIAL_DIRECTION, robotCues } from './robot/cues.ts';
import styles from './quote.module.css';

/**
 * The hero's quote module, drawn as a converter: what the visitor gives above, what they get below, a button between
 * them that turns the deal round — the two sides change places — and the escrow's promise for that direction under
 * them. It is the page's one primary action, and the only place on the page where a direction is chosen.
 *
 * The rupee side is an estimate at the market's own rate (ADR 0025's reference, read after the page is shown and cached at
 * the edge), marked as one and named as the market's — never a price INRP2P offers: that is the firm price the next
 * step gives. Without a fresh market rate it says what the price will be instead. "Get a firm price" opens the client
 * app's Exchange screen with the direction and amount already chosen — or, with no amount yet, keeps the visitor here
 * and asks for one next to the field.
 */

/** Whole-USDT amounts offered as shortcuts. A typed amount is never rounded towards them. */
const PRESETS = ['25000', '100000', '500000'] as const;
const INITIAL_AMOUNT = '100000';
const SPRING = { type: 'spring', stiffness: 520, damping: 40 } as const;
const DIRECTIONS: readonly Direction[] = ['SELL_USDT', 'BUY_USDT'];
const SIDE_LABEL: Record<Direction, string> = { SELL_USDT: 'Sell USDT', BUY_USDT: 'Buy USDT' };

function SwapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M8 4v16 M4.5 7.5 8 4l3.5 3.5 M16 20V4 M12.5 16.5 16 20l3.5-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `onboarding` is where a visitor without a client account opens one (server/site.ts `onboardingHref`). */
export function QuoteModule({ appOrigin, onboarding, copy }: { appOrigin: string; onboarding: string; copy: QuoteModuleCopy }) {
  const titleId = useId();
  const amountId = useId();
  const errorId = useId();
  const [direction, setDirection] = useState<Direction>(INITIAL_DIRECTION);
  const [amount, setAmount] = useState<string>(INITIAL_AMOUNT);

  // The market's rate, once the page is shown: the HTML reads no database, and a missing or stale rate leaves the words.
  const [market, setMarket] = useState<Record<Direction, string | null> | null>(null);
  useEffect(() => {
    let live = true;
    fetch(MARKET_RATE_PATH, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rates: Record<Direction, string | null> | null) => {
        if (live && rates) setMarket(rates);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const estimate = marketEstimate(amount, market?.[direction] ?? null);

  // The robot hears about real changes to the request and nothing else: a value, a direction, and whether the
  // visitor is on the call to action (hovered or focused — pointer and keyboard count the same). Browsing the
  // module is not an event. Kept in a ref: none of it changes what the module draws.
  const onCta = useRef({ hover: false, focus: false });
  const markCta = (key: 'hover' | 'focus', on: boolean) => {
    onCta.current[key] = on;
    robotCues.setFocus(onCta.current.hover || onCta.current.focus ? 'cta' : 'none');
  };
  // The first press or focus inside the module is the visitor starting work, and the robot answers it.
  // Not a press on the call to action: that answers for itself, by leaving for the request or by asking for an
  // amount. Keyboard focus arriving on it is still a first move.
  const engaged = useRef(false);
  const engage = (e: PointerEvent | FocusEvent) => {
    if (engaged.current) return;
    // A visitor on the way to ask for onboarding has not started a request.
    if (e.target instanceof Element && e.target.closest('[data-onboarding]')) return;
    const cta = e.target instanceof Element ? e.target.closest('[data-robot-target="cta"]') : null;
    if (cta && !(e.type === 'focus' && cta.matches(':focus-visible'))) return;
    engaged.current = true;
    robotCues.emit({ kind: 'engage' });
  };
  useEffect(() => () => robotCues.setFocus('none'), []);

  // A request with no amount is caught here rather than sent on: the visitor stays, the field says why and has
  // the focus, and the robot signals it once. Typing an amount clears it.
  const [missingAmount, setMissingAmount] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hasAmount = (value: string) => /[1-9]/.test(value);
  const request = (e: MouseEvent<HTMLAnchorElement>) => {
    if (hasAmount(amount)) return;
    e.preventDefault();
    setMissingAmount(true);
    // Heard before the focus moves: focusing the field is not the visitor's first move, and must not greet them.
    robotCues.emit({ kind: 'problem' });
    input.current?.focus();
  };

  const changeDirection = (next: Direction) => {
    if (next === direction) return;
    setDirection(next);
    robotCues.emit({ kind: 'direction', direction: next });
  };
  /** `settled` for a value set in one step (a preset): the robot confirms it without waiting for more typing. */
  const changeAmount = (next: string, settled = false) => {
    if (next === amount) return;
    setAmount(next);
    if (hasAmount(next)) setMissingAmount(false);
    const usdt = Number(next.replace(/[^\d.]/g, ''));
    robotCues.emit({ kind: 'value', settled, ...(Number.isFinite(usdt) && usdt > 0 ? { amount: usdt } : {}) });
  };
  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const next = sanitizeAmountInput(e.target.value, 'USDT');
    if (next !== null) changeAmount(next);
  };
  const [whole = '', fraction] = amount.split('.');
  const shown = whole ? `${groupDigits(whole)}${fraction !== undefined ? `.${fraction}` : ''}` : '';

  const usdtSide = (
    <m.div key="usdt" layout transition={SPRING} className={`${styles.side} ${missingAmount ? styles.invalid : ''}`} data-robot-target="amount">
      <label htmlFor={amountId} className={styles.sideLabel}>
        {copy.amount[direction]}
      </label>
      <div className={styles.sideRow}>
        <input
          ref={input}
          id={amountId}
          className={`${styles.input} ix-num`}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          value={shown}
          onChange={onInput}
          aria-invalid={missingAmount || undefined}
          aria-describedby={missingAmount ? errorId : undefined}
        />
        <span className={styles.chip}>
          <Coin currency="USDT" size={26} />
          USDT
          <span className={styles.chipNet}>TRC20</span>
        </span>
      </div>
      {missingAmount ? (
        <p id={errorId} className={styles.error} role="alert">
          {copy.amountRequired}
        </p>
      ) : null}
      <div className={styles.presets} role="group" aria-label={copy.presets}>
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`${styles.preset} ix-num`}
            aria-pressed={amount === preset}
            title={`${groupDigits(preset)} USDT`}
            onClick={() => changeAmount(preset, true)}
          >
            {/* The visible label starts the accessible name ("100k USDT"), as WCAG 2.5.3 asks. */}
            {formatUsdtCompact(Money.parse(preset, 'USDT'))}
            <span className="ix-visually-hidden"> USDT</span>
          </button>
        ))}
      </div>
    </m.div>
  );
  const inrSide = (
    <m.div key="inr" layout transition={SPRING} className={`${styles.side} ${styles.priced}`}>
      <span className={styles.sideLabel}>{copy.counter[direction]}</span>
      <div className={styles.sideRow}>
        <span className={styles.priceBox} aria-live="polite">
          {estimate ? (
            <>
              <span className={`${styles.estimate} ix-num`} style={{ '--chars': estimate.rupees.length + 3 } as CSSProperties}>
                ≈ ₹{estimate.rupees}
              </span>
              <span className={styles.estimateNote}>{copy.market.replace('{rate}', estimate.rate)}</span>
            </>
          ) : (
            <span className={styles.price}>{copy.counterValue}</span>
          )}
        </span>
        <span className={styles.chip}>
          <Coin currency="INR" size={26} />
          INR
        </span>
      </div>
    </m.div>
  );
  const selling = direction === 'SELL_USDT';

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <section
          className={styles.panel}
          aria-labelledby={titleId}
          data-robot-target="panel"
          onPointerDownCapture={engage}
          onFocusCapture={engage}
        >
          <h2 id={titleId} className="ix-visually-hidden">
            {copy.title}
          </h2>

          {/* Sell or buy, said plainly at the top; the pill slides to the side chosen. */}
          <div className={styles.direction} role="group" aria-label={copy.title} data-robot-target="toggle">
            {DIRECTIONS.map((d) => (
              <button key={d} type="button" className={styles.directionOption} aria-pressed={direction === d} onClick={() => changeDirection(d)}>
                {direction === d ? <m.span layoutId="quote-direction" transition={SPRING} className={styles.directionPill} /> : null}
                <span className={styles.directionText}>{SIDE_LABEL[d]}</span>
              </button>
            ))}
          </div>

          <LayoutGroup>
            <div className={styles.sides}>
              {selling ? usdtSide : inrSide}
              <button type="button" className={styles.swapButton} aria-label={copy.swap} onClick={() => changeDirection(selling ? 'BUY_USDT' : 'SELL_USDT')}>
                <SwapIcon />
              </button>
              {selling ? inrSide : usdtSide}
            </div>
          </LayoutGroup>

          <p className={styles.promise}>
            <PointIcon name="destination" className={styles.promiseIcon} />
            <span>{copy.promise[direction]}</span>
          </p>

          <div className={styles.action}>
            <a
              className={styles.cta}
              href={requestHref(appOrigin, direction, amount)}
              data-robot-target="cta"
              onPointerEnter={() => markCta('hover', true)}
              onPointerLeave={() => markCta('hover', false)}
              onFocus={() => markCta('focus', true)}
              onBlur={() => markCta('focus', false)}
              onClick={request}
            >
              <span>{copy.cta}</span>
              <ArrowIcon className={styles.ctaIcon} />
            </a>
            <p className={styles.note}>
              {copy.note} {ONBOARDING.prompt}{' '}
              <a className={styles.onboarding} href={onboarding} data-onboarding="">
                {ONBOARDING.label}
              </a>
            </p>
          </div>
        </section>
      </MotionConfig>
    </LazyMotion>
  );
}
