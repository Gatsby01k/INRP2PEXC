'use client';

import { cx } from '../../cx.ts';
import { StatusGlyph, type GlyphState } from '../StatusGlyph/StatusGlyph.tsx';
import styles from './QuoteStatus.module.css';

export type QuoteStatusValue = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

const LABEL: Record<QuoteStatusValue, { text: string; glyph: GlyphState; tone: 'neutral' | 'brand' | 'success' | 'muted' | 'danger' }> = {
  DRAFT: { text: 'Draft', glyph: 'pending', tone: 'neutral' },
  SENT: { text: 'Sent · awaiting client', glyph: 'partial', tone: 'brand' },
  ACCEPTED: { text: 'Accepted', glyph: 'done', tone: 'success' },
  REJECTED: { text: 'Rejected by client', glyph: 'closed', tone: 'muted' },
  EXPIRED: { text: 'Expired', glyph: 'pending', tone: 'muted' },
  CANCELLED: { text: 'Cancelled', glyph: 'closed', tone: 'muted' },
};

/** Status is text plus glyph, never colour alone. */
export function QuoteStatus({ status }: { status: QuoteStatusValue }) {
  const l = LABEL[status];
  return (
    <span className={cx(styles.root, styles[l.tone])} data-status={status}>
      <span aria-hidden="true" className={styles.glyph}>
        <StatusGlyph state={l.glyph} />
      </span>
      {l.text}
    </span>
  );
}
