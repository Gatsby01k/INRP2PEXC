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
export function DealRail({
  viewer,
  step,
  usdt,
  inr,
  label,
  destination,
  initial,
  sent,
  rail,
  inrTo,
  inrFrom,
}: {
  viewer: 'seller' | 'buyer';
  step: RailStep | RailAhead;
  usdt: string;
  inr: string;
  label: string;
  destination?: string;
  /** The viewer's own initial, set on its disc — the same letter as the bar's account. A person's glyph when absent. */
  initial?: string;
  /** When the USDT reached the escrow, once it is there: "SENT 14:41 · FINAL". */
  sent?: string | null;
  /** How the rupees travel, once the buyer has said: "IMPS". */
  rail?: string | null;
  /** Under the seller: where the rupees land ("to HDFC ···· 8219"). */
  inrTo?: string | null;
  /** Under the buyer: where the rupees must come from. */
  inrFrom?: string | null;
}) {
  const ahead = step === 'AHEAD';
  const over = step === 'REFUND' || step === 'CANCELLED';
  const into: Lane = over ? 'off' : ahead ? 'todo' : step === 'ESCROW' ? 'fly' : 'done';
  const back: Lane = over ? 'off' : ahead || step === 'ESCROW' ? 'todo' : step === 'PAY' ? 'wait' : step === 'CONFIRM' ? 'fly' : 'done';
  const out: Lane = over ? 'off' : step === 'RELEASE' ? 'fly' : step === 'DONE' ? 'done' : 'todo';
  const reached = REACHED[step];
  const locked = !over && !ahead && step !== 'ESCROW' && step !== 'DONE';
  const seller = viewer === 'seller';
  const tagText = `${inr}${rail && back !== 'todo' && back !== 'off' ? ` · ${rail}` : ''}`;
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

      {ahead ? <AheadMarks seller={seller} destination={destination} /> : null}

      {/* USDT, seller → escrow. */}
      <path id="rail-into" className={styles.lane} data-lane={into} d="M98 84H322" />
      <path className={styles.head} data-lane={into} d="M315 77.5l8 6.5-8 6.5" />
      <g className={styles.rider} data-lane={into} style={{ offsetPath: "path('M98 84H322')" }}>
        <circle r="15" className={styles.plate} />
        <Usdt x={-12} y={-12} size={24} />
      </g>
      {ahead ? null : (
        <>
          <text className={styles.cap} x="210" y="58" textAnchor="middle">
            {usdt}
          </text>
          <text className={styles.note} x="210" y="116" textAnchor="middle">
            {into === 'fly' ? 'ON ITS WAY TO ESCROW' : into === 'done' ? (sent ?? 'IN ESCROW') : 'GOING BACK'}
          </text>
        </>
      )}

      {/* USDT, escrow → buyer: only at the end. */}
      <path className={styles.lane} data-lane={out} d="M458 84H682" />
      <path className={styles.head} data-lane={out} d="M675 77.5l8 6.5-8 6.5" />
      {out === 'fly' ? (
        <g className={styles.rider} data-lane="fly" style={{ offsetPath: "path('M458 84H682')" }}>
          <circle r="15" className={styles.plate} />
          <Usdt x={-12} y={-12} size={24} />
        </g>
      ) : null}
      {ahead ? null : (
        <>
          <text className={styles.cap} data-quiet={out === 'todo' || undefined} x="570" y="58" textAnchor="middle">
            {seller ? 'to the buyer' : 'to your wallet'}
          </text>
          <text className={styles.note} x="570" y="116" textAnchor="middle">
            {out === 'fly' ? 'RELEASING' : out === 'done' ? 'RELEASED' : out === 'off' ? '' : seller ? 'WHEN YOU CONFIRM' : 'WHEN THE SELLER CONFIRMS'}
          </text>
        </>
      )}

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
      {ahead ? null : (
        <>
          {/* The tag is as wide as what it says: about 7px a character at its size, with its padding. */}
          <rect className={styles.tag} x={390 - tagWidth(tagText, inrWord) / 2} y="160" width={tagWidth(tagText, inrWord)} height="32" rx="16" />
          <text className={styles.tagText} x="390" y="181" textAnchor="middle">
            {inr}
            <tspan className={styles.tagNote}>
              {tagText.slice(inr.length)} · {inrWord}
            </tspan>
          </text>
          {back !== 'off' && back !== 'todo' ? (
            <>
              {(seller ? inrTo : inrTo ?? 'to the seller’s own account') ? (
                <text className={styles.side} x="78" y="150">
                  {seller ? inrTo : (inrTo ?? 'to the seller’s own account')}
                </text>
              ) : null}
              <text className={styles.side} x="702" y="150" textAnchor="end">
                {inrFrom ?? (seller ? 'from the buyer’s own account' : 'from your own account')}
              </text>
            </>
          ) : null}
        </>
      )}

      {/* The parties: the one looking at the page is ink, the other a person. */}
      <circle cx="60" cy="84" r="30" className={seller ? styles.you : styles.them} />
      <circle cx="720" cy="84" r="30" className={seller ? styles.them : styles.you} />
      {[60, 720].map((cx) =>
        (cx === 60) === seller && initial ? (
          <text key={cx} className={styles.initial} x={cx} y="89.5" textAnchor="middle">
            {initial}
          </text>
        ) : (
          <g key={cx} className={(cx === 60) === seller ? styles.personYou : styles.person} transform={`translate(${cx - 13} 71) scale(1.083)`}>
            <circle cx="12" cy="8.4" r="3.4" />
            <path d="M5.2 19.6c.7-3.6 3.3-5.6 6.8-5.6s6.1 2 6.8 5.6" />
          </g>
        ),
      )}

      {/* The escrow: its ring in four arcs, the coin it holds, its lock. */}
      <circle cx="390" cy="84" r="44" className={styles.vault} data-ahead={ahead || undefined} />
      {ahead
        ? null
        : ARCS.map((d, i) => <path key={d} d={d} className={styles.arc} data-arc={over ? 'off' : i < reached ? 'done' : i === reached ? 'now' : 'todo'} />)}
      <g opacity={ahead ? 0.9 : step === 'ESCROW' || step === 'DONE' || over ? 0.28 : 1}>
        {ahead ? <Usdt x={368} y={62} size={44} /> : <Usdt x={364} y={58} size={52} />}
      </g>
      {ahead ? (
        <g>
          <circle cx="416" cy="108" r="12.5" className={styles.plate} />
          <circle cx="416" cy="108" r="8.6" className={styles.lockQuiet} />
          <rect x="412.3" y="107.4" width="7.4" height="5.6" rx="1.7" className={styles.plate} />
          <path d="M413.9 107.4v-1.3a2.1 2.1 0 0 1 4.2 0v1.3" className={styles.lockBow} />
        </g>
      ) : null}
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

/** The rupee tag's width: the figure set heavier, the words after it lighter, and its padding either side. */
const tagWidth = (lead: string, word: string) => Math.round(lead.length * 7.6 + (word.length + 3) * 6.6 + 40);

/** The quote's picture of what accepting starts: the three moves after it, numbered, on the lanes they happen on. */
function AheadMarks({ seller, destination }: { seller: boolean; destination?: string | undefined }) {
  // Three moves, a few words each: the picture says the rest.
  const into = seller ? 'Your USDT → escrow' : 'Seller’s USDT → escrow';
  const out = seller ? 'Released when you confirm' : 'Released to your wallet';
  const pay = seller ? ['Buyer pays the INR', ` · to ${destination ?? 'your bank'}`] : ['You pay the INR', ' · to the seller'];
  const chip = (x: number, y: number, n: string) => (
    <g>
      <rect className={styles.stepChip} x={x - 18} y={y - 13} width="36" height="26" rx="9" />
      <text className={styles.stepNo} x={x} y={y + 4.5} textAnchor="middle">
        {n}
      </text>
    </g>
  );
  return (
    <g>
      <text className={styles.cap} x="210" y="50" textAnchor="middle">
        {into}
      </text>
      {chip(210, 84, '01')}
      <text className={styles.cap} x="570" y="50" textAnchor="middle">
        {out}
      </text>
      {chip(570, 84, '03')}
      <rect className={styles.tag} x="220" y="160" width="340" height="32" rx="16" />
      <rect className={styles.stepChipQuiet} x="230" y="165" width="34" height="22" rx="8" />
      <text className={styles.stepNo} x="247" y="180.5" textAnchor="middle">
        02
      </text>
      <text className={styles.tagText} x="274" y="181">
        {pay[0]}
        <tspan className={styles.tagNote}>{pay[1]}</tspan>
      </text>
    </g>
  );
}
