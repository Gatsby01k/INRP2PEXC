/**
 * What the robot does in each state of a quote, written down as targets.
 *
 * A state never plays an animation. It names where attention goes, which of the robot's five expressions its face
 * settles to, and what the body settles to — how the head moves, how the optics respond, how the torso is oriented —
 * and the behaviour eases the body towards those numbers, critically damped, from wherever it happens to be. That is
 * the difference between a machine that responds and a mascot that performs: the same event from a different
 * starting point produces a different, always-direct movement, and nothing is ever repeated for its own sake.
 *
 * Angles are radians; lean is forward-positive, turn is towards the quote module, chin is upward-positive, roll
 * tilts the head towards its right shoulder (the visitor's left, away from the module).
 */

export type RobotState =
  /** Nothing is happening: the robot faces the visitor and holds position, correcting it now and then. */
  | 'idle'
  /** The robot has just come online, or the visitor has just started: a brief, warm greeting. */
  | 'welcome'
  /** The quote's value is changing: attention on the amount, reading it, until it settles; then one confirmation. */
  | 'value'
  /** Buy or sell changed: a glance at the selector, the torso turning a touch towards the flow. */
  | 'direction'
  /** A firm rate arrived or changed: the robot reads it. */
  | 'rate'
  /** The rate was accepted: a glance to confirm, then a confident, level hold on the visitor. */
  | 'locked'
  /** What the visitor sent was accepted — a request by the desk, a code by the workspace: quietly pleased. */
  | 'accepted'
  /** What the visitor asked for cannot go as it is: attention on what needs changing, and a signal, gently. */
  | 'problem'
  /** Something the visitor asked for is on its way: the robot waits with them, calmly, until it answers. */
  | 'waiting'
  /** The visitor is on the call to action: the eyes go there and the head barely follows. Nothing else. */
  | 'intent'
  /** The visitor is on the masthead's way into the workspace: a glance up at it, even quieter than `intent`. */
  | 'entry'
  /** The robot is saying one of its lines: each has its own authored timeline (`speech.ts`). */
  | 'speaking';

/**
 * The places attention can go. The page supplies where they are; `viewer` is the camera. `entry` is the one
 * target outside the hero: the masthead's way into the workspace.
 */
export type LookTarget = 'viewer' | 'panel' | 'amount' | 'toggle' | 'rate' | 'cta' | 'entry';

/**
 * When a target is not on the page, attention falls back towards the module, then the visitor. The masthead is
 * not the module: without it, the robot simply keeps the visitor's eye.
 */
export const LOOK_FALLBACK: Record<LookTarget, LookTarget | null> = {
  viewer: null,
  panel: 'viewer',
  amount: 'panel',
  toggle: 'panel',
  rate: 'panel',
  cta: 'panel',
  entry: 'viewer',
};

/**
 * A setting of the face (`materials.ts` `visorMaterial`): the lower lids' smile (0 neutral, 0.5 a full arch, 1 a
 * single bright arc), the upper lids' drop and slope (positive lowers their inner ends, negative raises them), the
 * squint of reading, the three dots of waiting, and the steady glow of the antenna's tip.
 */
export interface Expression {
  readonly smile: number;
  readonly lid: number;
  readonly tilt: number;
  readonly squint: number;
  readonly dots: number;
  readonly beacon: number;
}

export type ExpressionName = 'neutral' | 'welcome' | 'verifying' | 'waiting' | 'success' | 'alert';

/**
 * The robot's five expressions, and the neutral face it rests in. Each is minimal on purpose — two shapes of light,
 * or three — and each is a setting of the same few numbers, so one can always ease into another.
 *
 * - Welcome: the eyes close into two bright arcs. Warm, and over quickly.
 * - Verifying: the eyes narrow to read, and a band of light passes through them with each change.
 * - Waiting: the eyes draw in to three dots that brighten in turn, slowly.
 * - Success: the eyes bend into two full arches — pleased, not elated.
 * - Help / alert: the eyes open a touch with their inner ends lifted — concern, not alarm — and the antenna's tip
 *   lights orange, twice, then holds.
 */
