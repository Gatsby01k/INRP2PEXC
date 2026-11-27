/**
 * ADR 0033: how far apart two clients are — a rail of prices, lower on the left, with each side's price on its pin and
 * the gap between them drawn as two dashed runs closing on the middle, where the gap is said as a share of the client's
 * own price (the headline says it in rupees). Reaching for "Meet" closes it: a solid line runs from the client's pin to
 * the other's and the client's pin fills — the yes, drawn before it is said. The motion stops for reduced motion.
 */
import stage from './stage.module.css';

/** Display only: the gap as a share of the client's own price, "2.3%"; nothing when the own side has no figure. */
function share(own: string, theirs: string): string | null {
  const o = Number(own.replace(/[^\d.]/g, ''));
  const t = Number(theirs.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(o) || !Number.isFinite(t) || o <= 0 || t <= 0) return null;
  const pct = (Math.abs(t - o) / o) * 100;
  return pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

export function GapRail({ own, theirs, ownLabel = 'You', theirLabel, gap }: { own: string; theirs: string; ownLabel?: string; theirLabel: string; gap: string }) {
  const ownLower = Number(own.replace(/[^\d.]/g, '')) <= Number(theirs.replace(/[^\d.]/g, ''));
  const left = ownLower ? { price: own, label: ownLabel, you: true } : { price: theirs, label: theirLabel, you: false };
  const right = ownLower ? { price: theirs, label: theirLabel, you: false } : { price: own, label: ownLabel, you: true };
  return (
    <div className={stage.gap} role="img" aria-label={`${ownLabel} ${own}, ${theirLabel} ${theirs}: ${gap} apart`}>
      <div className={stage.gapEnds} aria-hidden="true">
        <span className={stage.gapEnd} data-you={left.you || undefined}>
          <b>{left.price}</b>
          <small>{left.label}</small>
        </span>
        <span className={stage.gapEnd} data-you={right.you || undefined} data-right="">
          <b>{right.price}</b>
          <small>{right.label}</small>
        </span>
      </div>
      <div className={stage.gapRail} aria-hidden="true">
        <i className={stage.gapPin} data-you={left.you || undefined} />
        <span className={stage.gapRun} />
        <em className={stage.gapSize}>{share(own, theirs) ?? gap}</em>
        <span className={stage.gapRun} data-flip="" />
        <i className={stage.gapPin} data-you={right.you || undefined} />
        <span className={stage.gapFill} data-from={ownLower ? 'left' : 'right'} />
      </div>
    </div>
  );
}
