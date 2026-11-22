import { getImageProps } from 'next/image';
import { FLOW } from '../../../../content/site.ts';
import { ImpsMark, UpiMark } from '../../../../components/PayMarks.tsx';
import { ByDirection } from '../Story.tsx';
import { DealSteps } from './DealSteps.tsx';
import still from '../../../(client)/_assistant/stills/robot-none.webp';
import { LedFace } from './LedFace.tsx';
import styles from './deal.module.css';

/**
 * How it works: one deal, in the four moments every P2P deal on INRP2P passes, beside the picture the workspace shows
 * on every deal page (`DealRail`) — the seller on the left, INRP2P's escrow in the middle, the buyer on the right; the
 * USDT along the top, the rupees back along the bottom, bank to bank.
 *
 * Rendered on the server and complete without script: every moment's words are in the list, in both directions
 * (Story.tsx shows one), and the picture shows the finished deal. One small island (DealSteps.tsx) holds the switch
 * between directions and writes the moment being read onto the section (`data-step`), which is all the picture
 * follows: its coins travel, its rings light and its visor changes line in CSS. Nothing a reader needs is only in the
 * motion; the picture is one image with the heading as its name.
 */

const TETHER =
  'm73.295 81.633v-.01c-.43.03-2.65.16-7.59.16-3.95 0-6.72-.11-7.7-.16v.01c-15.19-.67-26.52-3.31-26.52-6.48 0-3.16 11.34-5.81 26.52-6.48v10.33c.99.07 3.84.24 7.77.24 4.72 0 7.08-.2 7.52-.24v-10.32c15.16.68 26.46 3.32 26.46 6.48s-11.31 5.8-26.46 6.48m0-14.03v-9.24h21.15v-14.09h-57.58v14.09h21.15v9.24c-17.19.79-30.11 4.19-30.11 8.27s12.93 7.48 30.11 8.28v29.62h15.29v-29.62c17.16-.79 30.06-4.19 30.06-8.27 0-4.07-12.9-7.48-30.06-8.27';
const RUPEE = 'M8.5 7.5h7 M8.5 10.5h7 M10 7.5c2.6 0 3.9 1.1 3.9 2.9 0 1.9-1.4 3-3.9 3H9l4.8 3.6';

/** A party's disc: the person, drawn in the workspace's hand. */
function Party({ cx, side }: { cx: number; side: 'seller' | 'buyer' }) {
  return (
    <g className={styles.party} data-side={side}>
      <circle cx={cx} cy="294" r="54" className={styles.partyHalo} />
      <circle cx={cx} cy="294" r="44" className={styles.partyDisc} />
      <g transform={`translate(${cx - 17} 277) scale(1.42)`} className={styles.person}>
        <circle cx="12" cy="8.4" r="3.6" />
        <path d="M4.8 19.8c.7-3.8 3.5-5.9 7.2-5.9s6.5 2.1 7.2 5.9" />
      </g>
    </g>
  );
}

/** The rupees' way: from the buyer's bank, down under the robot and its name, up to the seller's — never through the escrow. */
const BACK = 'M670 348V394a22 22 0 0 1-22 22H112a22 22 0 0 1-22-22V348';

/**
 * The deal's picture: the seller and the buyer either side, and in the middle INRP2P's escrow — the robot itself. The
 * USDT goes into its chest and comes out only at the end; its face is the deal's display (LedFace.tsx). Three layers:
 * the lanes and the parties, the robot, then what travels in front of it.
 */
