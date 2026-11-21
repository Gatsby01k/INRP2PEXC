import { getImageProps } from 'next/image';
import { CLOSING, WHY } from '../../../../content/site.ts';
import { MarkArt } from '../../../../components/MarkArt.tsx';
import { appOrigin } from '../../../../server/site.ts';
import { ArrowIcon, CheckIcon } from '../icons.tsx';
import love from '../robot/stills/robot-love.webp';
import worried from '../robot/stills/robot-worried.webp';
import section from '../section.module.css';
import styles from './why.module.css';

function CrossIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path d="M3.4 3.4l5.2 5.2 M8.6 3.4 3.4 8.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The robot, still, at the size it is drawn: served resized, never redrawn. */
function robot(src: typeof love) {
  return getImageProps({ src, alt: '', width: 290, height: 290, sizes: '290px' }).props;
}

/**
 * Why INRP2P: the same deal twice. First as a scene — a chat that goes wrong, the robot worried beside it, and the
 * deal done here on the mark's orange, the robot delighted — then row by row, as a real table, so it reads as one to
 * whoever cannot see it. INRP2P's column stands as one raised sheet; on a phone each row becomes a card of its own,
 * the two answers labelled. Server markup only; the scene plays once as it scrolls in, where the browser can tie an
 * animation to scrolling.
 */
export function Why() {
  const { eyebrow, heading, lede, scene, caption, columns, rows } = WHY;
  return (
    <section id="why" className={styles.why} aria-labelledby="why-title">
      <div className={section.inner}>
        <header className={section.head}>
          <div>
            <p className={section.eyebrow}>
              <span className={section.index}>02</span>
              {eyebrow}
            </p>
            <h2 id="why-title" className={section.title}>
              {heading}
            </h2>
          </div>
          <p className={section.lede}>{lede}</p>
        </header>

        <div className={styles.scene} aria-hidden="true">
          <div className={`${styles.panel} ${styles.chat}`}>
            <p className={styles.panelTitle}>{scene.chat.title}</p>
            <div className={styles.chatHead}>
              <span className={styles.chatAvatar} />
              <span className={styles.chatWho}>
                <b />
                <i />
              </span>
            </div>
            <ol className={styles.messages}>
              {scene.chat.messages.map((m, i) => (
                <li key={m.text} className={styles.message} data-from={m.from} style={{ ['--i' as string]: i }}>
                  {m.kind === 'screenshot' ? (
                    // The screenshot: a payment app's success screen, green tick and all — which proves nothing.
                    <span className={styles.shot}>
                      <span className={styles.shotTick} />
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                  {m.text}
                </li>
              ))}
            </ol>
            <img {...robot(worried)} className={styles.robot} loading="lazy" decoding="async" />
          </div>
          <div className={`${styles.panel} ${styles.oursPanel}`} data-field-light="">
            <MarkArt className={styles.panelMark} />
            <p className={styles.panelTitle}>{scene.ours.title}</p>
            <div className={styles.dealCard}>
              <p className={styles.dealHead}>
                <span>{scene.ours.card}</span>
                <span className={styles.dealStatus}>{scene.ours.status}</span>
              </p>
              <ol className={styles.dealSteps}>
                {scene.ours.steps.map((step, i) => (
                  <li key={step} className={styles.dealStep} style={{ ['--i' as string]: i }}>
                    <svg className={styles.dealTick} viewBox="0 0 20 20">
                      <circle cx="10" cy="10" r="9" />
                      <path d="M6.2 10.4l2.6 2.6 5.1-5.6" />
                    </svg>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
            <img {...robot(love)} className={styles.robot} loading="lazy" decoding="async" />
          </div>
        </div>

        <div className={styles.board}>
          {/* The raised sheet INRP2P's column stands on, drawn behind the cells. */}
          <span className={styles.sheet} aria-hidden="true" />
          <table className={styles.table} role="table">
            <caption className="ix-visually-hidden">{caption}</caption>
            <colgroup className={styles.cols}>
              <col className={styles.colTopic} />
              <col className={styles.colDirect} />
              <col className={styles.colOurs} />
            </colgroup>
            <thead className={styles.head} role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader" className={styles.topicHead}>
                  {columns.topic}
                </th>
                <th scope="col" role="columnheader" className={styles.directHead}>
                  {columns.direct}
                </th>
                <th scope="col" role="columnheader" className={styles.oursHead}>
                  <MarkArt className={styles.oursMark} />
                  {columns.ours}
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.map((r) => (
                <tr key={r.topic} role="row" className={styles.row}>
                  <th scope="row" role="rowheader" className={styles.topic}>
                    {r.topic}
                  </th>
                  <td role="cell" className={styles.direct}>
                    <span className={styles.label} aria-hidden="true">
                      {columns.direct}
                    </span>
                    <span className={styles.answer}>
                      <span className={styles.cross}>
                        <CrossIcon />
                      </span>
                      {r.direct}
                    </span>
                  </td>
                  <td role="cell" className={styles.ours}>
                    <span className={styles.label} aria-hidden="true">
                      {columns.ours}
                    </span>
                    <span className={styles.answer}>
                      <span className={styles.check}>
                        <CheckIcon />
                      </span>
                      {r.ours}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.foot}>
          <a className={section.cta} href={`${appOrigin()}${CLOSING.cta.appPath}`}>
            {CLOSING.cta.label}
            <ArrowIcon />
          </a>
        </div>
      </div>
    </section>
  );
}
