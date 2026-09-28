'use client';

import styles from '../traders.module.css';

export type Rail = 'IMPS' | 'NEFT' | 'RTGS';
export const RAILS: readonly Rail[] = ['IMPS', 'NEFT', 'RTGS'];

export interface BankDraft {
  readonly holderName: string;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
  readonly rails: readonly Rail[];
}

export interface WalletDraft {
  readonly address: string;
  readonly label: string;
}

export const EMPTY_BANK: BankDraft = { holderName: '', bankName: '', accountNumber: '', ifsc: '', rails: RAILS };
export const EMPTY_WALLET: WalletDraft = { address: '', label: '' };

/** Shape checks only, so the form can say what is missing; the server validates everything again. */
export const bankComplete = (b: BankDraft) =>
  b.holderName.trim() !== '' && b.bankName.trim() !== '' && /^[0-9]{9,18}$/.test(b.accountNumber.replace(/\s+/g, '')) && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc.trim().toUpperCase()) && b.rails.length > 0;
export const walletComplete = (w: WalletDraft) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(w.address.trim());

export const bankPayload = (b: BankDraft) => ({ holderName: b.holderName.trim(), bankName: b.bankName.trim(), accountNumber: b.accountNumber.replace(/\s+/g, ''), ifsc: b.ifsc.trim().toUpperCase(), rails: [...b.rails] });
export const walletPayload = (w: WalletDraft) => ({ address: w.address.trim(), label: w.label.trim() === '' ? null : w.label.trim() });

function Text({ label, value, onChange, hint, ...input }: { label: string; value: string; onChange: (v: string) => void; hint?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.inputBox}>
        <input className={styles.input} autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} {...input} />
      </span>
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  );
}

/** A bank account in the trader's own name or its company's: exactly what the desk needs to verify it, and no more. */
export function BankFields({ value, onChange }: { value: BankDraft; onChange: (next: BankDraft) => void }) {
  const set = (patch: Partial<BankDraft>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.choices}>
      <Text label="Account holder" value={value.holderName} onChange={(v) => set({ holderName: v })} autoComplete="name" maxLength={140} />
      <Text label="Bank name" value={value.bankName} onChange={(v) => set({ bankName: v })} maxLength={140} />
      <div className={styles.pair}>
        <Text label="Account number" value={value.accountNumber} onChange={(v) => set({ accountNumber: v.replace(/[^0-9 ]/g, '') })} inputMode="numeric" maxLength={24} />
        <Text label="IFSC" value={value.ifsc} onChange={(v) => set({ ifsc: v.toUpperCase().replace(/[^A-Z0-9]/g, '') })} maxLength={11} autoCapitalize="characters" hint="Like HDFC0001234" />
      </div>
      <fieldset className={styles.railSet}>
        <legend className={styles.fieldLabel}>Transfers this account takes</legend>
        <div className={styles.rails}>
          {RAILS.map((r) => (
            <label key={r} className={styles.check}>
              <input
                type="checkbox"
                checked={value.rails.includes(r)}
                onChange={(e) => set({ rails: e.target.checked ? RAILS.filter((x) => x === r || value.rails.includes(x)) : value.rails.filter((x) => x !== r) })}
              />
              {r}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** A TRC20 wallet the trader controls: USDT leaves from it and comes back to it. */
export function WalletFields({ value, onChange }: { value: WalletDraft; onChange: (next: WalletDraft) => void }) {
  const set = (patch: Partial<WalletDraft>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.choices}>
      <Text label="TRC20 wallet address" value={value.address} onChange={(v) => set({ address: v.trim() })} maxLength={34} hint="Starts with T. It sends and receives your USDT." />
      <Text label="Wallet label (optional)" value={value.label} onChange={(v) => set({ label: v })} maxLength={80} placeholder="Trader wallet" />
    </div>
  );
}

export const OWNERSHIP_TEXT = 'I confirm this bank account and wallet belong to me or my company.';
