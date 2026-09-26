'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m } from 'framer-motion';
import { Money, type Direction } from '@inrp2p/kernel';
import { DirectionToggle, MoneyInput } from '@inrp2p/ui';
import { formatUsdtCompact, groupDigits } from '@inrp2p/ui/format';
import type { QuoteModuleCopy } from '../../../content/site.ts';
import { ArrowIcon } from './icons.tsx';
import { requestHref } from './request.ts';
import { INITIAL_DIRECTION, robotCues } from './robot/cues.ts';
import styles from './quote.module.css';

/**
 * The hero's quote module — the client app's own request form (direction, then a USDT amount), shown to a
 * visitor who has not signed in yet.
 *
 * It is the page's one primary action, and the only place on the page where a direction is chosen. It prints no
 * rate and no converted amount: the desk prices a trade, and a figure computed here would be a price nobody
 * offered. What it does print is what the request will say and what happens to it, which is true for every
 * amount. "Request quote" opens the client app's Exchange screen with the direction and amount already chosen.
 */

/** Whole-USDT amounts offered as shortcuts. A typed amount is never rounded towards them. */
const PRESETS = ['25000', '100000', '500000'] as const;
const INITIAL_AMOUNT = '100000';
const EASE = [0.2, 0, 0, 1] as const;

/** A term that changes with the direction: the old words leave upwards as the new ones arrive. */
function Swap({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <m.span
        key={text}
        className={styles.swap}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE, delay } }}
        exit={{ opacity: 0, y: -6, transition: { duration: 0.14, ease: EASE } }}
      >
        {text}
      </m.span>
    </AnimatePresence>
  );
}


export function QuoteModule({ appOrigin, copy }: { appOrigin: string; copy: QuoteModuleCopy }) {
  const titleId = useId();
  const [direction, setDirection] = useState<Direction>(INITIAL_DIRECTION);
  const [amount, setAmount] = useState<string>(INITIAL_AMOUNT);

  // The robot hears about real changes to the request and nothing else: a value, a direction, and whether the
  // visitor is on the call to action (hovered or focused — pointer and keyboard count the same). Browsing the
  // module is not an event. Kept in a ref: none of it changes what the module draws.
  const onCta = useRef({ hover: false, focus: false });
  const markCta = (key: 'hover' | 'focus', on: boolean) => {
    onCta.current[key] = on;
    robotCues.setFocus(onCta.current.hover || onCta.current.focus ? 'cta' : 'none');
  };
  useEffect(() => () => robotCues.setFocus('none'), []);

  const changeDirection = (next: Direction) => {
    if (next === direction) return;
    setDirection(next);
    robotCues.emit({ kind: 'direction', direction: next });
  };
  /** `settled` for a value set in one step (a preset): the robot confirms it without waiting for more typing. */
  const changeAmount = (next: string, settled = false) => {
    if (next === amount) return;
    setAmount(next);
    robotCues.emit({ kind: 'value', settled });
  };

  const terms = [
    { key: 'counter', term: copy.counter[direction], value: copy.counterValue },
    { key: 'destination', term: copy.destination[direction], value: copy.destinationValue[direction] },
    { key: 'rate', term: copy.rate, value: copy.rateValue },
  ];

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <section
          className={styles.panel}
          aria-labelledby={titleId}
          data-robot-target="panel"
        >
          <h2 id={titleId} className="ix-visually-hidden">
            {copy.title}
          </h2>

          <div className={styles.direction} data-robot-target="toggle">
            <DirectionToggle value={direction} onChange={changeDirection} />
          </div>

          <div className={styles.amount} data-robot-target="amount">
            <MoneyInput label={copy.amount[direction]} currency="USDT" size="display" suffix="USDT · TRC20" value={amount} onChange={(next) => changeAmount(next)} />
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
          </div>

          <dl className={styles.terms}>
            {terms.map((t, i) => (
              <div key={t.key} className={styles.term}>
                <dt className={styles.termLabel}>
                  <Swap text={t.term} />
                </dt>
                <dd className={styles.termValue}>
                  <Swap text={t.value} delay={0.03 + i * 0.03} />
                </dd>
              </div>
            ))}
          </dl>

          <div className={styles.action}>
            <a
              className={styles.cta}
              href={requestHref(appOrigin, direction, amount)}
              data-robot-target="cta"
              onPointerEnter={() => markCta('hover', true)}
              onPointerLeave={() => markCta('hover', false)}
              onFocus={() => markCta('focus', true)}
              onBlur={() => markCta('focus', false)}
            >
              <span>{copy.cta}</span>
              <ArrowIcon className={styles.ctaIcon} />
            </a>
            <p className={styles.note}>{copy.note}</p>
          </div>
        </section>
      </MotionConfig>
    </LazyMotion>
  );
}
