import type { Direction } from '@inrp2p/kernel';
import { TRUST, type RecordBlock, type RecordLine, type TrustControl } from '../../../../content/site.ts';
import { CheckIcon } from '../icons.tsx';
import { MASKS } from '../masks.ts';
import styles from './trust.module.css';

/**
 * A trade's record, as a specimen: the lines a completed trade holds, with every figure masked.
 *
 * Drawn whole beside the controls on a wide screen, where the control being read lights the lines it put there,
 * and in excerpts under each control on a phone (`only`), where each control carries its own lines. Its words
 * are the product's own (content/site.ts); nothing in it is a figure.
 */

const regionsOf = (regions: readonly TrustControl[]): string => regions.join(' ');

function Line({ line }: { line: RecordLine }) {
  const { label, value, state, regions } = line;
  return (
    <div className={styles.line} data-regions={regionsOf(regions)}>
      <dt className={styles.lineLabel}>{label}</dt>
      <dd className={styles.lineValue}>
        {typeof value === 'string' ? (
          <span>{value}</span>
        ) : (
          <span>
            <span className={styles.mask}>{MASKS[value.mask]}</span>
            {value.unit ? <span className={styles.unit}> {value.unit}</span> : null}
          </span>
        )}
        {state ? (
          <span className={styles.state}>
            <CheckIcon />
            {state}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function Blocks({ blocks, only }: { blocks: readonly RecordBlock[]; only?: TrustControl | undefined }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === 'gate') {
          if (only && !block.regions.includes(only)) return null;
          return (
            <p key={`gate-${i}`} className={styles.gate} data-regions={regionsOf(block.regions)}>
              <span>{block.text}</span>
            </p>
          );
        }
        const lines = only ? block.lines.filter((l) => l.regions.includes(only)) : block.lines;
        if (lines.length === 0) return null;
        return (
          <section key={block.heading} className={styles.block}>
            <h4 className={styles.blockHeading}>{block.heading}</h4>
            <dl className={styles.lines}>
              {lines.map((line, j) => (
                <Line key={`${line.label}-${j}`} line={line} />
              ))}
            </dl>
          </section>
        );
      })}
    </>
  );
}

export function Record({ only }: { only?: TrustControl }) {
  const { title, status, summary, blocks, footer } = TRUST.record;
  const footerLines = only ? footer.filter((l) => l.regions.includes(only)) : footer;
  return (
    <div className={only ? `${styles.sheet} ${styles.excerpt}` : styles.sheet}>
      {only ? null : (
        <header className={styles.sheetHead}>
          <div>
            <p className={styles.sheetTitle}>{title}</p>
            {(['BUY_USDT', 'SELL_USDT'] as const satisfies readonly Direction[]).map((d) => (
              <p key={d} className={styles.sheetSummary} data-dir={d}>
                {summary[d]}
              </p>
            ))}
          </div>
          <span className={styles.sheetStatus}>
            <span className={styles.sheetStatusDot} />
            {status}
          </span>
        </header>
      )}
      {(['BUY_USDT', 'SELL_USDT'] as const).map((d) => (
        <div key={d} className={styles.body} data-dir={d}>
          <Blocks blocks={blocks[d]} only={only} />
        </div>
      ))}
      {footerLines.length ? (
        <dl className={styles.footer}>
          {footerLines.map((line) => (
            <Line key={line.label} line={line} />
          ))}
        </dl>
      ) : null}
    </div>
  );
}
