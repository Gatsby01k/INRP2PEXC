'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { TraderApplicationOptions } from '@inrp2p/traders';
import { sanitizeAmountInput } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { applyAsTraderAction } from '../../../../server/actions/traders.ts';
import { AssistantPanel } from '../../_assistant/AssistantPanel.tsx';
import type { AssistantState, Step } from '../../_assistant/model.ts';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import { inr, sentence, usdt } from '../_ui/format.ts';
import {
  type BankDraft, type WalletDraft, BankFields, EMPTY_BANK, EMPTY_WALLET, OWNERSHIP_TEXT, WalletFields, bankComplete, bankPayload, walletComplete, walletPayload,
} from '../_ui/SettlementFields.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

type Provides = 'INR' | 'USDT' | 'BOTH';
type Experience = 'BINANCE' | 'BYBIT' | 'OTHER' | 'NONE';
type EntityType = 'INDIVIDUAL' | 'COMPANY';

const STEP_LABELS = ['About you', 'What you provide', 'Your capacity', 'Settlement details', 'Security Reserve', 'Submit'];
const LAST = STEP_LABELS.length - 1;
const hasAmount = (v: string) => /[1-9]/.test(v);
const decimal = (v: string) => Number.parseFloat(v.replace(/,/g, '')) || 0;
const EXPERIENCE: readonly [Experience, string][] = [['BINANCE', 'Binance'], ['BYBIT', 'Bybit'], ['OTHER', 'Other'], ['NONE', 'No']];
const EXPERIENCE_WORDS: Record<Experience, string> = { BINANCE: 'Binance P2P', BYBIT: 'Bybit P2P', OTHER: 'Another P2P platform', NONE: 'No P2P experience' };
const TELEGRAM = /^@?[A-Za-z0-9_]{5,32}$/;
const PHONE = /^\+?[0-9]{8,15}$/;

/** Which step asks for a field the server refused, so a refusal returns the applicant to where they can fix it. */
const FIELD_STEP: Record<string, number> = {
  fullName: 0, entityType: 0, telegram: 0, phone: 0, contact: 0, experience: 0, profileLink: 0,
  offers: 1,
  typicalInr: 2, dailyInr: 2, typicalUsdt: 2, dailyUsdt: 2,
  bank: 3, wallet: 3, bankAccountId: 3, walletId: 3, accountNumber: 3, ifsc: 3, holderName: 3, bankName: 3, rails: 3, walletLabel: 3, confirmOwnership: 3,
};

/**
 * The trader application: six short steps, then the desk reviews it. Nothing here decides anything — the answers go
 * to `trader.apply`, which creates a new applicant's client (without the Exchange), records the bank account and the
 * wallet as pending review, and puts the application in front of the desk. No rate is asked for: rates are set by
 * an approved trader on its own screen. The Security Reserve shown is the one the desk configured, or nothing.
 */
