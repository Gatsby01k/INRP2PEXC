'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import type { BlockView, TraderHome } from '@inrp2p/traders';
import { ArcLoader, sanitizeAmountInput } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setUpTradingAction } from '../../../../server/actions/traders.ts';
import { Field, Segmented } from '../../_workspace/Field.tsx';
import { ArrowIcon } from '../../_workspace/icons.tsx';
import { amountIn, rate, sentence } from '../_ui/format.ts';
import { marketPreview, offsetText, parseOffsetBps } from '../_ui/market.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

type Choice = 'MARKET' | 'P20' | 'P50' | 'OTHER';

/**
 * The shortcuts a side's rate starts from (ADR 0028). A side buying USDT is chosen for paying more, a side selling it for
 * asking less: the shortcuts lean the way that brings orders, and "Other" takes any percentage within ten either way.
 */
const PRESETS: Record<BlockView['side'], Record<Exclude<Choice, 'OTHER'>, number>> = {
  BUY_USDT: { MARKET: 0, P20: 20, P50: 50 },
  SELL_USDT: { MARKET: 0, P20: -20, P50: -50 },
};

const SIDE_TEXT = {
  BUY_USDT: {
    title: 'Buy USDT · you pay INR',
    market: 'the market’s bid',
    lean: 'The more you pay, the more orders come to you.',
    capacity: 'INR you can provide',
  },
  SELL_USDT: {
    title: 'Sell USDT · you are paid INR',
    market: 'the market’s ask',
    lean: 'The less you ask, the more orders come to you.',
    capacity: 'USDT you can provide',
  },
} as const;

interface Draft {
  choice: Choice;
  other: string;
  capacity: string;
  min: string;
  max: string;
}

const isAmount = (v: string) => /[1-9]/.test(v);

/** A starting figure the trader can take as it is: its own if set, else what it applied with, within INRP2P's ceiling. */
function startAt(currency: 'INR' | 'USDT', own: string | null, applied: string | null, ceiling: string | null, fallback: string): string {
  const pick = own && isAmount(own) ? own : applied && isAmount(applied) ? applied : fallback;
  if (!ceiling || !isAmount(pick)) return pick;
  return Money.parse(pick, currency).minor > Money.parse(ceiling, currency).minor ? ceiling : pick;
}

function draftOf(b: BlockView, home: TraderHome): Draft {
  const buy = b.side === 'BUY_USDT';
  const a = home.application;
  const offset = b.rateBasis === 'MARKET' ? b.marketOffsetBps : null;
  const preset = Object.entries(PRESETS[b.side]).find(([, bps]) => bps === offset)?.[0] as Choice | undefined;
  const capacity = startAt(b.currency, isAmount(b.capacity) ? b.capacity : null, buy ? (a?.dailyInr ?? null) : (a?.dailyUsdt ?? null), b.limitMaxCapacity, '');
  return {
    choice: offset === null ? 'P20' : (preset ?? 'OTHER'),
    other: offset === null ? '' : offsetText(offset).replace('%', '').replace('−', '-'),
    capacity: capacity.replace(/\.0+$/, ''),
    min: (b.minOrder ?? (buy ? '1000' : '10')).replace(/\.0+$/, ''),
    max: startAt(b.currency, b.maxOrder, buy ? (a?.typicalInr ?? null) : (a?.typicalUsdt ?? null), b.limitMaxOrder, capacity).replace(/\.0+$/, ''),
  };
}

const offsetOf = (side: BlockView['side'], d: Draft): number | null => (d.choice === 'OTHER' ? parseOffsetBps(d.other) : PRESETS[side][d.choice]);

function compare(currency: 'INR' | 'USDT', a: string, b: string): number | null {
  try {
    const x = Money.parse(a, currency).minor;
    const y = Money.parse(b, currency).minor;
    return x === y ? 0 : x < y ? -1 : 1;
  } catch {
    return null;
  }
}

/** What is wrong with a side's draft, in words, or null when it can be saved. */
function problemOf(b: BlockView, d: Draft): string | null {
  if (offsetOf(b.side, d) === null) return 'Your rate: a percentage within 10% either way, like 0.30 or -0.25.';
  if (!isAmount(d.capacity)) return `Say how much ${b.currency} you can provide.`;
  if (!isAmount(d.min) || !isAmount(d.max)) return 'Say the smallest and the largest order you take.';
  if (compare(b.currency, d.min, d.max) === 1) return 'The smallest order is larger than the largest.';
  return null;
}

/**
 * The first start, on one screen (ADR 0028): each side the trader applied for, with its rate against the market — a
 * shortcut or its own percentage, and what it comes to now — how much it can provide and the order size it takes; then its
 * offer firm while it is online, and going online. Everything starts from what it applied with, so most traders only
 * look and press the one button.
 */