function Picture() {
  const { props: robot } = getImageProps({ src: still, alt: '', width: 360, height: 360, sizes: '(max-width: 1099px) 48vw, 360px' });
  return (
    <>
      <svg className={styles.rail} viewBox="0 0 760 440" aria-hidden="true" focusable="false">
        <circle cx="380" cy="294" r="132" className={styles.vaultGlow} />
        <path className={styles.lane} data-lane="in" d="M144 294H300" />
        <path className={styles.lane} data-lane="out" d="M460 294H616" />
        <path className={styles.laneBack} data-lane="back" d={BACK} />
        <path className={styles.laneHead} data-lane="back" d="M81.5 358l8.5-10 8.5 10" />
        <path className={styles.laneHead} data-lane="in" d="M293 287.5l8 6.5-8 6.5" />
        <path className={styles.laneHead} data-lane="out" d="M609 287.5l8 6.5-8 6.5" />
        <Party cx={90} side="seller" />
        <Party cx={670} side="buyer" />
      </svg>

      <div className={styles.robot}>
        <img {...robot} className={styles.robotStill} loading="lazy" decoding="async" />
        <span className={styles.visorGlass}>
          <LedFace />
        </span>
      </div>

      <svg className={`${styles.rail} ${styles.front}`} viewBox="0 0 760 440" aria-hidden="true" focusable="false">
        <circle cx="380" cy="294" r="38" className={styles.chestGlow} />
        <g className={styles.lock}>
          <circle cx="424" cy="322" r="17" className={styles.lockPlate} />
          <circle cx="424" cy="322" r="12.5" className={styles.lockDisc} />
          <rect x="418.5" y="321" width="11" height="8.4" rx="2.2" className={styles.lockBody} />
          <path className={styles.lockBow} d="M420.8 321v-2.2a3.2 3.2 0 0 1 6.4 0v2.2" />
        </g>
        <g className={styles.usdt}>
          <circle r="23" className={styles.riderPlate} />
          <g transform="translate(-18 -18) scale(1.125)">
            <circle cx="16" cy="16" r="16" className={styles.tetherDisc} />
            <path className={styles.tetherSign} transform="scale(0.25723) translate(-4.465 -13.693)" d={TETHER} />
          </g>
        </g>
        <g className={styles.inr}>
          <circle r="20" className={styles.riderPlate} />
          <circle r="16" className={styles.inrDisc} />
          <path className={styles.inrSign} transform="scale(1.15) translate(-12.1 -12.3)" d={RUPEE} />
        </g>
      </svg>
    </>
  );
}

export function Deal() {
  const { eyebrow, heading, lede, direction, parties, lanes, steps, done } = FLOW;
  return (
    <section id="how-it-works" className={styles.deal} aria-labelledby="deal-title" data-deal="" data-step="3">
      <div className={styles.inner}>
        <header className={styles.head}>
          <div>
            <p className={styles.eyebrow}>
              <span className={styles.index}>01</span>
              {eyebrow}
            </p>
            <h2 id="deal-title" className={styles.title}>
              {heading}
            </h2>
          </div>
          <div className={styles.aside}>
            <p className={styles.lede}>{lede}</p>
            <DealSteps copy={direction} />
          </div>
        </header>

        <div className={styles.body}>
          <ol className={styles.steps}>
            {steps.map((s, i) => (
              <li key={s.key} className={styles.step} data-deal-step={i}>
                <span className={styles.stepIndex} aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className={styles.stepText}>
                  <h3 className={styles.stepTitle}>
                    <ByDirection value={s.title} />
                  </h3>
                  <p className={styles.stepBody}>
                    <ByDirection value={s.body} />
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className={styles.sceneWrap}>
            <div className={styles.pin}>
            <figure className={styles.scene} aria-label={heading}>
              <div className={styles.picture}>
                <Picture />
                <span className={styles.who} data-at="seller">
                  <b>
                    <ByDirection value={parties.seller} />
                  </b>
                  <small>Seller</small>
                </span>
                <span className={styles.who} data-at="escrow">
                  <b>{parties.escrow}</b>
                  <small>Escrow</small>
                </span>
                <span className={styles.who} data-at="buyer">
                  <b>
                    <ByDirection value={parties.buyer} />
                  </b>
                  <small>Buyer</small>
                </span>
                <span className={styles.laneName} data-at="usdt">
                  {lanes.usdt}
                </span>
                <span className={styles.tag}>
                  <span className={styles.tagWord}>{lanes.rupees}</span>
                  <UpiMark className={styles.tagMark} />
                  <ImpsMark className={styles.tagMark} />
                  <span className={styles.tagRail}>NEFT</span>
                  <span className={styles.tagRail}>RTGS</span>
                </span>
              </div>

              <figcaption className={styles.foot}>
                <span className={styles.receipt}>
                  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <circle cx="10" cy="10" r="9" />
                    <path d="M6.2 10.4l2.6 2.6 5.1-5.6" />
                  </svg>
                  {done}
                </span>
                <span className={styles.footNote}>{FLOW.network}</span>
              </figcaption>
            </figure>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
