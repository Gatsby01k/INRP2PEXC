'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { sanitizeAmountInput } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { applyAsTraderAction } from '../../../../server/actions/traders.ts';
import { AssistantPanel } from '../../_assistant/AssistantPanel.tsx';
import type { AssistantState, Step } from '../../_assistant/model.ts';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import { inr, sentence, usdt } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

type Provides = 'INR' | 'USDT' | 'BOTH';

interface Options {
  readonly banks: readonly { id: string; label: string; holder: string }[];
  readonly wallets: readonly { id: string; label: string; address: string; usable: boolean }[];
  readonly reserveRequired: string | null;
}

const STEP_LABELS = ['What you provide', 'Your capacity', 'Settlement details', 'Security Reserve', 'Submit'];
const hasAmount = (v: string) => /[1-9]/.test(v);

/**
 * Five steps, one question each. Nothing here decides anything: the answers go to `trader.apply`, which checks the
 * accounts are this client's own and records the application for the desk. The Security Reserve shown is the one
 * the desk configured — when none is configured, the screen says the desk sets it at review, and invents nothing.
 */
export function ApplyFlow({ options }: { options: Options }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [step, setStep] = useState(0);
  const [provides, setProvides] = useState<Provides | null>(null);
  const [typicalInr, setTypicalInr] = useState('');
  const [typicalUsdt, setTypicalUsdt] = useState('');
  const [bankId, setBankId] = useState(options.banks[0]?.id ?? '');
  const usable = options.wallets.filter((w) => w.usable);
  const [walletId, setWalletId] = useState(usable[0]?.id ?? '');
  const [understood, setUnderstood] = useState(false);

  const offersBuy = provides === 'INR' || provides === 'BOTH';
  const offersSell = provides === 'USDT' || provides === 'BOTH';
  const canNext = [
    provides !== null,
    (!offersBuy || hasAmount(typicalInr)) && (!offersSell || hasAmount(typicalUsdt)),
    bankId !== '' && walletId !== '',
    understood,
    true,
  ][step];

  const submit = async () => {
    const out = await run('Submit trader application', (key) =>
      applyAsTraderAction({ offersBuy, offersSell, typicalInr: offersBuy ? typicalInr : null, typicalUsdt: offersSell ? typicalUsdt : null, bankAccountId: bankId, walletId }, key),
    );
    if (out.ok) router.push('/traders');
  };

  const steps: Step[] = STEP_LABELS.map((label, i) => ({ label, status: i < step ? 'done' : i === step ? 'current' : 'pending' }));
  const assistant: AssistantState = {
    mood: step === 4 ? 'focused' : 'ready',
    label: `Step ${step + 1} of 5`,
    title: STEP_LABELS[step]!,
    body: [
      'Choose what you can provide. You can do both.',
      'A typical amount you can provide. You set the exact capacity later, any time.',
      'You settle only through your own registered accounts.',
      'The reserve protects open orders. It is locked only while you provide liquidity.',
      'The desk reviews your application. You cannot provide liquidity until it approves.',
    ][step]!,
  };
  const bank = options.banks.find((b) => b.id === bankId);
  const wallet = options.wallets.find((w) => w.id === walletId);

  return (
    <>
      <main className={`${shell.main} ${shell.centred}`}>
        <form
          className={shell.surface}
          aria-label="Trader application"
          data-robot-target="panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (step < 4) {
              if (canNext) setStep(step + 1);
            } else void submit();
          }}
        >
          <ol className={styles.steps} aria-label={`Step ${step + 1} of 5`}>
            {STEP_LABELS.map((label, i) => (
              <li key={label} className={styles.stepDot} data-state={i < step ? 'done' : i === step ? 'current' : 'pending'}>
                <span className="ix-visually-hidden">{label}</span>
              </li>
            ))}
          </ol>

          {step === 0 ? (
            <fieldset className={styles.choices}>
              <legend className={styles.question}>What can you provide?</legend>
              {(
                [
                  ['INR', 'INR', 'You have INR and buy USDT.'],
                  ['USDT', 'USDT', 'You have USDT and sell it for INR.'],
                  ['BOTH', 'Both', 'You buy and sell.'],
                ] as const
              ).map(([value, name, meta]) => (
                <label key={value} className={styles.choice}>
                  <input type="radio" name="provides" value={value} checked={provides === value} onChange={() => setProvides(value)} />
                  <span className={styles.choiceText}>
                    <span className={styles.choiceName}>{name}</span>
                    <span className={styles.choiceMeta}>{meta}</span>
                  </span>
                  <span className={styles.ring} aria-hidden="true" />
                </label>
              ))}
            </fieldset>
          ) : null}

          {step === 1 ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>Your typical capacity</h2>
              {offersBuy ? (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>INR you can typically provide</span>
                  <span className={styles.inputBox}>
                    <span className={styles.inputAffix}>₹</span>
                    <input className={styles.input} inputMode="decimal" autoComplete="off" value={typicalInr} onChange={(e) => { const v = sanitizeAmountInput(e.target.value, 'INR'); if (v !== null) setTypicalInr(v); }} />
                  </span>
                </label>
              ) : null}
              {offersSell ? (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>USDT you can typically provide</span>
                  <span className={styles.inputBox}>
                    <span className={styles.inputAffix}>USDT</span>
                    <input className={styles.input} inputMode="decimal" autoComplete="off" value={typicalUsdt} onChange={(e) => { const v = sanitizeAmountInput(e.target.value, 'USDT'); if (v !== null) setTypicalUsdt(v); }} />
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>Settlement details</h2>
              <p className={styles.note}>Your own accounts, registered with INRP2P. Third-party accounts are not accepted.</p>
              {options.banks.length === 0 || usable.length === 0 ? (
                <p className={shell.info} data-tone="warning">
                  <InfoIcon className={shell.infoIcon} />
                  <span>
                    {options.banks.length === 0 ? 'You have no registered bank account. ' : ''}
                    {usable.length === 0 ? 'You have no registered TRC20 wallet for sending and receiving. ' : ''}
                    The desk registers accounts after checking them —{' '}
                    <Link className={shell.textAction} href="/destinations">
                      see Destinations
                    </Link>
                    .
                  </span>
                </p>
              ) : null}
              <fieldset className={styles.choices}>
                <legend className={shell.label}>Bank account</legend>
                {options.banks.map((b) => (
                  <label key={b.id} className={styles.choice}>
                    <input type="radio" name="bank" checked={bankId === b.id} onChange={() => setBankId(b.id)} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceName}>{b.label}</span>
                      <span className={styles.choiceMeta}>{b.holder}</span>
                    </span>
                    <span className={styles.ring} aria-hidden="true" />
                  </label>
                ))}
              </fieldset>
              <fieldset className={styles.choices}>
                <legend className={shell.label}>TRC20 wallet</legend>
                {options.wallets.map((w) => (
                  <label key={w.id} className={styles.choice} {...(w.usable ? {} : { 'data-disabled': '' })}>
                    <input type="radio" name="wallet" disabled={!w.usable} checked={walletId === w.id} onChange={() => setWalletId(w.id)} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceName} title={w.address}>
                        TRC20 · {shortenAddress(w.address)}
                      </span>
                      <span className={styles.choiceMeta}>{w.usable ? w.label : `${w.label} · registered for one direction only; ask the desk to register it for sending and receiving`}</span>
                    </span>
                    <span className={styles.ring} aria-hidden="true" />
                  </label>
                ))}
              </fieldset>
            </div>
          ) : null}

          {step === 3 ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>Security Reserve</h2>
              <div className={styles.reserveBox}>
                <span className={shell.label}>Required</span>
                <p className={styles.reserveAmount}>{options.reserveRequired ? usdt(options.reserveRequired) : 'Set by the desk at review'}</p>
                <p className={styles.note}>A USDT reserve is locked while you provide liquidity. It protects open orders and unresolved obligations.</p>
                <p className={styles.note}>You send it from your registered wallet after approval. It is not trading capacity, and it is released when you stop and your orders are finished.</p>
              </div>
              <label className={styles.check}>
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                I understand the Security Reserve
              </label>
            </div>
          ) : null}

          {step === 4 ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>Submit for review</h2>
              <dl className={shell.facts}>
                <div>
                  <dt>You provide</dt>
                  <dd>{provides === 'BOTH' ? 'INR and USDT' : provides}</dd>
                </div>
                {offersBuy ? (
                  <div>
                    <dt>Typical INR</dt>
                    <dd className="ix-num">{inr(typicalInr || '0')}</dd>
                  </div>
                ) : null}
                {offersSell ? (
                  <div>
                    <dt>Typical USDT</dt>
                    <dd className="ix-num">{usdt(typicalUsdt || '0')}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Bank account</dt>
                  <dd>{bank?.label ?? '—'}</dd>
                </div>
                <div>
                  <dt>TRC20 wallet</dt>
                  <dd>{wallet ? `TRC20 · ${shortenAddress(wallet.address)}` : '—'}</dd>
                </div>
                <div>
                  <dt>Security Reserve</dt>
                  <dd>{options.reserveRequired ? usdt(options.reserveRequired) : 'Set by the desk'}</dd>
                </div>
              </dl>
              <p className={shell.info}>
                <InfoIcon className={shell.infoIcon} />
                <span>Your status becomes “Under review”. You cannot provide liquidity until the desk approves.</span>
              </p>
            </div>
          ) : null}

          <div className={styles.navRow}>
            {step > 0 ? (
              <button type="button" className={shell.textAction} disabled={busy} onClick={() => setStep(step - 1)}>
                Back
              </button>
            ) : (
              <Link className={shell.textAction} href="/traders">
                Cancel
              </Link>
            )}
            <button type="submit" className={shell.action} disabled={!canNext || busy} aria-busy={busy || undefined}>
              {step < 4 ? 'Continue' : 'Submit for review'}
              <ArrowIcon className={shell.actionIcon} />
            </button>
          </div>
          {error ? (
            <p className={shell.error} role="alert">
              {sentence(error)}
            </p>
          ) : null}
        </form>
      </main>
      <AssistantPanel state={assistant} steps={steps} size="compact" />
      {dialog}
    </>
  );
}