export function SetupFlow({ home }: { home: TraderHome }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(home.blocks.map((b) => [b.side, draftOf(b, home)])));
  const [instant, setInstant] = useState(true);
  const [online, setOnline] = useState(!home.available);
  const set = (side: string, change: Partial<Draft>) => setDrafts((all) => ({ ...all, [side]: { ...all[side]!, ...change } }));
  const problems = home.blocks.map((b) => problemOf(b, drafts[b.side]!));
  const ready = problems.every((p) => p === null) && home.canAct;

  const save = async () => {
    const out = await run(online ? 'Start taking orders' : 'Save your prices', (key) =>
      setUpTradingAction(
        {
          sides: home.blocks.map((b) => {
            const d = drafts[b.side]!;
            return { side: b.side, expectedVersion: b.version, capacity: d.capacity, marketOffsetBps: offsetOf(b.side, d)!, minOrder: d.min, maxOrder: d.max };
          }),
          instant,
          goOnline: online && !home.available,
        },
        key,
      ),
    );
    if (out.ok) router.push('/traders');
  };

  return (
    <main className={`${shell.main} ${shell.centred}`}>
      <form
        className={`${shell.surface} ${styles.setup}`}
        aria-label="Set your prices"
        data-robot-target="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
      >
        {home.blocks.map((b, i) => {
          const d = drafts[b.side]!;
          const t = SIDE_TEXT[b.side];
          const bps = offsetOf(b.side, d);
          const preview = bps === null ? null : marketPreview(b, d.choice === 'OTHER' ? d.other : String(bps / 100), '');
          const unit = b.currency === 'INR' ? '₹' : 'USDT';
          const presets = PRESETS[b.side];
          return (
            <section key={b.side} className={styles.setupSide} aria-labelledby={`setup-${b.side}`}>
              <h2 id={`setup-${b.side}`} className={styles.setupTitle}>
                {t.title}
              </h2>
              <Segmented<Choice>
                legend="Your rate against the market"
                value={d.choice}
                onChange={(choice) => set(b.side, { choice })}
                options={[
                  { value: 'MARKET', label: 'At the market', detail: 'Exactly the rate' },
                  { value: 'P20', label: offsetText(presets.P20), detail: b.side === 'BUY_USDT' ? 'Pay a little more' : 'Ask a little less' },
                  { value: 'P50', label: offsetText(presets.P50), detail: b.side === 'BUY_USDT' ? 'Pay more, more orders' : 'Ask less, more orders' },
                  { value: 'OTHER', label: 'Other', detail: 'Your own %' },
                ]}
              />
              {d.choice === 'OTHER' ? (
                <Field
                  label="Your percentage"
                  inputMode="decimal"
                  autoComplete="off"
                  value={d.other}
                  onChange={(e) => set(b.side, { other: e.target.value.replace(/[^0-9+\-−.,%]/g, '').slice(0, 7) })}
                  adornment="%"
                  error={d.other && parseOffsetBps(d.other) === null ? 'A percentage within 10% either way, like 0.30 or -0.25.' : null}
                />
              ) : null}
              <p className={styles.setupRate} aria-live="polite">
                {preview && bps !== null ? (
                  <>
                    <strong>{rate(preview)}</strong> now — {t.market} {rate(b.market!)} {offsetText(bps)}. It moves with the market. {t.lean}
                  </>
                ) : (
                  <>The market rate is not read right now: your rate shows here, and orders come, the moment it is. {t.lean}</>
                )}
              </p>
              <Field
                label={t.capacity}
                inputMode="decimal"
                autoComplete="off"
                value={d.capacity}
                onChange={(e) => {
                  const next = sanitizeAmountInput(e.target.value, b.currency);
                  if (next !== null) set(b.side, { capacity: next });
                }}
                adornment={unit}
                hint={`${b.limitMaxCapacity ? `INRP2P’s limit ${amountIn(b.currency, b.limitMaxCapacity)}. ` : ''}What you can trade in all: every completed order uses it up, and the side stops when it runs out. Top it up any time.`}
              />
              <div className={styles.pair}>
                <Field
                  label="Smallest order"
                  inputMode="decimal"
                  autoComplete="off"
                  value={d.min}
                  onChange={(e) => {
                    const next = sanitizeAmountInput(e.target.value, b.currency);
                    if (next !== null) set(b.side, { min: next });
                  }}
                  adornment={unit}
                />
                <Field
                  label="Largest order"
                  inputMode="decimal"
                  autoComplete="off"
                  value={d.max}
                  onChange={(e) => {
                    const next = sanitizeAmountInput(e.target.value, b.currency);
                    if (next !== null) set(b.side, { max: next });
                  }}
                  adornment={unit}
                  {...(b.limitMaxOrder ? { hint: `INRP2P’s limit ${amountIn(b.currency, b.limitMaxOrder)}.` } : {})}
                />
              </div>
              {problems[i] && (d.capacity || d.min || d.max) ? <p className={styles.note}>{problems[i]}</p> : null}
            </section>
          );
        })}

        <div className={styles.setupFinish}>
          <label className={styles.check}>
            <input type="checkbox" checked={instant} onChange={(e) => setInstant(e.target.checked)} />
            <span>
              <strong>Fill orders at once while I am online</strong>
              <span className={styles.setupHint}>INRP2P fills orders at your rate and within your limits without asking you each time. Off, you accept each one yourself.</span>
            </span>
          </label>
          {home.available ? null : (
            <label className={styles.check}>
              <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
              <span>
                <strong>Go online now</strong>
                <span className={styles.setupHint}>You can switch off any time; orders already started carry on.</span>
              </span>
            </label>
          )}
          <div className={styles.navRow}>
            <Link className={shell.textAction} href="/traders">
              Later
            </Link>
            <button type="submit" className={shell.action} disabled={!ready || busy} aria-busy={busy || undefined} data-robot-target="cta">
              {busy ? <ArcLoader size="sm" label="Saving" tone="inherit" /> : null}
              {online && !home.available ? 'Start taking orders' : 'Save my prices'}
              {busy ? null : <ArrowIcon className={shell.actionIcon} />}
            </button>
          </div>
          <p className={styles.setupHint}>Prefer a fixed rate, a bound the rate never passes, or fewer ways to pay? Each side has them on Traders.</p>
          {error ? (
            <p className={shell.error} role="alert">
              {sentence(error)}
            </p>
          ) : null}
        </div>
      </form>
      {dialog}
    </main>
  );
}
