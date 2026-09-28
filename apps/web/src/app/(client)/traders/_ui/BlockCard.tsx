'use client';

import { useId, useState } from 'react';
import type { BlockView } from '@inrp2p/traders';
import { sanitizeAmountInput } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import { updateBlockAction } from '../../../../server/actions/traders.ts';
import { amountIn, rate, sentence } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

const MEANING = {
  BUY_USDT: 'You have INR and buy USDT. INRP2P sends you orders from clients selling USDT.',
  SELL_USDT: 'You have USDT and sell it for INR. INRP2P sends you orders from clients buying USDT.',
} as const;

const ISSUE_TEXT: Record<string, string> = {
  BLOCK_PAUSED: 'Paused — no orders on this side.',
  NO_RATE: 'Set your rate to receive orders on this side.',
  NO_LIMITS: 'Set the order size you take.',
  NO_CAPACITY: 'No capacity left on this side.',
};

function AmountField({ id, label, affix, value, onChange, currency, hint }: { id: string; label: string; affix: string; value: string; onChange: (v: string) => void; currency: 'INR' | 'USDT'; hint?: string | undefined }) {
  return (
    <label className={styles.field} htmlFor={id}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.inputBox}>
        <span className={styles.inputAffix}>{affix}</span>
        <input
          id={id}
          className={styles.input}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            const next = sanitizeAmountInput(e.target.value, currency);
            if (next !== null) onChange(next);
          }}
        />
      </span>
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  );
}

/**
 * One side of the trader's book: how much it can provide, its fixed rate and the order size it takes, and whether
 * the side is taking orders. Editing is the trader's own — within INRP2P's ceilings, never below what open orders
 * already hold — and quiet: no sound for a rate or a number. Registered settlement details are not edited here;
 * changing those is a desk review.
 */
export function BlockCard({ block, canAct }: { block: BlockView; canAct: boolean }) {
  const { run, busy, error, dialog, clearError } = useCommand();
  const [editing, setEditing] = useState(false);
  const [capacity, setCapacity] = useState(block.capacity);
  const [rateValue, setRate] = useState(block.rate ?? '');
  const [minOrder, setMin] = useState(block.minOrder ?? '');
  const [maxOrder, setMax] = useState(block.maxOrder ?? '');
  const [active, setActive] = useState(block.status === 'ACTIVE');
  const titleId = useId();
  const ids = { capacity: useId(), rate: useId(), min: useId(), max: useId() };
  const buy = block.side === 'BUY_USDT';
  const currency = block.currency;
  const unit = currency === 'INR' ? '₹' : 'USDT';

  const reset = () => {
    setCapacity(block.capacity);
    setRate(block.rate ?? '');
    setMin(block.minOrder ?? '');
    setMax(block.maxOrder ?? '');
    setActive(block.status === 'ACTIVE');
    clearError();
  };
  const save = async () => {
    const out = await run(`Save ${buy ? 'Buy USDT' : 'Sell USDT'}`, (key) =>
      updateBlockAction(
        {
          side: block.side,
          expectedVersion: block.version,
          capacity: capacity || '0',
          ...(rateValue ? { rate: rateValue } : {}),
          ...(minOrder ? { minOrder } : {}),
          ...(maxOrder ? { maxOrder } : {}),
          status: active ? 'ACTIVE' : 'PAUSED',
        },
        key,
      ),
    );
    if (out.ok) setEditing(false);
  };

  return (
    <section className={`${shell.card} ${styles.block}`} aria-labelledby={titleId}>
      <div className={styles.blockHead}>
        <h2 id={titleId} className={styles.blockTitle}>
          {buy ? 'Buy USDT' : 'Sell USDT'}
        </h2>
        <span className={styles.pill} data-tone={block.status === 'ACTIVE' ? 'done' : 'neutral'}>
          <span className={styles.pillDot} aria-hidden="true" />
          {block.status === 'ACTIVE' ? 'Active' : 'Paused'}
        </span>
      </div>
      <p className={styles.blockMeaning}>{MEANING[block.side]}</p>

      {editing ? (
        <form
          className={styles.editForm}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <AmountField
            id={ids.capacity}
            label={buy ? 'INR capacity' : 'USDT capacity'}
            affix={unit}
            value={capacity}
            onChange={setCapacity}
            currency={currency}
            hint={[/[1-9]/.test(block.held) ? `${amountIn(currency, block.held)} is held for open orders.` : null, block.limitMaxCapacity ? `INRP2P limit ${amountIn(currency, block.limitMaxCapacity)}.` : null].filter(Boolean).join(' ') || undefined}
          />
          <AmountField id={ids.rate} label="Your rate (INR per USDT)" affix="₹" value={rateValue} onChange={setRate} currency="INR" hint="A fixed rate. Changing it withdraws any offer made at the old rate." />
          <div className={styles.pair}>
            <AmountField id={ids.min} label="Minimum order" affix={unit} value={minOrder} onChange={setMin} currency={currency} />
            <AmountField id={ids.max} label="Maximum order" affix={unit} value={maxOrder} onChange={setMax} currency={currency} {...(block.limitMaxOrder ? { hint: `INRP2P limit ${amountIn(currency, block.limitMaxOrder)}` } : {})} />
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Take orders on this side
          </label>
          <div className={styles.formActions}>
            <button type="submit" className={shell.secondaryAction} disabled={busy}>
              Save
            </button>
            <button
              type="button"
              className={shell.textAction}
              disabled={busy}
              onClick={() => {
                reset();
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
          {error ? (
            <p className={shell.error} role="alert">
              {sentence(error)}
            </p>
          ) : null}
        </form>
      ) : (
        <>
          <dl className={styles.blockFigures}>
            <div>
              <dt>{buy ? 'INR available' : 'USDT available'}</dt>
              <dd data-big="">{amountIn(currency, block.available)}</dd>
              {block.limitMaxCapacity ? <span className={styles.blockLimit}>INRP2P limit {amountIn(currency, block.limitMaxCapacity)}</span> : null}
            </div>
            <div>
              <dt>Your rate</dt>
              <dd>{block.rate ? rate(block.rate) : 'Not set'}</dd>
            </div>
            <div>
              <dt>Per order</dt>
              <dd>{block.minOrder && block.maxOrder ? `${amountIn(currency, block.minOrder)} – ${amountIn(currency, block.maxOrder)}` : 'Not set'}</dd>
              {block.limitMaxOrder ? <span className={styles.blockLimit}>INRP2P limit {amountIn(currency, block.limitMaxOrder)} per order</span> : null}
            </div>
          </dl>
          {block.issues.length > 0 && block.issues[0] ? <p className={styles.note}>{ISSUE_TEXT[block.issues[0]]}</p> : null}
          {canAct ? (
            <div>
              <button
                type="button"
                className={shell.secondaryAction}
                onClick={() => {
                  reset();
                  setEditing(true);
                }}
              >
                Edit
              </button>
            </div>
          ) : null}
        </>
      )}
      {dialog}
    </section>
  );
}
