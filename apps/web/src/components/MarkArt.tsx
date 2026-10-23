import styles from './mark-art.module.css';

/**
 * The INRP2P mark's own geometry, drawn rather than pasted: the rupee hub, the three spokes to the three parties
 * of a deal, and the broken ring of three arcs around them. Drawn in `currentColor` on a 512 grid, so it sits as a
 * white watermark on an orange field or as an orange figure on paper.
 *
 * `stages` lights the arcs in order — left, right, bottom; the mark's three arcs are the three moments of a trade
 * (priced, funded, settled), so a trade's progress is the mark completing itself. `live` lets the ring breathe.
 */
const CX = 256;
const CY = 250;
const R = 150;

const point = (deg: number, r = R) => {
  const a = (deg * Math.PI) / 180;
  return `${(CX + r * Math.cos(a)).toFixed(1)} ${(CY + r * Math.sin(a)).toFixed(1)}`;
};
const arc = (from: number, to: number) => `M ${point(from)} A ${R} ${R} 0 0 1 ${point(to)}`;

/** Left (priced), right (funded), bottom (settled): the order a trade completes them in. */
const ARCS = [arc(170, 242), arc(298, 370), arc(56, 124)];
const NODES = [
  { x: 256, y: 128 },
  { x: 150, y: 312 },
  { x: 362, y: 312 },
];

export function MarkArt({ className, stages = 3, live = false, hub = true }: { className?: string | undefined; stages?: 0 | 1 | 2 | 3; live?: boolean; hub?: boolean }) {
  return (
    <svg className={`${styles.art} ${className ?? ''}`} viewBox="0 0 512 512" fill="none" aria-hidden="true" focusable="false" data-live={live || undefined}>
      <g className={styles.ring}>
        {ARCS.map((d, i) => (
          <path key={d} d={d} className={styles.arc} data-on={i < stages || undefined} style={{ ['--i' as string]: i }} />
        ))}
      </g>
      {NODES.map((n, i) => (
        <g key={i}>
          <path d={`M ${CX} ${CY} L ${n.x} ${n.y}`} className={styles.spoke} />
          <circle cx={n.x} cy={n.y} r="24" className={styles.node} style={{ ['--i' as string]: i }} />
        </g>
      ))}
      {hub ? (
        <g>
          <circle cx={CX} cy={CY} r="50" className={styles.hub} />
          <path
            className={styles.rupee}
            transform={`translate(${CX} ${CY}) scale(4.6) translate(-12.2 -12.3)`}
            d="M8.5 7.5h7 M8.5 10.5h7 M10 7.5c2.6 0 3.9 1.1 3.9 2.9 0 1.9-1.4 3-3.9 3H9l4.8 3.6"
          />
        </g>
      ) : null}
    </svg>
  );
}