export const EXPRESSIONS: Record<ExpressionName, Expression> = {
  neutral: { smile: 0, lid: 0, tilt: 0, squint: 0, dots: 0, beacon: 0 },
  welcome: { smile: 1, lid: 0, tilt: 0, squint: 0, dots: 0, beacon: 0 },
  verifying: { smile: 0, lid: 0.08, tilt: 0.05, squint: 0.85, dots: 0, beacon: 0 },
  waiting: { smile: 0, lid: 0, tilt: 0, squint: 0, dots: 1, beacon: 0 },
  success: { smile: 0.5, lid: 0, tilt: 0, squint: 0, dots: 0, beacon: 0 },
  alert: { smile: 0, lid: 0.14, tilt: -0.4, squint: 0, dots: 0, beacon: 0.7 },
};

/**
 * How the head moves while in a state. `yaw` and `pitch` are the seconds a turn and a nod take; pitch is always
 * a little slower, so a head turns and then settles. `share` is how much of a look the head carries — the eyes
 * cover the rest. `ease` is the part of the move spent taking up the new aim: high for a soft, deliberate start,
 * low for a crisp one.
 */
export interface HeadDynamics {
  readonly yaw: number;
  readonly pitch: number;
  readonly share: number;
  readonly ease: number;
}

/**
 * How the optics behave in a state. `aperture` is the steady opening (1 neutral, below 1 focused) and `time` how
 * gently they get there. `notice` opens and brightens them a touch as the state takes attention; `focus` narrows
 * them briefly by that much, once, as the state begins.
 */
export interface EyeDynamics {
  readonly aperture: number;
  readonly time: number;
  readonly gain: number;
  readonly notice: boolean;
  readonly focus: number;
}

export interface StateSpec {
  /**
   * Where the look goes, by seconds since the state began and the state it came from. Rest uses the second:
   * coming back from the quote module, attention stays on it a moment before returning to the visitor.
   */
  readonly attention: (elapsed: number, from: RobotState) => LookTarget;
  readonly head: HeadDynamics;
  readonly eyes: EyeDynamics;
  /** The expression the face settles to, and the seconds it takes to get there. */
  readonly face: Expression;
  readonly faceTime: number;
  readonly lean: number;
  readonly turn: number;
  readonly chin: number;
  /** A tilt of the head held through the state: towards the visitor in welcome, the other way in concern. */
  readonly roll: number;
  /** Depth of the idle load cycle: 1 at rest, shallower while working. */
  readonly breath: number;
  /** Whether spontaneous blinks may happen. A machine holding a confirmation does not blink through it. */
  readonly blinks: boolean;
  /** Steady glow of the orange accents (the rings of light in the ear cups). */
  readonly accent: number;
  /** Seconds the body takes to settle into this state. */
  readonly settle: number;
  /** Whether posture drifts and settles on its own. Only at rest: working, the body holds still. */
  readonly drift: boolean;
}

/**
 * States whose end hands attention back through the module rather than straight to the visitor. Not the call to
 * action: attention there is a glance, and leaving it is simply returning.
 */
const RETURNS_THROUGH_MODULE: ReadonlySet<RobotState> = new Set<RobotState>(['value', 'direction', 'rate', 'problem', 'waiting']);

const REST_ACCENT = 0.3;

