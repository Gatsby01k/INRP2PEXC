import { getImageProps } from 'next/image';
import still from '../../../(client)/_assistant/stills/robot-none.webp';
import { Halo } from '../Halo.tsx';
import { Led } from '../led/Led.tsx';
import styles from './guide.module.css';

/**
 * A guide's robot: the home page's robot on its sun, saying what the page is about on its visor in its LEDs ("USDT →
 * ₹", "SELL"…). The still picture with the LEDs set exactly into its black visor, so every guide carries the same face
 * as the home page, at the cost of one small image and one canvas.
 */
export function GuideRobot({ say }: { say: string }) {
  const { props } = getImageProps({ src: still, alt: '', width: 420, height: 420, sizes: '(max-width: 1099px) 240px, 420px' });
  return (
    <div className={styles.robot} aria-hidden="true">
      <Halo />
      <img {...props} className={styles.still} decoding="async" fetchPriority="low" />
      <span className={styles.visor}>
        <Led text={say} mode="marquee" pitch={6} rows={14} speed={12} className={styles.led} />
      </span>
    </div>
  );
}