export function ApplyFlow({ options }: { options: TraderApplicationOptions }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [step, setStep] = useState(0);
  const profile = options.profile;
  const [fullName, setFullName] = useState(profile.fullName ?? '');
  const [entityType, setEntityType] = useState<EntityType | null>(profile.entityType);
  const [telegram, setTelegram] = useState(profile.telegram ?? '');
  const [phone, setPhone] = useState('');
  const [experience, setExperience] = useState<Experience | null>(null);
  const [profileLink, setProfileLink] = useState('');
  const [provides, setProvides] = useState<Provides | null>(null);
  const [typicalInr, setTypicalInr] = useState('');
  const [dailyInr, setDailyInr] = useState('');
  const [typicalUsdt, setTypicalUsdt] = useState('');
  const [dailyUsdt, setDailyUsdt] = useState('');
  // An existing client may settle through a bank account or wallet the desk already verified for it, or submit new ones.
  const usableWallets = options.wallets.filter((w) => w.usable);
  const [bankId, setBankId] = useState<string>(options.banks[0]?.id ?? 'NEW');
  const [walletId, setWalletId] = useState<string>(usableWallets[0]?.id ?? 'NEW');
  const [bank, setBank] = useState<BankDraft>(EMPTY_BANK);
  const [wallet, setWallet] = useState<WalletDraft>(EMPTY_WALLET);
  const [owned, setOwned] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const offersBuy = provides === 'INR' || provides === 'BOTH';
  const offersSell = provides === 'USDT' || provides === 'BOTH';
  const tg = telegram.trim().replace(/^https?:\/\/(www\.)?t\.me\//i, '');
  const ph = phone.replace(/[\s()-]/g, '');
  const contactOk = (tg !== '' || ph !== '') && (tg === '' || TELEGRAM.test(tg)) && (ph === '' || PHONE.test(ph));
  const newBank = bankId === 'NEW';
  const newWallet = walletId === 'NEW';
  const sideOk = (offers: boolean, typical: string, daily: string) => !offers || (hasAmount(typical) && hasAmount(daily) && decimal(daily) >= decimal(typical));
  const canNext = [
    (profile.nameFixed || fullName.trim() !== '') && entityType !== null && contactOk && experience !== null,
    provides !== null,
    sideOk(offersBuy, typicalInr, dailyInr) && sideOk(offersSell, typicalUsdt, dailyUsdt),
    (newBank ? bankComplete(bank) : true) && (newWallet ? walletComplete(wallet) : true) && owned,
    understood,
    true,
  ][step];

  const submit = async () => {
    const out = await run('Submit trader application', (key) =>
      applyAsTraderAction(
        {
          ...(profile.nameFixed ? {} : { fullName: fullName.trim() }),
          ...(profile.typeFixed ? {} : { entityType }),
          telegram: tg === '' ? null : tg,
          phone: ph === '' ? null : ph,
          experience: experience!,
          profileLink: profileLink.trim() === '' ? null : profileLink.trim(),
          offersBuy,
          offersSell,
          typicalInr: offersBuy ? typicalInr : null,
          dailyInr: offersBuy ? dailyInr : null,
          typicalUsdt: offersSell ? typicalUsdt : null,
          dailyUsdt: offersSell ? dailyUsdt : null,
          ...(newBank ? { bank: bankPayload(bank) } : { bankAccountId: bankId }),
          ...(newWallet ? { wallet: walletPayload(wallet) } : { walletId }),
          confirmOwnership: owned,
        },
        key,
      ),
    );
    if (out.ok) {
      router.push('/traders');
      return;
    }
    const field = typeof out.details?.field === 'string' ? FIELD_STEP[out.details.field] : undefined;
    if (field !== undefined) setStep(field);
  };

  const steps: Step[] = STEP_LABELS.map((label, i) => ({ label, status: i < step ? 'done' : i === step ? 'current' : 'pending' }));
  const assistant: AssistantState = {
    mood: step === LAST ? 'focused' : 'ready',
    label: `Step ${step + 1} of ${STEP_LABELS.length}`,
    title: STEP_LABELS[step]!,
    body: [
      'Who you are, and how the desk can reach you about your application.',
      'Choose what you can provide. You can do both.',
      'A typical order and what you can provide in a day. You set exact capacity and rates after approval.',
      'Your own bank account and TRC20 wallet. The desk verifies them before anything settles through them.',
      'The reserve protects open orders. It is locked only while you provide liquidity.',
      'The desk reviews your application. You cannot provide liquidity until it approves.',
    ][step]!,
  };
  const chosenBank = options.banks.find((b) => b.id === bankId);
  const chosenWallet = options.wallets.find((w) => w.id === walletId);
  const provideWords = provides === 'BOTH' ? 'INR and USDT' : provides;

  return (
    <>
      <main className={`${shell.main} ${shell.centred}`}>
        <form
          className={shell.surface}
          aria-label="Trader application"
          data-robot-target="panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (step < LAST) {
              if (canNext) setStep(step + 1);
            } else void submit();
          }}
        >
          <ol className={styles.steps} aria-label={`Step ${step + 1} of ${STEP_LABELS.length}`}>
            {STEP_LABELS.map((label, i) => (
              <li key={label} className={styles.stepDot} data-state={i < step ? 'done' : i === step ? 'current' : 'pending'}>
                <span className="ix-visually-hidden">{label}</span>
              </li>
            ))}
          </ol>

          {step === 0 ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>About you</h2>
              {profile.nameFixed ? (
                <dl className={shell.facts}>
                  <div>
                    <dt>Applying as</dt>
                    <dd>{profile.fullName}</dd>
                  </div>
                  <div>
                    <dt>Signed in as</dt>
                    <dd>{profile.email}</dd>
                  </div>
                </dl>
              ) : (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Full name{entityType === 'COMPANY' ? ' of the company' : ''}</span>
                  <span className={styles.inputBox}>
                    <input className={styles.input} autoComplete="name" maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} />
                  </span>
                </label>
              )}
              <fieldset className={styles.choices}>
                <legend className={styles.fieldLabel}>You are</legend>
                <div className={styles.segmented}>
                  {(
                    [
                      ['INDIVIDUAL', 'Individual'],
                      ['COMPANY', 'Company'],
                    ] as const
                  ).map(([value, name]) => (
                    <label key={value} className={styles.choice} {...(profile.typeFixed && entityType !== value ? { 'data-disabled': '' } : {})}>
                      <input type="radio" name="entity" disabled={profile.typeFixed} checked={entityType === value} onChange={() => setEntityType(value)} />
                      <span className={styles.choiceText}>
                        <span className={styles.choiceName}>{name}</span>
                      </span>
                      <span className={styles.ring} aria-hidden="true" />
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className={styles.pair}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Telegram</span>
                  <span className={styles.inputBox}>
                    <input className={styles.input} autoComplete="off" spellCheck={false} placeholder="@username" maxLength={64} value={telegram} onChange={(e) => setTelegram(e.target.value)} />
                  </span>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Phone</span>
                  <span className={styles.inputBox}>
                    <input className={styles.input} type="tel" autoComplete="tel" inputMode="tel" placeholder="+91" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </span>
                </label>
              </div>
              <p className={styles.note}>At least one, so the desk can reach you.</p>
              <fieldset className={styles.choices}>
                <legend className={styles.fieldLabel}>Do you trade P2P already?</legend>
                <div className={styles.segmented}>
                  {EXPERIENCE.map(([value, name]) => (
                    <label key={value} className={styles.choice}>
                      <input type="radio" name="experience" checked={experience === value} onChange={() => setExperience(value)} />
                      <span className={styles.choiceText}>
                        <span className={styles.choiceName}>{name}</span>
                      </span>
                      <span className={styles.ring} aria-hidden="true" />
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Merchant or profile link (optional)</span>
                <span className={styles.inputBox}>
                  <input className={styles.input} type="url" inputMode="url" autoComplete="url" spellCheck={false} maxLength={300} value={profileLink} onChange={(e) => setProfileLink(e.target.value)} />
                </span>
              </label>
            </div>
          ) : null}

          {step === 1 ? (
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

          {step === 2 ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>Your capacity</h2>
              {offersBuy ? (
                <div className={styles.pair}>
                  <Amount label="Typical order, INR" affix="₹" currency="INR" value={typicalInr} onChange={setTypicalInr} />
                  <Amount label="INR you can provide in a day" affix="₹" currency="INR" value={dailyInr} onChange={setDailyInr} />
                </div>
              ) : null}
              {offersSell ? (
                <div className={styles.pair}>
                  <Amount label="Typical order, USDT" affix="USDT" currency="USDT" value={typicalUsdt} onChange={setTypicalUsdt} />
                  <Amount label="USDT you can provide in a day" affix="USDT" currency="USDT" value={dailyUsdt} onChange={setDailyUsdt} />
                </div>
              ) : null}
              <p className={styles.note}>Daily capacity is at least your typical order. Rates are not asked for here: you set them yourself once approved.</p>
            </div>
          ) : null}

          {step === 3 ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>Settlement details</h2>
              <p className={styles.note}>Your own accounts, or your company’s. Third-party accounts are not accepted. The desk verifies each one before anything settles through it.</p>

              <h3 className={styles.subhead}>Bank account</h3>
              {options.banks.length > 0 ? (
                <fieldset className={styles.choices}>
                  <legend className="ix-visually-hidden">Bank account</legend>
                  {options.banks.map((b) => (
                    <label key={b.id} className={styles.choice}>
                      <input type="radio" name="bank" checked={bankId === b.id} onChange={() => setBankId(b.id)} />
                      <span className={styles.choiceText}>
                        <span className={styles.choiceName}>{b.label}</span>
                        <span className={styles.choiceMeta}>{b.holder} · verified</span>
                      </span>
                      <span className={styles.ring} aria-hidden="true" />
                    </label>
                  ))}
                  <label className={styles.choice}>
                    <input type="radio" name="bank" checked={newBank} onChange={() => setBankId('NEW')} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceName}>Another bank account</span>
                    </span>
                    <span className={styles.ring} aria-hidden="true" />
                  </label>
                </fieldset>
              ) : null}
              {newBank ? <BankFields value={bank} onChange={setBank} /> : null}

              <h3 className={styles.subhead}>TRC20 wallet</h3>
              {usableWallets.length > 0 ? (
                <fieldset className={styles.choices}>
                  <legend className="ix-visually-hidden">TRC20 wallet</legend>
                  {usableWallets.map((w) => (
                    <label key={w.id} className={styles.choice}>
                      <input type="radio" name="wallet" checked={walletId === w.id} onChange={() => setWalletId(w.id)} />
                      <span className={styles.choiceText}>
                        <span className={styles.choiceName} title={w.address}>
                          TRC20 · {shortenAddress(w.address)}
                        </span>
                        <span className={styles.choiceMeta}>{w.label} · verified</span>
                      </span>
                      <span className={styles.ring} aria-hidden="true" />
                    </label>
                  ))}
                  <label className={styles.choice}>
                    <input type="radio" name="wallet" checked={newWallet} onChange={() => setWalletId('NEW')} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceName}>Another wallet</span>
                    </span>
                    <span className={styles.ring} aria-hidden="true" />
                  </label>
                </fieldset>
              ) : null}
              {newWallet ? <WalletFields value={wallet} onChange={setWallet} /> : null}

              <label className={styles.check}>
                <input type="checkbox" checked={owned} onChange={(e) => setOwned(e.target.checked)} />
                {OWNERSHIP_TEXT}
              </label>
            </div>
          ) : null}

          {step === 4 ? (
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

          {step === LAST ? (
            <div className={styles.choices}>
              <h2 className={styles.question}>Submit for review</h2>
              <dl className={shell.facts}>
                <div>
                  <dt>Name</dt>
                  <dd>
                    {profile.nameFixed ? profile.fullName : fullName.trim()} · {entityType === 'COMPANY' ? 'Company' : 'Individual'}
                  </dd>
                </div>
                <div>
                  <dt>Contact</dt>
                  <dd>{[tg ? (tg.startsWith('@') ? tg : `@${tg}`) : null, ph || null].filter(Boolean).join(' · ')}</dd>
                </div>
                <div>
                  <dt>P2P experience</dt>
                  <dd>{experience ? EXPERIENCE_WORDS[experience] : '—'}</dd>
                </div>
                <div>
                  <dt>You provide</dt>
                  <dd>{provideWords}</dd>
                </div>
                {offersBuy ? (
                  <div>
                    <dt>INR · typical / daily</dt>
                    <dd className="ix-num">
                      {inr(typicalInr || '0')} / {inr(dailyInr || '0')}
                    </dd>
                  </div>
                ) : null}
                {offersSell ? (
                  <div>
                    <dt>USDT · typical / daily</dt>
                    <dd className="ix-num">
                      {usdt(typicalUsdt || '0')} / {usdt(dailyUsdt || '0')}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Bank account</dt>
                  <dd>{newBank ? `${bank.bankName.trim()} ••••${bank.accountNumber.replace(/\s+/g, '').slice(-4)} · pending review` : `${chosenBank?.label ?? '—'} · verified`}</dd>
                </div>
                <div>
                  <dt>TRC20 wallet</dt>
                  <dd>{newWallet ? `TRC20 · ${shortenAddress(wallet.address.trim())} · pending review` : `TRC20 · ${chosenWallet ? shortenAddress(chosenWallet.address) : '—'} · verified`}</dd>
                </div>
                <div>
                  <dt>Security Reserve</dt>
                  <dd>{options.reserveRequired ? usdt(options.reserveRequired) : 'Set by the desk'}</dd>
                </div>
              </dl>
              <p className={shell.info}>
                <InfoIcon className={shell.infoIcon} />
                <span>Your status becomes “Under review”. You cannot provide liquidity until the desk verifies your details and approves.</span>
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
              {step < LAST ? 'Continue' : 'Submit for review'}
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

function Amount({ label, affix, currency, value, onChange }: { label: string; affix: string; currency: 'INR' | 'USDT'; value: string; onChange: (v: string) => void }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.inputBox}>
        <span className={styles.inputAffix}>{affix}</span>
        <input
          className={styles.input}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            const v = sanitizeAmountInput(e.target.value, currency);
            if (v !== null) onChange(v);
          }}
        />
      </span>
    </label>
  );
}
