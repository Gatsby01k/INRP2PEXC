import { cx } from '../../cx.ts';
import styles from './QuoteStatus.module.css';

export type QuoteStatusValue = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

const LABEL: Record<QuoteStatusValue, { text: string; glyph: string; tone: 'neutral' | 'brand' | 'success' | 'muted' | 'danger' }> = {
  DRAFT: { text: 'Draft', glyph: '○', tone: 'neutral' },
  SENT: { text: 'Sent · awaiting client', glyph: '◔', tone: 'brand' },
  ACCEPTED: { text: 'Accepted', glyph: '●', tone: 'success' },
  REJECTED: { text: 'Rejected by client', glyph: '×', tone: 'muted' },
  EXPIRED: { text: 'Expired', glyph: '○', tone: 'muted' },
  CANCELLED: { text: 'Cancelled', glyph: '×', tone: 'muted' },
};

/** Status is text plus glyph, never colour alone. */
export function QuoteStatus({ status }: { status: QuoteStatusValue }) {
  const l = LABEL[status];
  return (
    <span className={cx(styles.root, styles[l.tone])} data-status={status}>
      <span aria-hidden="true" className={styles.glyph}>
        {l.glyph}
      </span>
      {l.text}
    </span>
  );
}
