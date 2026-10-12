'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArcLoader, OtpInput } from '@inrp2p/ui';
import { newIntentKey } from '../../../components/useCommand.tsx';
import { addBankAccountAction, addWalletAction } from '../../../server/actions/client.ts';
import { Field, Segmented } from '../_workspace/Field.tsx';
import { ArrowIcon, BackIcon, LockIcon, PasteIcon } from '../_workspace/icons.tsx';
import { SecureAccount } from '../_workspace/SecureAccount.tsx';
import { Sheet } from '../_workspace/Sheet.tsx';
import { SuccessMark } from '../_workspace/SuccessMark.tsx';
import { ACCOUNT_PATTERN, IFSC_PATTERN, TRON_SHAPE, bankForIfsc, groupAddress, isTronAddress, monogram, normalizeAccount, normalizeIfsc } from './checks.ts';
import shell from '../shell.module.css';
import styles from './add.module.css';

export type DestinationKind = 'bank' | 'wallet';
type Stage = 'secure' | 'details' | 'review' | 'confirm' | 'done';
type Purpose = 'DESTINATION' | 'SOURCE' | 'BOTH';

type Failure = { readonly ok: false; readonly code: string; readonly message: string; readonly stepUp?: true; readonly details?: Record<string, unknown> };
type Outcome = { readonly ok: true; readonly result: unknown } | Failure;

const PURPOSES: readonly { value: Purpose; label: string; detail: string }[] = [
  { value: 'DESTINATION', label: 'Receive', detail: 'USDT you buy' },
  { value: 'SOURCE', label: 'Send', detail: 'USDT you sell' },
  { value: 'BOTH', label: 'Both', detail: 'In and out' },
];

const PURPOSE_WORDS: Record<Purpose, string> = { DESTINATION: 'Receives the USDT you buy', SOURCE: 'Sends the USDT you sell', BOTH: 'Sends and receives USDT' };

/**
 * Adding where the client is paid — a bank account for the INR of what they sell, or a TRC20 wallet for the USDT they
 * buy — as one guided task in a sheet, from wherever they were:
 *
 * 1. if they have no authenticator yet, they set one up first (it confirms this change and every one after it);
 * 2. the details, checked field by field as they are typed — an IFSC names its bank, an account number is typed
 *    twice, a wallet address has its checksum checked before anything is sent;
 * 3. a review of exactly what will be saved, drawn the way it will appear;
 * 4. the change itself, with the authenticator code asked for here, in the sheet, if the session's step-up has
 *    lapsed — and the same intent key, so a retry can never add the account twice;
 * 5. done: what is ready now, and the obvious next step.
 *
 * The server checks everything again and decides (`client_bank.add`, `client_wallet.add`, CLIENT_ADMIN + TOTP).
 */
export function AddDestination({
  open,
  kind,
  onClose,
  hasAuthenticator,
  email,
  holderName,
  onAdded,
  next,
}: {
  open: boolean;
  kind: DestinationKind;
  onClose: () => void;
  hasAuthenticator: boolean;
  email: string;
  holderName: string;
  onAdded?: (kind: DestinationKind) => void;
  /** Where "done" leads: back to the page (the default), or on to the Exchange. */
  next?: 'stay' | 'exchange';
}) {
  const [session, setSession] = useState(0);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (open) setSession((s) => s + 1);
  }, [open]);
  const bank = kind === 'bank';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={locked}
      eyebrow="Bank & wallets"
      title={bank ? 'Add a bank account' : 'Add a USDT wallet'}
      description={bank ? 'Where the INR from the USDT you sell is paid.' : 'A TRC20 wallet for the USDT you buy — or the one you send from.'}
    >
      <Flow
        key={session}
        kind={kind}
        hasAuthenticator={hasAuthenticator}
        email={email}
        holderName={holderName}
        onClose={onClose}
        onLocked={setLocked}
        next={next ?? 'stay'}
        {...(onAdded ? { onAdded } : {})}
      />
    </Sheet>
  );
}

