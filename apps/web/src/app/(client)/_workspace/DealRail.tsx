import styles from './deal-rail.module.css';

/** Where a P2P deal has got to (ADR 0019): the escrow fills, the rupees are paid, confirmed, and the escrow releases. */
export type RailStep = 'ESCROW' | 'PAY' | 'CONFIRM' | 'RELEASE' | 'DONE' | 'REFUND' | 'CANCELLED';

/** A deal that has not begun: every lane still ahead — the picture a quote shows of what accepting starts. */
export type RailAhead = 'AHEAD';

type Lane = 'todo' | 'wait' | 'fly' | 'done' | 'off';

const RUPEE = 'M8.5 7.5h7 M8.5 10.5h7 M10 7.5c2.6 0 3.9 1.1 3.9 2.9 0 1.9-1.4 3-3.9 3H9l4.8 3.6';
const TETHER =
  'm73.295 81.633v-.01c-.43.03-2.65.16-7.59.16-3.95 0-6.72-.11-7.7-.16v.01c-15.19-.67-26.52-3.31-26.52-6.48 0-3.16 11.34-5.81 26.52-6.48v10.33c.99.07 3.84.24 7.77.24 4.72 0 7.08-.2 7.52-.24v-10.32c15.16.68 26.46 3.32 26.46 6.48s-11.31 5.8-26.46 6.48m0-14.03v-9.24h21.15v-14.09h-57.58v14.09h21.15v9.24c-17.19.79-30.11 4.19-30.11 8.27s12.93 7.48 30.11 8.28v29.62h15.29v-29.62c17.16-.79 30.06-4.19 30.06-8.27 0-4.07-12.9-7.48-30.06-8.27';
/** The rupees' way back along the bottom: from the buyer, under the escrow, up to the seller. */
const INR_PATH = 'M720 124V158a18 18 0 0 1-18 18H78a18 18 0 0 1-18-18V124';
/** The escrow's ring in four arcs — the deal's four moments, lit in order. */
const ARCS = ['M393.49 34.12A50 50 0 0 1 439.88 80.51', 'M439.88 87.49A50 50 0 0 1 393.49 133.88', 'M386.51 133.88A50 50 0 0 1 340.12 87.49', 'M340.12 80.51A50 50 0 0 1 386.51 34.12'];
const REACHED: Record<RailStep | RailAhead, number> = { AHEAD: -1, ESCROW: 0, PAY: 1, CONFIRM: 2, RELEASE: 3, DONE: 4, REFUND: 0, CANCELLED: 0 };

const Usdt = ({ x, y, size }: { x: number; y: number; size: number }) => (
  <g transform={`translate(${x} ${y}) scale(${size / 32})`}>
    <circle cx="16" cy="16" r="16" className={styles.usdt} />
    <path className={styles.sign} transform="scale(0.25723) translate(-4.465 -13.693)" d={TETHER} />
  </g>
);

/**
 * A P2P deal as one picture: who holds what, and what is on its way. The seller on the left, INRP2P's escrow in the
 * middle, the buyer on the right; the USDT travels along the top — into the escrow, and out of it only at the end —
 * and the rupees come back along the bottom, straight from the buyer to the seller. A lane that is done is a solid
 * line, one that is moving is a dotted orange line with its coin travelling it, one that has not begun is a quiet
 * dotted line. The same picture follows the deal from the quote to its receipt.
 *
 * It is a drawing of what the page already says in words (the headline, the journey below it), so it is one image
 * to assistive technology, with that sentence as its name.
 */
