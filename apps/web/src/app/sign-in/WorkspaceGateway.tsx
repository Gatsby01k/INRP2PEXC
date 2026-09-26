import { getImageProps } from 'next/image';
import mark from '../../../../../brand/inrp2p-mark.png';
import { AccessSurface } from './AccessSurface.tsx';
import { GatewayRobot } from './GatewayRobot.tsx';
import styles from './gateway.module.css';

/** The masthead's way back: the home page's entry glyph turned round, a line arriving at its station. */
function BackGlyph() {
  return (
    <svg className={styles.backGlyph} width="22" height="12" viewBox="0 0 22 12" fill="none" aria-hidden="true" focusable="false">
      <circle cx="20" cy="6" r="1.6" fill="currentColor" />
      <path d="M8 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path className={styles.backHead} d="M4.5 6H11 M8 2.5 4.5 6 8 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The workspace gateway: client sign-in on the app host, drawn as another state of the home page.
 *
 * The home page's "Open workspace" is a real navigation to this host — the public site never signs anyone in —
 * so what can be continuous is the room, not the page: the same masthead, the same lit off-white field, the same
 * grid, the robot standing where the hero stands it, and the access surface where the quote module was, at its
 * width and in its material. On a phone the surface is the page; the robot is left out.
 *
 * A server component. Two islands hydrate inside it: the surface (the form) and the robot.
 */
export function WorkspaceGateway({ home, onboarding, unlinked }: { home: string; onboarding: string | null; unlinked: string }) {
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 32, height: 32 });
  return (
    <div className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.mastheadInner}>
          <a href={home} className={styles.brand}>
            <img {...markProps} className={styles.brandMark} />
            <span className={styles.brandName}>INRP2P Exchange</span>
          </a>
          <a href={home} className={styles.back}>
            <BackGlyph />
            <span>
              Back<span className={styles.backTail}> to exchange</span>
            </span>
          </a>
        </div>
      </header>

      <main className={styles.gateway} data-robot-scope="">
        <div className={styles.frame}>
          <div className={styles.copy}>
            <p className={styles.eyebrow}>Workspace access</p>
            <h1 className={styles.title}>Enter the desk.</h1>
            <p className={styles.lede}>Access is limited to clients onboarded by the INRP2P desk.</p>
          </div>

          <div className={styles.stage} aria-hidden="true">
            <GatewayRobot />
          </div>

          <div className={styles.access}>
            <AccessSurface onboarding={onboarding} unlinked={unlinked} />
          </div>
        </div>
      </main>
    </div>
  );
}
