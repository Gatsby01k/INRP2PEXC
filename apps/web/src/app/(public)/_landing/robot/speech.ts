import type { VoiceLine } from '../../../../content/site.ts';
import { CLIP_MEASUREMENTS, type ClipMeasurement, LEVEL_RATE } from '../voice/clips/measurements.ts';
import { EXPRESSIONS, STATES, type LookTarget, type StateSpec } from './states.ts';

/**
 * How the robot moves while it speaks: one authored timeline per recorded line.
 *
 * Attention moves the moment a line is asked for — the eyes first, as always — so the body is already turning
 * as the first sound arrives. Everything tied to the words is timed from the clip itself (`voice/clips`
 * measures each recording): a single, small nod lands on the syllable that carries the line, the chest's hub
 * light follows the loudness of the voice, and the emblem resolves on a received request. After the last word
 * the pose holds a moment and the robot eases back to rest from wherever it is — no gesture, nothing repeated.
 *
 * Times are seconds; a look's `from` counts from the moment the line was asked for, everything else from the
 * moment its first sound is heard.
 */
export interface SpeechScript {
  readonly look: readonly { readonly from: number; readonly target: LookTarget }[];
  /** The body while speaking: head dynamics, optics, face and posture, as for any state. */
  readonly spec: Pick<StateSpec, 'head' | 'eyes' | 'face' | 'lean' | 'chin' | 'roll' | 'accent'>;
  /** One small nod, on the first or last stressed syllable, this deep (radians of chin). */
  readonly nod: { readonly on: 'first' | 'last'; readonly depth: number } | null;
  /** How brightly the chest hub follows the voice. */
  readonly light: number;
  /** Whether the emblem resolves on the nod: the three arcs of a completed request. */
  readonly resolve: boolean;
  /** Seconds the pose holds after the line before the robot returns to rest. */
  readonly hold: number;
}

export const SPEECH: Record<VoiceLine, SpeechScript> = {
  // The first move of the visit: face the visitor, lift a touch, smile — and acknowledge them on "Ready".
  ready: {
    look: [{ from: 0, target: 'viewer' }],
    spec: {
      head: { yaw: 0.5, pitch: 0.58, share: 0.5, ease: 0.3 },
      eyes: { aperture: 1, time: 0.2, gain: 1.05, notice: true, focus: 0 },
      face: EXPRESSIONS.welcome,
      lean: -0.004,
      chin: 0.012,
      roll: 0.03,
      accent: 0.5,
    },
    nod: { on: 'first', depth: 0.016 },
    light: 0.45,
    resolve: false,
    hold: 0.35,
  },
  // A request is with the desk: a glance at it, then the visitor, pleased, a firm nod on "-ceived" and the mark
  // complete.
  received: {
    look: [
      { from: 0, target: 'panel' },
      { from: 0.3, target: 'viewer' },
    ],
    spec: {
      head: { yaw: 0.42, pitch: 0.5, share: 0.5, ease: 0.3 },
      eyes: { aperture: 1, time: 0.25, gain: 1.1, notice: true, focus: 0 },
      face: EXPRESSIONS.success,
      lean: -0.008,
      chin: 0.01,
      roll: 0,
      accent: 0.5,
    },
    nod: { on: 'last', depth: 0.024 },
    light: 0.4,
    resolve: true,
    hold: 0.6,
  },
  // Something needs another look: attention goes to the amount and stays there, concerned rather than stern, the
  // antenna's tip lit, the head tilting a little as it reads. No nod — nothing has been agreed.
  check: {
    look: [{ from: 0, target: 'amount' }],
    spec: {
      head: { yaw: 0.44, pitch: 0.52, share: 0.5, ease: 0.4 },
      eyes: { aperture: 1.04, time: 0.18, gain: 1.04, notice: false, focus: 0 },
      face: EXPRESSIONS.alert,
      lean: 0.008,
      chin: -0.01,
      roll: -0.03,
      accent: 0.45,
    },
    nod: null,
    light: 0.35,
    resolve: false,
    hold: 0.45,
  },
};

/** The state spec for speaking a line: the script's body, attention on its schedule, no drift, no blinking. */
export function speakingSpec(line: VoiceLine): StateSpec {
  const script = SPEECH[line];
  return {
    ...STATES.idle,
    ...script.spec,
    attention: (elapsed) => {
      let target: LookTarget = script.look[0]?.target ?? 'viewer';
      for (const step of script.look) if (elapsed >= step.from) target = step.target;
      return target;
    },
    faceTime: 0.16,
    turn: 0,
    breath: 0.6,
    blinks: false,
    settle: 0.5,
    drift: false,
  };
}

/** The measured clip for a line. */
export const clipOf = (line: VoiceLine): ClipMeasurement => CLIP_MEASUREMENTS[line];

/** When the nod lands, in seconds from the first sound, or null for a line without one. */
export function nodTime(line: VoiceLine): number | null {
  const { nod } = SPEECH[line];
  const { peaks } = CLIP_MEASUREMENTS[line];
  if (!nod || peaks.length === 0) return null;
  return (nod.on === 'first' ? peaks[0] : peaks[peaks.length - 1])?.at ?? null;
}

/** The voice's loudness, 0–1, `t` seconds into a clip; silence outside it. */
export function loudness(line: VoiceLine, t: number): number {
  const { level } = CLIP_MEASUREMENTS[line];
  const x = t * LEVEL_RATE;
  if (x < 0 || x > level.length - 1) return 0;
  const i = Math.floor(x);
  const a = level[i] ?? 0;
  const b = level[i + 1] ?? a;
  return a + (b - a) * (x - i);
}
