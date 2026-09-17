import { cx } from '../../cx.ts';
import styles from './StatusGlyph.module.css';

export type GlyphState = 'pending' | 'partial' | 'done' | 'closed';

/**
 * ○ ◔ ● × status glyph drawn as SVG in `currentColor`. Not a text character: `◔` (U+25D4) is not in
 * Geist, and a font fallback would render differently per machine. Decorative — callers provide text.
 */
export function StatusGlyph({ state, className }: { state: GlyphState; className?: string }) {
  return (
    <svg className={cx(styles.root, className)} viewBox="0 0 12 12" aria-hidden="true" focusable="false" data-glyph={state}>
      {state === 'closed' ? (
        <path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" className={styles.ring} />
      ) : state === 'done' ? (
        <circle cx="6" cy="6" r="5" className={styles.fill} />
      ) : (
        <>
          <circle cx="6" cy="6" r="4.4" className={styles.ring} />
          {state === 'partial' ? <path d="M6 6V1.6A4.4 4.4 0 0 1 10.4 6Z" className={styles.fill} /> : null}
        </>
      )}
    </svg>
  );
}