export function DealRail({ viewer, step, usdt, inr, label }: { viewer: 'seller' | 'buyer'; step: RailStep | RailAhead; usdt: string; inr: string; label: string }) {
  const ahead = step === 'AHEAD';
  const over = step === 'REFUND' || step === 'CANCELLED';
  const into: Lane = over ? 'off' : ahead ? 'todo' : step === 'ESCROW' ? 'fly' : 'done';
  const back: Lane = over ? 'off' : ahead || step === 'ESCROW' ? 'todo' : step === 'PAY' ? 'wait' : step === 'CONFIRM' ? 'fly' : 'done';
  const out: Lane = over ? 'off' : step === 'RELEASE' ? 'fly' : step === 'DONE' ? 'done' : 'todo';
  const reached = REACHED[step];
  const locked = !over && !ahead && step !== 'ESCROW' && step !== 'DONE';
  const seller = viewer === 'seller';
  const inrWord = { todo: seller ? 'paid to you once the USDT is in escrow' : 'you pay once the USDT is in escrow', wait: seller ? 'the buyer is paying' : 'yours to pay', fly: 'on its way', done: 'received', off: 'not paid' }[back];
  return (
    <svg className={styles.rail} viewBox="0 0 780 206" role="img" aria-label={label} focusable="false">
      <text className={styles.who} x="60" y="20" textAnchor="middle">
        {seller ? 'You · seller' : 'Seller'}
      </text>
      <text className={styles.who} x="390" y="20" textAnchor="middle">
        INRP2P escrow
      </text>
      <text className={styles.who} x="720" y="20" textAnchor="middle">
        {seller ? 'Buyer' : 'You · buyer'}
      </text>

      {/* USDT, seller → escrow. */}
      <path id="rail-into" className={styles.lane} data-lane={into} d="M98 84H322" />
      <path className={styles.head} data-lane={into} d="M315 77.5l8 6.5-8 6.5" />
      <g className={styles.rider} data-lane={into} style={{ offsetPath: "path('M98 84H322')" }}>
        <circle r="15" className={styles.plate} />
        <Usdt x={-12} y={-12} size={24} />
      </g>
      <text className={styles.cap} x="210" y="58" textAnchor="middle">
        {usdt}
      </text>
      <text className={styles.note} x="210" y="116" textAnchor="middle">
        {into === 'todo' ? 'FIRST, INTO ESCROW' : into === 'fly' ? 'ON ITS WAY TO ESCROW' : into === 'done' ? 'IN ESCROW' : 'GOING BACK'}
      </text>

      {/* USDT, escrow → buyer: only at the end. */}
      <path className={styles.lane} data-lane={out} d="M458 84H682" />
      <path className={styles.head} data-lane={out} d="M675 77.5l8 6.5-8 6.5" />
      {out === 'fly' ? (
        <g className={styles.rider} data-lane="fly" style={{ offsetPath: "path('M458 84H682')" }}>
          <circle r="15" className={styles.plate} />
          <Usdt x={-12} y={-12} size={24} />
        </g>
      ) : null}
      <text className={styles.cap} data-quiet={out === 'todo' || undefined} x="570" y="58" textAnchor="middle">
        {seller ? 'to the buyer' : 'to your wallet'}
      </text>
      <text className={styles.note} x="570" y="116" textAnchor="middle">
        {out === 'fly' ? 'RELEASING' : out === 'done' ? 'RELEASED' : out === 'off' ? '' : seller ? 'WHEN YOU CONFIRM' : 'WHEN THE SELLER CONFIRMS'}
      </text>

      {/* INR, buyer → seller, bank to bank. */}
      <path className={styles.lane} data-lane={back} d={INR_PATH} />
      <path className={styles.head} data-lane={back} d="M52.5 133l7.5-9 7.5 9" />
      {back === 'fly' ? (
        <g className={styles.rider} data-lane="fly" data-slow="" style={{ offsetPath: `path('${INR_PATH}')` }}>
          <circle r="14" className={styles.plate} />
          <circle r="11" className={styles.inr} />
          <path className={styles.rupee} transform="translate(0 .3) scale(.77) translate(-12.1 -12.3)" d={RUPEE} />
        </g>
      ) : null}
      <rect className={styles.tag} x={back === 'todo' ? 190 : 246} y="160" width={back === 'todo' ? 400 : 288} height="32" rx="16" />
      <text className={styles.tagText} x="390" y="181" textAnchor="middle">
        {inr}
        <tspan className={styles.tagNote}> · {inrWord}</tspan>
      </text>

      {/* The parties: the one looking at the page is ink, the other a person. */}
      <circle cx="60" cy="84" r="30" className={seller ? styles.you : styles.them} />
      <circle cx="720" cy="84" r="30" className={seller ? styles.them : styles.you} />
      {[60, 720].map((cx) => (
        <g key={cx} className={(cx === 60) === seller ? styles.personYou : styles.person} transform={`translate(${cx - 13} 71) scale(1.083)`}>
          <circle cx="12" cy="8.4" r="3.4" />
          <path d="M5.2 19.6c.7-3.6 3.3-5.6 6.8-5.6s6.1 2 6.8 5.6" />
        </g>
      ))}

      {/* The escrow: its ring in four arcs, the coin it holds, its lock. */}
      <circle cx="390" cy="84" r="44" className={styles.vault} />
      {ARCS.map((d, i) => (
        <path key={d} d={d} className={styles.arc} data-arc={over ? 'off' : i < reached ? 'done' : i === reached ? 'now' : 'todo'} />
      ))}
      <g opacity={ahead || step === 'ESCROW' || step === 'DONE' || over ? 0.28 : 1}>
        <Usdt x={364} y={58} size={52} />
      </g>
      {locked ? (
        <g>
          <circle cx="421" cy="113" r="13.5" className={styles.plate} />
          <circle cx="421" cy="113" r="9.2" className={styles.lockDisc} />
          <rect x="417" y="112.2" width="8" height="6" rx="1.8" className={styles.plate} />
          <path d="M418.8 112.2v-1.4a2.2 2.2 0 0 1 4.4 0v1.4" className={styles.lockBow} />
        </g>
      ) : null}
    </svg>
  );
}
