import { CLOSING, WHY } from '../../../../content/site.ts';
import { MarkArt } from '../../../../components/MarkArt.tsx';
import { appOrigin } from '../../../../server/site.ts';
import { ArrowIcon, CheckIcon } from '../icons.tsx';
import section from '../section.module.css';
import styles from './why.module.css';

function CrossIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path d="M3.4 3.4l5.2 5.2 M8.6 3.4 3.4 8.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Why INRP2P: the same deal done in a chat and done here, row by row — a real table, so it reads as one to whoever
 * cannot see it. INRP2P's column stands as one raised sheet under the page's orange moment; on a phone each row
 * becomes a card of its own, the two answers labelled. Server markup only.
 */
export function Why() {
  const { eyebrow, heading, lede, caption, columns, rows } = WHY;
  return (
    <section id="why" className={styles.why} aria-labelledby="why-title">
      <div className={section.inner}>
        <header className={section.head}>
          <div>
            <p className={section.eyebrow}>{eyebrow}</p>
            <h2 id="why-title" className={section.title}>
              {heading}
            </h2>
          </div>
          <p className={section.lede}>{lede}</p>
        </header>

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
          <a className={styles.cta} href={`${appOrigin()}${CLOSING.cta.appPath}`}>
            {CLOSING.cta.label}
            <ArrowIcon className={styles.ctaArrow} />
          </a>
        </div>
      </div>
    </section>
  );
}
