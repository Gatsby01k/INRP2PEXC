'use client';

import { useId, useState } from 'react';
import type { PriceAskView } from '@inrp2p/traders';
import { ArcLoader, sanitizeAmountInput } from '@inrp2p/ui';
import { formatCountdown, formatIstTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { bidOnRfqAction } from '../../../../server/actions/traders.ts';
import { ClockIcon } from '../../_workspace/icons.tsx';
import { amountIn, rate, sentence, sideTitle } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * A price INRP2P asks this trader for (ADR 0025): an amount no instant offer covered, put to a few traders at once. The
 * trader names its rate for the whole amount; it is firm until the request closes, and the best price gets the order —
 * opened and held then, straight away. Bidding again replaces the earlier rate. The clock is the server's.
 */
export function PriceAskCard({ ask, now, canAct }: { ask: PriceAskView; now: number; canAct: boolean }) {
  const { run, busy, error, dialog } = useCommand();
  const [value, setValue] = useState(ask.yourRate ?? '');
  const titleId = useId();
  const inputId = useId();
  const remaining = Date.parse(ask.closesAt) - now;
  const closed = remaining <= 0;
  const buy = ask.side === 'BUY_USDT';

  const send = () => run(`Price ${ask.ref}`, (key) => bidOnRfqAction({ ref: ask.ref, rate: value }, key));

  return (
    <section className={`${shell.surface} ${styles.offer}`} aria-labelledby={titleId}>
      <div className={styles.offerHead}>
        <p className={styles.eyebrow}>Your price is asked for</p>
        <span className={styles.countdown} aria-live="off">
          <ClockIcon className={shell.infoIcon} />
          {closed ? (
            <span>Closed</span>
          ) : (
            <span>
              Closes in <strong>{formatCountdown(remaining)}</strong> · at {formatIstTime(new Date(ask.closesAt))}
            </span>
          )}
        </span>
      </div>
      <h2 id={titleId} className={styles.offerTitle}>
        {sideTitle(ask.side)}
        <span className={styles.ref}>{ask.ref}</span>
      </h2>
      <dl className={styles.terms}>
        <div>
          <dt>Amount</dt>
          <dd>
            {amountIn(ask.currency, ask.amount)}
            <span className={styles.sub}>{buy ? 'You pay rupees and receive USDT' : 'You deliver USDT and receive rupees'}</span>
          </dd>
        </div>
        <div>
          <dt>Your price</dt>
          <dd>{ask.yourRate ? rate(ask.yourRate) : 'Not sent yet'}</dd>
        </div>
      </dl>

      {!canAct ? (
        <p className={shell.info}>Someone who can accept quotes for your account has to price this.</p>
      ) : (
        <form
          className={styles.actions}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className={styles.field} htmlFor={inputId}>
            <span className={styles.fieldLabel}>Your rate (INR per USDT) for the whole amount</span>
            <span className={styles.inputBox}>
              <span className={styles.inputAffix}>₹</span>
              <input
                id={inputId}
                className={styles.input}
                inputMode="decimal"
                autoComplete="off"
                value={value}
                onChange={(e) => {
                  const next = sanitizeAmountInput(e.target.value, 'INR');
                  if (next !== null) setValue(next);
                }}
              />
            </span>
            <span className={styles.fieldHint}>Firm until it closes. The best price gets the order straight away.</span>
          </label>
          <button type="submit" className={shell.action} disabled={busy || closed || !/[1-9]/.test(value)} aria-busy={busy || undefined}>
            {busy ? <ArcLoader size="sm" label="Sending" tone="inherit" /> : null}
            <span>{ask.yourRate ? 'Update price' : 'Send price'}</span>
          </button>
        </form>
      )}
      {error ? (
        <p className={shell.error} role="alert">
          {sentence(error)}
        </p>
      ) : null}
      {dialog}
    </section>
  );
}
