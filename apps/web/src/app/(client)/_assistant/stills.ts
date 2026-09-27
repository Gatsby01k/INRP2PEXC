import type { StaticImageData } from 'next/image';
import type { RobotMood } from '../../(public)/_landing/robot/cues.ts';
import alert from './stills/robot-alert.webp';
import focused from './stills/robot-focused.webp';
import none from './stills/robot-none.webp';
import success from './stills/robot-success.webp';
import verifying from './stills/robot-verifying.webp';
import waiting from './stills/robot-waiting.webp';

/** The robot held in each mood, rendered from its own scene (`pnpm --filter @inrp2p/web robot:moods`). */
export const STILLS: Record<RobotMood, StaticImageData> = { none, waiting, focused, verifying, success, alert };
