import { cx } from '../../cx.ts';
import { maskAccount } from '../../format/mask.ts';
import styles from './BankAccountRow.module.css';

export interface BankAccountRowProps {
  bankName: string;
  holderName: string;
  last4: string;
  rail?: string;
  status: 'ACTIVE' | 'ARCHIVED';
  isDefault?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}

export function BankAccountRow({ bankName, holderName, last4, rail, status, isDefault, selected, onSelect }: BankAccountRowProps) {
  const body = (
    <>
      <span className={styles.primary}>
        {bankName} <span className="ix-num">{maskAccount(last4)}</span>
      </span>
      <span className={styles.secondary}>
        {holderName}
        {rail ? ` · ${rail}` : ''}
      </span>
      <span className={styles.tags}>
        {isDefault ? <span className={styles.tag}>Default</span> : null}
        {status === 'ARCHIVED' ? <span className={styles.archived}>Archived</span> : null}
      </span>
    </>
  );
  return onSelect ? (
    <button type="button" role="radio" aria-checked={Boolean(selected)} className={cx(styles.row, styles.selectable, selected && styles.selected)} onClick={onSelect} disabled={status === 'ARCHIVED'}>
      {body}
    </button>
  ) : (
    <div className={cx(styles.row, status === 'ARCHIVED' && styles.isArchived)}>{body}</div>
  );
}