export const STATES: Record<RobotState, StateSpec> = {
  idle: {
    attention: (elapsed, from) => (RETURNS_THROUGH_MODULE.has(from) && elapsed < DURATION.linger ? 'panel' : 'viewer'),
    // The return to rest is the slowest, softest movement the robot makes: nothing is asking for its attention.
    head: { yaw: 0.78, pitch: 0.88, share: 0.5, ease: 0.42 },
    eyes: { aperture: 1, time: 0.3, gain: 1, notice: false, focus: 0 },
    face: EXPRESSIONS.neutral,
    faceTime: 0.3,
    lean: 0,
    turn: 0,
    chin: 0,
    roll: 0,
    breath: 1,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.9,
    drift: true,
  },
  welcome: {
    // A greeting is for the visitor: face them, lift a touch, tilt the head towards them — and smile.
    attention: () => 'viewer',
    head: { yaw: 0.5, pitch: 0.56, share: 0.5, ease: 0.3 },
    eyes: { aperture: 1, time: 0.2, gain: 1.08, notice: false, focus: 0 },
    face: EXPRESSIONS.welcome,
    faceTime: 0.12,
    lean: -0.008,
    turn: 0,
    chin: 0.02,
    roll: 0.05,
    breath: 0.8,
    blinks: false,
    accent: 0.55,
    settle: 0.45,
    drift: false,
  },
  value: {
    attention: () => 'amount',
    // Reading a number being typed: a soft, deliberate start to the turn; the eyes arrive well before the head,
    // narrow to read, focus once, briefly, and then simply watch.
    head: { yaw: 0.46, pitch: 0.54, share: 0.45, ease: 0.45 },
    eyes: { aperture: 0.95, time: 0.18, gain: 1.04, notice: false, focus: 0.1 },
    face: EXPRESSIONS.verifying,
    faceTime: 0.16,
    lean: 0.006,
    turn: 0.012,
    chin: -0.01,
    roll: 0,
    breath: 0.75,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.5,
    drift: false,
  },
  direction: {
    attention: () => 'toggle',
    // A switch was thrown: a quicker turn with a crisp start, and the optics shift state without a flourish.
    head: { yaw: 0.32, pitch: 0.42, share: 0.55, ease: 0.18 },
    eyes: { aperture: 0.96, time: 0.3, gain: 1.03, notice: false, focus: 0 },
    face: EXPRESSIONS.neutral,
    faceTime: 0.2,
    lean: 0,
    // Signed by the flow at runtime: towards the side value is moving to.
    turn: 0.02,
    chin: 0,
    roll: 0,
    breath: 0.9,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.55,
    drift: false,
  },
  rate: {
    attention: () => 'rate',
    head: { yaw: 0.4, pitch: 0.48, share: 0.5, ease: 0.3 },
    eyes: { aperture: 0.84, time: 0.14, gain: 1.1, notice: true, focus: 0 },
    face: EXPRESSIONS.verifying,
    faceTime: 0.16,
    lean: 0.006,
    turn: 0.015,
    chin: 0,
    roll: 0,
    breath: 0.75,
    blinks: false,
    accent: REST_ACCENT,
    settle: 0.4,
    drift: false,
  },
  locked: {
    // Confirm the figure, then hold the visitor's eye: the deal is done and the robot is sure of it.
    attention: (elapsed) => (elapsed < 0.35 ? 'rate' : 'viewer'),
    // Firm and direct: the glance is brief and the return to the visitor is decided, not drifted.
    head: { yaw: 0.42, pitch: 0.5, share: 0.5, ease: 0.3 },
    eyes: { aperture: 1, time: 0.25, gain: 1.12, notice: true, focus: 0 },
    face: EXPRESSIONS.success,
    faceTime: 0.22,
    lean: -0.01,
    turn: 0,
    chin: 0.02,
    roll: 0,
    breath: 0.5,
    blinks: false,
    accent: 0.5,
    settle: 0.7,
    drift: false,
  },
  accepted: {
    // Sent and taken: a glance at where it went, then the visitor — pleased, level, a small nod (`behaviour.ts`).
    attention: (elapsed) => (elapsed < 0.3 ? 'panel' : 'viewer'),
    head: { yaw: 0.42, pitch: 0.5, share: 0.5, ease: 0.3 },
    eyes: { aperture: 1, time: 0.25, gain: 1.1, notice: true, focus: 0 },
    face: EXPRESSIONS.success,
    faceTime: 0.22,
    lean: -0.01,
    turn: 0,
    chin: 0.018,
    roll: 0,
    breath: 0.6,
    blinks: false,
    accent: 0.5,
    settle: 0.7,
    drift: false,
  },
  problem: {
    // Attention straight to what needs changing, the head leaning in a little and tilting away — concern, not
    // reproach. The optics open a touch; the antenna's tip lights (`behaviour.ts` blinks it twice, then holds).
    attention: () => 'amount',
    head: { yaw: 0.4, pitch: 0.48, share: 0.5, ease: 0.25 },
    eyes: { aperture: 1.06, time: 0.18, gain: 1.06, notice: true, focus: 0 },
    face: EXPRESSIONS.alert,
    faceTime: 0.16,
    lean: 0.012,
    turn: 0.01,
    chin: -0.006,
    roll: -0.035,
    breath: 0.7,
    blinks: false,
    accent: 0.45,
    settle: 0.45,
    drift: false,
  },
  waiting: {
    // Waiting with the visitor on what they asked for: eyes on where the answer will appear, the head tilted a
    // little, breathing slowly. Patient — nothing hurries, and nothing loops faster than a slow breath.
    attention: () => 'panel',
    head: { yaw: 0.6, pitch: 0.7, share: 0.4, ease: 0.42 },
    eyes: { aperture: 1, time: 0.3, gain: 1, notice: false, focus: 0 },
    face: EXPRESSIONS.waiting,
    faceTime: 0.28,
    lean: 0.004,
    turn: 0.01,
    chin: -0.008,
    roll: 0.025,
    breath: 1.1,
    blinks: false,
    accent: REST_ACCENT,
    settle: 0.8,
    drift: false,
  },
  intent: {
    attention: () => 'cta',
    // A shift of attention, not a gesture: the eyes go to the button, the head follows only a little, and the
    // body, the optics and the lights stay exactly as they were.
    head: { yaw: 0.5, pitch: 0.56, share: 0.22, ease: 0.3 },
    eyes: { aperture: 1, time: 0.25, gain: 1, notice: false, focus: 0 },
    face: EXPRESSIONS.neutral,
    faceTime: 0.3,
    lean: 0,
    turn: 0,
    chin: 0,
    roll: 0,
    breath: 1,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.6,
    drift: false,
  },
  entry: {
    attention: () => 'entry',
    // The same glance as `intent`, carried almost entirely by the eyes: the masthead is far from the module, and
    // a head that swung up to it would be a gesture. The body, the optics and the lights stay as they were.
    head: { yaw: 0.5, pitch: 0.56, share: 0.14, ease: 0.3 },
    eyes: { aperture: 1, time: 0.25, gain: 1, notice: false, focus: 0 },
    face: EXPRESSIONS.neutral,
    faceTime: 0.3,
    lean: 0,
    turn: 0,
    chin: 0,
    roll: 0,
    breath: 1,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.6,
    drift: false,
  },
  // Stands in for the line being spoken: the behaviour uses that line's own spec from `speech.ts`.
  speaking: {
    attention: () => 'viewer',
    head: { yaw: 0.5, pitch: 0.56, share: 0.5, ease: 0.3 },
    eyes: { aperture: 1, time: 0.25, gain: 1, notice: false, focus: 0 },
    face: EXPRESSIONS.neutral,
    faceTime: 0.2,
    lean: 0,
    turn: 0,
    chin: 0,
    roll: 0,
    breath: 0.6,
    blinks: false,
    accent: REST_ACCENT,
    settle: 0.5,
    drift: false,
  },
};

/** How long event-driven states last before the robot returns to rest (value lasts until it has confirmed). */
export const DURATION = {
  welcome: 1.7,
  direction: 0.7,
  rate: 1.0,
  locked: 2.8,
  accepted: 2.6,
  problem: 2.6,
  /** The longest the robot will wait on something that never answers before it lets the wait go. */
  waiting: 30,
  /** Quiet time after the last keystroke before a typed value counts as settled. */
  typedSettle: 0.55,
  /** The same for a value set in one step. */
  settledSettle: 0.25,
  /** How long attention stays on the amount after the confirmation. */
  confirmHold: 0.2,
  /** How long attention rests on the module, after working in it, before returning to the visitor. */
  linger: 0.8,
} as const;
