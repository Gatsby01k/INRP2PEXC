'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { InrView } from '@inrp2p/desk';
import { Button, CapacityMeter, MoneyInput } from '@inrp2p/ui';
import { formatInr } from '@inrp2p/ui/format';
import { setDayCapacityAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import styles from './inr.module.css';

/**
 * INR settlement accounts and today's capacity (UX_FLOWS §2, FI-30). Capacity is the desk's promise about what
 * it can pay today; changing it is step-up protected and always carries a reason, because a payout that was
 * refused this morning and allowed this afternoon has to be explainable.
 */
export function InrClient({ view, canChangeCapacity }: { view: InrView; canChangeCapacity: boolean }) {
  const cmd = useCommand();
  const [values, setValues] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  return (
    <div className="ix-stack">
      <section className="ix-card">
        <h2 className="ix-sectionTitle">Today</h2>
        <dl className={styles.totals}>
          <div>
            <dt>Capacity</dt>
            <dd className="ix-num">{formatInr(Money.parse(view.totals.capacity, 'INR'))}</dd>
          </div>
          <div>
            <dt>Used</dt>
            <dd className="ix-num">{formatInr(Money.parse(view.totals.used, 'INR'))}</dd>
          </div>
          <div>
            <dt>Reserved</dt>
            <dd className="ix-num">{formatInr(Money.parse(view.totals.reserved, 'INR'))}</dd>
          </div>
          <div>
            <dt>Available</dt>
            <dd className="ix-num">{formatInr(Money.parse(view.totals.available, 'INR'))}</dd>
          </div>
        </dl>
      </section>

      <div className={styles.accounts}>
        {view.accounts.map((a) => (
          <section key={a.accountId} className="ix-card" data-testid={`account-${a.accountId}`}>
            <CapacityMeter
              accountLabel={`${a.bankName} · ${a.label}`}
              capacity={Money.parse(a.capacityToday, 'INR')}
              used={Money.parse(a.usedToday, 'INR')}
              reserved={Money.parse(a.reservedToday, 'INR')}
              status={a.status}
              compact={false}
            />
            <p className="ix-muted">
              {a.entityName} · {a.ifsc} ••••{a.last4} · {a.direction.toLowerCase()} · {a.rails.join(', ')}
              {a.dayOpened ? '' : ' · today runs on the default capacity'}
            </p>
            {canChangeCapacity ? (
              <div className={styles.capacityForm}>
                <MoneyInput
                  label="Capacity today"
                  currency="INR"
                  value={values[a.accountId] ?? ''}
                  onChange={(v) => setValues((s) => ({ ...s, [a.accountId]: v }))}
                  hint={`Now ${formatInr(Money.parse(a.capacityToday, 'INR'))}`}
                />
                <div className="ix-field">
                  <label htmlFor={`reason-${a.accountId}`}>Reason</label>
                  <input
                    id={`reason-${a.accountId}`}
                    className="ix-input"
                    value={reasons[a.accountId] ?? ''}
                    onChange={(e) => setReasons((s) => ({ ...s, [a.accountId]: e.target.value }))}
                  />
                </div>
                <Button
                  disabled={(values[a.accountId] ?? '') === '' || (reasons[a.accountId] ?? '').trim().length < 3}
                  onClick={() =>
                    cmd
                      .run(`Set today's capacity on ${a.label}`, (k) =>
                        setDayCapacityAction({ accountId: a.accountId, capacity: values[a.accountId] ?? '', reason: reasons[a.accountId] ?? '' }, k),
                      )
                      .then((out) => {
                        if (out.ok) setValues((s) => ({ ...s, [a.accountId]: '' }));
                        return out;
                      })
                  }
                >
                  Set capacity
                </Button>
              </div>
            ) : null}
          </section>
        ))}
      </div>

      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
