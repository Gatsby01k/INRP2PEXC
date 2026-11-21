import { getImageProps } from 'next/image';
import mark from '../../../../../../../brand/inrp2p-mark.png';
import { SHOWCASE, type ShowcaseIcon } from '../../../../content/site.ts';
import { Coin } from '../../../../components/Coin.tsx';
import { BankIcon, ChatIcon, HistoryIcon, KeyIcon, RateIcon, UsersIcon } from '../../../(client)/_workspace/icons.tsx';
import focused from '../../../(client)/_assistant/stills/robot-focused.webp';
import { groupDigits } from '@inrp2p/ui/format';
import { LiveRate } from '../LiveRate.tsx';
import section from '../section.module.css';
import styles from './showcase.module.css';

/** The example the drawing is made with: the visitor selling this much USDT. An amount, never a rate of ours. */
const EXAMPLE_USDT = '10000';

const ICONS: Record<ShowcaseIcon, typeof RateIcon> = {
  rate: RateIcon,
  chat: ChatIcon,
  bank: BankIcon,
  key: KeyIcon,
  team: UsersIcon,
  history: HistoryIcon,
};

/** The countdown as the workspace draws it on a firm quote: a ring that runs down, with no figure in it. */
function Countdown() {
  return (
    <span className={styles.countdown} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="26" className={styles.countTrack} />
        <circle cx="32" cy="32" r="26" className={styles.countRun} pathLength="100" />
      </svg>
      <span className={styles.countLed} />
    </span>
  );
}

/**
 * The workspace, shown rather than described: the Exchange screen with a firm quote on its stage, the deal on a phone
 * with its chat, and the moment the rupees arrive. Drawn in markup in the workspace's own materials — the same glass
 * bar, ceramic sheet and orange stage — so it is the product a client will open, not an illustration of one. Its one
 * figure is the example amount at the market's own rate (LiveRate.tsx), or words without one. Decorative: the features
 * beside it say everything it shows.
 */