function Flow({
  kind,
  hasAuthenticator,
  email,
  holderName,
  onClose,
  onLocked,
  onAdded,
  next,
}: {
  kind: DestinationKind;
  hasAuthenticator: boolean;
  email: string;
  holderName: string;
  onClose: () => void;
  onLocked: (locked: boolean) => void;
  onAdded?: (kind: DestinationKind) => void;
  next: 'stay' | 'exchange';
}) {
  const router = useRouter();
  const bank = kind === 'bank';
  const [stage, setStage] = useState<Stage>(hasAuthenticator ? 'details' : 'secure');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const intent = useRef<string | null>(null);

  // ——— Bank details ———
  const [holder, setHolder] = useState(holderName);
  const [ifsc, setIfsc] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankNameTouched, setBankNameTouched] = useState(false);
  const [account, setAccount] = useState('');
  const [confirmAccount, setConfirmAccount] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverField, setServerField] = useState<{ field: string; message: string } | null>(null);

  // ——— Wallet details ———
  const [address, setAddress] = useState('');
  const [addressOk, setAddressOk] = useState<boolean | null>(null);
  const [label, setLabel] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('DESTINATION');

  useEffect(() => onLocked(busy), [busy, onLocked]);

  // An IFSC names its bank; the name is filled in for the client until they change it themselves.
  const detected = IFSC_PATTERN.test(ifsc) ? bankForIfsc(ifsc) : null;
  useEffect(() => {
    if (!bankNameTouched) setBankName(detected ?? '');
  }, [detected, bankNameTouched]);

  // A wallet address is checked as it is typed: its shape at once, its checksum as soon as it has one.
  useEffect(() => {
    let live = true;
    if (!TRON_SHAPE.test(address)) {
      setAddressOk(address.length >= 34 ? false : null);
      return;
    }
    void isTronAddress(address).then((ok) => {
      if (live) setAddressOk(ok);
    });
    return () => {
      live = false;
    };
  }, [address]);

  const fieldError = (name: string): string | null => {
    if (serverField?.field === name) return serverField.message;
    if (!touched[name]) return null;
    switch (name) {
      case 'holder':
        return holder.trim() === '' ? 'Enter the name on the account.' : null;
      case 'ifsc':
        return ifsc === '' ? 'Enter the branch IFSC.' : IFSC_PATTERN.test(ifsc) ? null : 'An IFSC is 11 characters: four letters, a zero, then six letters or digits.';
      case 'bankName':
        return bankName.trim() === '' ? 'Enter the bank’s name.' : null;
      case 'account':
        return account === '' ? 'Enter the account number.' : ACCOUNT_PATTERN.test(account) ? null : 'An account number has 9 to 18 digits.';
      case 'confirm':
        return confirmAccount === '' ? 'Type the account number again.' : confirmAccount === account ? null : 'The two numbers do not match.';
      case 'address':
        return address === '' ? 'Paste the wallet address.' : addressOk === false ? 'That is not a valid TRC20 address — check every character.' : null;
      case 'label':
        return label.trim() === '' ? 'Give the wallet a name you will recognise.' : null;
      default:
        return null;
    }
  };

  const bankValid =
    holder.trim() !== '' && IFSC_PATTERN.test(ifsc) && bankName.trim() !== '' && ACCOUNT_PATTERN.test(account) && confirmAccount === account;
  const walletValid = addressOk === true && label.trim() !== '';

  const toReview = () => {
    setTouched(bank ? { holder: true, ifsc: true, bankName: true, account: true, confirm: true } : { address: true, label: true });
    setServerField(null);
    if (bank ? bankValid : walletValid) {
      intent.current = null;
      setError(null);
      setStage('review');
    }
  };

  const send = (key: string): Promise<Outcome> =>
    bank
      ? addBankAccountAction({ holderName: holder.trim(), bankName: bankName.trim(), ifsc, accountNumber: account }, key)
      : addWalletAction({ address, purpose, label: label.trim() }, key);

  const settle = (out: Outcome) => {
    if (out.ok) {
      setStage('done');
      router.refresh();
      onAdded?.(kind);
      return;
    }
    if (out.stepUp) {
      setCode('');
      setStage('confirm');
      return;
    }
    if (out.code === 'MFA_ENROLLMENT_REQUIRED') {
      setStage('secure');
      return;
    }
    if (out.code === 'DUPLICATE_DESTINATION') {
      setError(bank ? 'This account is already on file — it is in your list.' : 'This wallet is already on file — it is in your list.');
      setStage('review');
      return;
    }
    const field = typeof out.details?.field === 'string' ? out.details.field : null;
    if (out.code === 'INVALID_ADDRESS' || field) {
      const name = out.code === 'INVALID_ADDRESS' ? 'address' : field === 'accountNumber' ? 'account' : field === 'ifsc' ? 'ifsc' : (field ?? '');
      setServerField({ field: name, message: out.code === 'INVALID_ADDRESS' ? 'That is not a valid TRC20 address.' : out.message });
      setStage('details');
      return;
    }
    setError(out.message || 'That could not be saved. Try again.');
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    intent.current ??= newIntentKey();
    try {
      settle(await send(intent.current));
    } catch {
      setError('The connection dropped before the desk answered. Try again — it will not be added twice.');
    } finally {
      setBusy(false);
    }
  };

  const confirmWithCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => null);
      if (!res?.ok) {
        setError('That code was not accepted. Enter the one your app shows now.');
        return;
      }
      settle(await send(intent.current ?? newIntentKey()));
    } finally {
      setBusy(false);
    }
  };

  const steps = hasAuthenticator ? ['Details', 'Review'] : ['Security', 'Details', 'Review'];
  const at = stage === 'secure' ? 0 : stage === 'details' ? steps.length - 2 : steps.length - 1;

  if (stage === 'done') {
    return (
      <div className={styles.done}>
        <SuccessMark />
        <h3 className={styles.doneTitle}>{bank ? `${bankName} •••• ${account.slice(-4)} is on your account` : `${label.trim()} is on your account`}</h3>
        <p className={styles.doneText}>
          {bank ? 'You can sell USDT now: the INR from each trade is paid to this account.' : purpose === 'SOURCE' ? 'USDT you send from this wallet is recognised as yours.' : 'You can buy USDT now: it is delivered to this wallet.'}
        </p>
        <div className={styles.doneActions}>
          {next === 'exchange' ? (
            <button type="button" className={`${shell.action} ${shell.wide}`} onClick={onClose} data-autofocus="">
              Back to your request
              <ArrowIcon className={shell.actionIcon} />
            </button>
          ) : purpose === 'SOURCE' && !bank ? (
            <button type="button" className={`${shell.action} ${shell.wide}`} data-tone="ink" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <Link className={`${shell.action} ${shell.wide}`} href="/exchange" onClick={onClose}>
                {bank ? 'Sell USDT now' : 'Buy USDT now'}
                <ArrowIcon className={shell.actionIcon} />
              </Link>
              <button type="button" className={styles.back} onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.flow}>
      <ol className={styles.progress} aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s} data-state={i < at ? 'done' : i === at ? 'current' : 'next'} {...(i === at ? { 'aria-current': 'step' as const } : {})}>
            <span>{s}</span>
          </li>
        ))}
      </ol>

      {stage === 'secure' ? (
        <SecureAccount
          email={email}
          embedded
          onDone={() => {
            router.refresh();
            setStage('details');
          }}
        />
      ) : null}

      {stage === 'details' && bank ? (
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            toReview();
          }}
        >
          <Field
            label="Account holder"
            value={holder}
            autoComplete="name"
            maxLength={140}
            hint="Exactly as the bank has it."
            error={fieldError('holder')}
            onChange={(e) => setHolder(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, holder: true }))}
          />
          <Field
            label="IFSC"
            value={ifsc}
            mono
            data-autofocus=""
            autoComplete="off"
            spellCheck={false}
            placeholder="HDFC0001234"
            maxLength={11}
            valid={IFSC_PATTERN.test(ifsc)}
            hint={detected ? `${detected} — branch ${ifsc.slice(5)}` : 'On a cheque leaf or in your bank app, 11 characters.'}
            error={fieldError('ifsc')}
            onChange={(e) => {
              setIfsc(normalizeIfsc(e.target.value));
              if (serverField?.field === 'ifsc') setServerField(null);
            }}
            onBlur={() => setTouched((t) => ({ ...t, ifsc: true }))}
          />
          <Field
            label="Bank"
            value={bankName}
            autoComplete="off"
            maxLength={140}
            placeholder={IFSC_PATTERN.test(ifsc) ? 'Type the bank’s name' : 'Filled in from the IFSC'}
            {...(detected && !bankNameTouched ? { hint: 'Filled in from the IFSC — change it if it is wrong.' } : {})}
            error={fieldError('bankName')}
            onChange={(e) => {
              setBankNameTouched(true);
              setBankName(e.target.value);
            }}
            onBlur={() => setTouched((t) => ({ ...t, bankName: true }))}
          />
          <div className={styles.pair}>
            <Field
              label="Account number"
              value={account}
              mono
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              valid={ACCOUNT_PATTERN.test(account)}
              error={fieldError('account')}
              onChange={(e) => {
                setAccount(normalizeAccount(e.target.value));
                if (serverField?.field === 'account') setServerField(null);
              }}
              onBlur={() => setTouched((t) => ({ ...t, account: true }))}
            />
            <Field
              label="Account number again"
              value={confirmAccount}
              mono
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              valid={confirmAccount !== '' && confirmAccount === account && ACCOUNT_PATTERN.test(account)}
              error={fieldError('confirm')}
              onChange={(e) => setConfirmAccount(normalizeAccount(e.target.value))}
              onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
            />
          </div>
          <p className={styles.privacy}>
            <LockIcon className={styles.privacyIcon} />
            The number is encrypted as soon as it is saved. From then on you, and the desk, see only its last four digits.
          </p>
          <button type="submit" className={`${shell.action} ${shell.wide}`} data-tone="ink">
            Review
            <ArrowIcon className={shell.actionIcon} />
          </button>
        </form>
      ) : null}

      {stage === 'details' && !bank ? (
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            toReview();
          }}
        >
          <Field
            label="Wallet address"
            value={address}
            mono
            data-autofocus=""
            autoComplete="off"
            spellCheck={false}
            placeholder="T…"
            maxLength={34}
            valid={addressOk === true}
            hint={addressOk === true ? 'A valid TRC20 address.' : 'USDT on TRON (TRC20) only. Paste it rather than typing it.'}
            error={fieldError('address')}
            onChange={(e) => {
              setAddress(e.target.value.replace(/\s+/g, ''));
              if (serverField?.field === 'address') setServerField(null);
            }}
            onBlur={() => setTouched((t) => ({ ...t, address: true }))}
            action={
              <button
                type="button"
                className={styles.paste}
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    setAddress(text.trim().replace(/\s+/g, '').slice(0, 34));
                    setTouched((t) => ({ ...t, address: true }));
                  } catch {
                    // The browser kept the clipboard to itself; the field still takes a paste.
                  }
                }}
              >
                <PasteIcon />
                Paste
              </button>
            }
          />
          {addressOk === true ? (
            <div className={styles.addressCheck} aria-label="The address in groups of four, to check against your wallet">
              {groupAddress(address).map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </div>
          ) : null}
          <Field
            label="Name"
            value={label}
            autoComplete="off"
            maxLength={80}
            placeholder="Treasury wallet"
            hint="So you and the desk recognise it."
            error={fieldError('label')}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, label: true }))}
          />
          <Segmented legend="Used to" value={purpose} options={PURPOSES} onChange={setPurpose} />
          <button type="submit" className={`${shell.action} ${shell.wide}`} data-tone="ink">
            Review
            <ArrowIcon className={shell.actionIcon} />
          </button>
        </form>
      ) : null}

      {stage === 'review' || stage === 'confirm' ? (
        <div className={styles.form}>
          <div className={styles.preview} aria-label="What will be saved">
            <span className={styles.monogram} data-kind={kind} aria-hidden="true">
              {bank ? monogram(bankName) : 'T'}
            </span>
            <span className={styles.previewText}>
              {bank ? (
                <>
                  <span className={styles.previewName}>
                    {bankName} <span className="ix-num">•••• {account.slice(-4)}</span>
                  </span>
                  <span className={styles.previewMeta}>
                    {holder.trim()} · {ifsc}
                  </span>
                  <span className={styles.previewMeta}>Paid by IMPS, NEFT or RTGS</span>
                </>
              ) : (
                <>
                  <span className={styles.previewName}>{label.trim()}</span>
                  <span className={`${styles.previewAddress} ix-num`}>{address}</span>
                  <span className={styles.previewMeta}>USDT on TRC20 · {PURPOSE_WORDS[purpose]}</span>
                </>
              )}
            </span>
          </div>

          {stage === 'review' ? (
            <>
              <ul className={styles.facts}>
                <li>{bank ? 'INR from your trades is paid only to accounts on this list.' : 'USDT is delivered only to wallets on this list.'}</li>
                <li>Every administrator on your account is told it was added.</li>
                {!bank ? <li>Check the address against your wallet before you add it — a transfer to a wrong address cannot be reversed.</li> : null}
              </ul>
              {error ? (
                <p className={shell.error} role="alert">
                  {error}
                </p>
              ) : null}
              <button type="button" className={`${shell.action} ${shell.wide}`} onClick={() => void submit()} disabled={busy} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Adding" tone="inherit" /> : <LockIcon className={shell.actionIcon} />}
                {bank ? 'Add bank account' : 'Add wallet'}
              </button>
              <button type="button" className={styles.back} onClick={() => setStage('details')} disabled={busy}>
                <BackIcon />
                Change details
              </button>
            </>
          ) : (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length === 6) void confirmWithCode();
              }}
            >
              <div className={styles.confirmHead}>
                <span className={styles.confirmBadge} aria-hidden="true">
                  <LockIcon />
                </span>
                <div>
                  <h3 className={styles.confirmTitle}>Confirm with your authenticator</h3>
                  <p className={styles.confirmText}>Enter the six-digit code your app shows now.</p>
                </div>
              </div>
              <OtpInput label="Authenticator code" value={code} onChange={setCode} invalid={Boolean(error)} autoFocus />
              {error ? (
                <p className={shell.error} role="alert">
                  {error}
                </p>
              ) : null}
              <button type="submit" className={`${shell.action} ${shell.wide}`} disabled={busy || code.length !== 6} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Confirming" tone="inherit" /> : null}
                {bank ? 'Confirm and add account' : 'Confirm and add wallet'}
              </button>
              <button type="button" className={styles.back} onClick={() => setStage('review')} disabled={busy}>
                <BackIcon />
                Back
              </button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