export function Showcase() {
  const { eyebrow, heading, lede, features, mock } = SHOWCASE;
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 26, height: 26 });
  const { props: robotProps } = getImageProps({ src: focused, alt: '', width: 300, height: 300, sizes: '300px' });
  return (
    <section id="workspace" className={styles.showcase} aria-labelledby="showcase-title">
      <div className={section.inner}>
        <header className={section.head}>
          <div>
            <p className={section.eyebrow}>
              <span className={section.index}>03</span>
              {eyebrow}
            </p>
            <h2 id="showcase-title" className={section.title}>
              {heading}
            </h2>
          </div>
          <p className={section.lede}>{lede}</p>
        </header>

        <div className={styles.stage} aria-hidden="true">
          <div className={styles.window}>
            <div className={styles.bar}>
              <span className={styles.barBrand}>
                <img {...markProps} className={styles.barMark} />
                INRP2P
              </span>
              <span className={styles.barNav}>
                {mock.nav.map((n, i) => (
                  <span key={n} className={styles.barLink} data-on={i === 0 || undefined}>
                    {n}
                  </span>
                ))}
              </span>
              <span className={styles.barRate}>
                <Coin currency="USDT" size={20} />
                <LiveRate direction="SELL_USDT" fallback="USDT/INR" className={styles.barFigure} />
                <svg viewBox="0 0 44 18" className={styles.barSpark}>
                  <path d="M1 13 L7 11 L12 12 L18 8 L23 9 L29 6 L34 7 L39 4 L43 5" />
                </svg>
              </span>
              <span className={styles.barMe}>A</span>
            </div>

            <div className={styles.screen}>
              <div className={styles.sheet}>
                <p className={styles.idx}>{mock.request}</p>
                <div className={styles.well}>
                  <span className={styles.wellLabel}>{mock.youSell}</span>
                  <span className={styles.wellRow}>
                    <b className={styles.amount}>{groupDigits(EXAMPLE_USDT)}</b>
                    <span className={styles.chip}>
                      <Coin currency="USDT" size={22} />
                      USDT
                    </span>
                  </span>
                </div>
                <div className={styles.dest}>
                  <span className={styles.bankTile}>
                    <svg viewBox="0 0 24 24" width="20" height="20">
                      <path d="M4 9.5 12 5l8 4.5 M5.5 10v7 M10 10v7 M14 10v7 M18.5 10v7 M4 19h16" />
                    </svg>
                  </span>
                  <span className={styles.destText}>
                    <small>{mock.paidTo}</small>
                    <b>{mock.bank}</b>
                  </span>
                  <span className={styles.rails}>UPI · IMPS</span>
                </div>
                <p className={styles.lockLine}>
                  <svg viewBox="0 0 20 20">
                    <circle cx="10" cy="10" r="9" />
                    <rect x="6.3" y="9.2" width="7.4" height="5.6" rx="1.7" />
                    <path d="M7.9 9.2V7.9a2.1 2.1 0 0 1 4.2 0v1.3" />
                  </svg>
                  {mock.lock}
                </p>
              </div>

              <div className={styles.field} data-field-light="">
                <span className={styles.held}>
                  <i />
                  {mock.held}
                </span>
                <span className={styles.receive}>{mock.youReceive}</span>
                <LiveRate direction="SELL_USDT" usdt={EXAMPLE_USDT} fallback={mock.words} className={styles.figure} />
                <span className={styles.chips}>
                  <span className={styles.fieldChip}>
                    <LiveRate direction="SELL_USDT" fallback={mock.market} /> {mock.perUsdt}
                  </span>
                  <span className={styles.fieldChip}>{mock.network}</span>
                </span>
                <span className={styles.marketNote}>{mock.market}</span>
                <span className={styles.acceptRow}>
                  <Countdown />
                  <span className={styles.accept}>
                    {mock.accept}
                    <kbd>↵</kbd>
                  </span>
                </span>
                <span className={styles.decline}>
                  <kbd>esc</kbd>
                  {mock.decline}
                </span>
                <span className={styles.halo}>
                  <i />
                </span>
                <img {...robotProps} className={styles.robot} loading="lazy" decoding="async" />
              </div>
            </div>
          </div>

          <div className={styles.phone}>
            <span className={styles.notch} />
            <span className={styles.phoneBar}>
              <span className={styles.back} />
              <b>{mock.trade}</b>
              <span className={styles.pair}>
                <Coin currency="USDT" size={20} />
                <Coin currency="INR" size={12} className={styles.pairBadge} />
              </span>
            </span>
            <span className={styles.cap} data-field-light="">
              <span className={styles.capMove}>
                <i />
                {mock.yourMove}
              </span>
              <b className={styles.capTitle}>{mock.confirmTitle}</b>
            </span>
            <span className={styles.thread}>
              {mock.chat.map((m) => (
                <span key={m.text} className={styles.bubble} data-from={m.from}>
                  {m.text}
                </span>
              ))}
              <span className={styles.attach}>
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20Z M14 3.5V8h4" />
                </svg>
                <i />
              </span>
            </span>
            <span className={styles.release}>{mock.release}</span>
          </div>

          <div className={styles.toast}>
            <Coin currency="INR" size={34} />
            <span className={styles.toastText}>
              <b>{mock.toast.title}</b>
              <small>{mock.toast.body}</small>
            </span>
            <svg className={styles.toastTick} viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="9" />
              <path d="M6.2 10.4l2.6 2.6 5.1-5.6" />
            </svg>
          </div>
        </div>

        <ul className={styles.features}>
          {features.map((f) => {
            const Icon = ICONS[f.icon];
            return (
              <li key={f.title} className={styles.feature}>
                <span className={styles.featureIcon}>
                  <Icon />
                </span>
                <h3 className={styles.featureTitle}>{f.title}</h3>
                <p className={styles.featureBody}>{f.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
