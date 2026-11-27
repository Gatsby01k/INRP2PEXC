/**
 * What the robot does in each state of a quote, written down as targets.
 *
 * A state names where attention goes, which expression its face settles to, and what the body settles to — how the
 * head moves, how the optics respond, how the torso is oriented — and the behaviour eases the body towards those
 * numbers, critically damped, from wherever it happens to be. The robot is a character, not an instrument: it greets
 * with a wave, follows the visitor's pointer, is visibly impressed by a large amount, leans in when the visitor is
 * about to ask for a price, and is delighted when something is accepted. Its gestures (`behaviour.ts`) play over
 * the state it is in.
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
  /*
   * The workspace's held states: each is what the robot rests in while a mood lasts (`cues.ts` `RobotMood`). A held
   * `waiting` is `waiting` itself; the others have no event of their own to borrow from.
   */
  /** A firm quote is live: attention on the price, the optics focused, the accents a touch brighter. */
  | 'focused'
  /** Money seen and being confirmed: reading, with a pass of light through the eyes every few seconds. */
  | 'checking'
  /** Settled: the pleased face, held, the body at rest around it. */
  | 'done'
  /** Something needs the client: concern, the antenna's tip lit and held. */
  | 'attention'
  /** The workspace with nothing live: rest, standing by, turned a touch towards the page. */
  | 'ready'
  /** A large amount has just settled: eyes wide, chin up, rocked back a little — impressed. */
  | 'wow'
  /** An ordinary amount has just settled: a pleased look at it, then at the visitor. */
  | 'pleased'
  /** At rest, the robot reads the page's headline for a moment, head tilted — curious. */
  | 'curious'
  /*
   * The home page's character (docs/ROBOT_BEHAVIOUR.md): what it does about the visitor rather than the quote. None of
   * these happens while a state of record holds, so the workspace never sees them.
   */
  /** A very large amount has just settled: star eyes, two hops — star-struck. */
  | 'starstruck'
  /** The visitor has stayed on the call to action a while: hearts for it, and a little bounce. */
  | 'smitten'
  /** The visitor pressed the call to action: hearts beating, both arms up, a bounce. */
  | 'delight'
  /** The page is scrolling down past the robot: it looks down after the visitor, curious. */
  | 'watching'
  /** Back at the top after reading: a lean towards the converter — the next step — with the visor pointing at it. */
  | 'invite'
  /** Left alone a long while: the lids grow heavy and the head sinks; once, it catches itself. */
  | 'drowsy'
  /** Asleep: the eyes closed, Z's rising, the lights down, breathing deeply. */
  | 'asleep'
  /** Woken: the eyes snap wide, a hop, two blinks — and then a greeting. */
  | 'startled'
  /** Poked: the eyes squeezed into happy arcs, a blush, a jiggle. */
  | 'giggle'
  /** The pointer resting on its head: happy closed eyes, a blush, the head leaning into it. */
  | 'content'
  /** The pointer has left the window through its top edge: puppy eyes, looking up after it. */
  | 'pleading';

/**
 * The places attention can go. The page supplies where they are; `viewer` is the camera. `entry` is the one
 * target outside the hero: the masthead's way into the workspace.
 */
export type LookTarget = 'viewer' | 'panel' | 'amount' | 'toggle' | 'rate' | 'cta' | 'entry' | 'pointer' | 'title' | 'reading' | 'exit';

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
  pointer: 'viewer',
  title: 'viewer',
  /** Where the visitor is reading once the page has scrolled on past the robot: the middle of the window below it. */
  reading: 'viewer',
  /** Where the pointer left the window: at its top edge, above the last place it was. */
  exit: 'viewer',
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
  /** Eyes opened wide and round: surprise. */
  readonly wide: number;
  /** Eyes become hearts. */
  readonly heart: number;
  /** Eyes become five-pointed stars. */
  readonly star: number;
  /** A blush under each eye: a soft glow and three short strokes. */
  readonly blush: number;
  /** Asleep: Z's rising from the corner of the visor. */
  readonly sleep: number;
}

export type ExpressionName =
  | 'neutral'
  | 'welcome'
  | 'verifying'
  | 'waiting'
  | 'success'
  | 'alert'
  | 'excited'
  | 'wow'
  | 'love'
  | 'curious'
  | 'starstruck'
  | 'smitten'
  | 'drowsy'
  | 'asleep'
  | 'startled'
  | 'giggle'
  | 'content'
  | 'pleading'
  | 'watching';

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
 *
 * The home page's character (docs/ROBOT_BEHAVIOUR.md) adds a few more from the same numbers and three new shapes —
 * stars, a blush, the Z's of sleep: star-struck, smitten, drowsy, asleep, startled, giggling, content, pleading and
 * watching. None of them is ever a state of record.
 */
const FACE = { smile: 0, lid: 0, tilt: 0, squint: 0, dots: 0, beacon: 0, wide: 0, heart: 0, star: 0, blush: 0, sleep: 0 } as const;

export const EXPRESSIONS: Record<ExpressionName, Expression> = {
  neutral: FACE,
  welcome: { ...FACE, smile: 1 },
  verifying: { ...FACE, lid: 0.08, tilt: 0.05, squint: 0.85 },
  waiting: { ...FACE, dots: 1 },
  success: { ...FACE, smile: 0.5 },
  alert: { ...FACE, lid: 0.14, tilt: -0.4, beacon: 0.7 },
  /** About to be asked for a price: bright, a little wide, smiling. */
  excited: { ...FACE, smile: 0.42, wide: 0.35, beacon: 0.25 },
  /** Impressed: wide, round eyes and the antenna lit. */
  wow: { ...FACE, wide: 1, beacon: 0.8 },
  /** Delighted: two hearts. */
  love: { ...FACE, heart: 1, beacon: 0.4 },
  /** Reading something interesting: the inner ends of the lids lifted a touch. */
  curious: { ...FACE, lid: 0.06, tilt: -0.22, wide: 0.15 },
  /** A whale: two stars, the antenna blazing. */
  starstruck: { ...FACE, star: 1, beacon: 1 },
  /** Fond of the button the visitor is on: hearts and a light blush. */
  smitten: { ...FACE, heart: 1, blush: 0.45, beacon: 0.35 },
  /** Heavy lids, sloping down at their inner ends: the look of someone fighting sleep. */
  drowsy: { ...FACE, lid: 0.48, tilt: 0.12 },
  /** Closed: the lids flat (`eyes.aperture` closes them), Z's rising. */
  asleep: { ...FACE, sleep: 1 },
  /** Woken with a start: round eyes, the small round mouth, the antenna lit. */
  startled: { ...FACE, wide: 1, beacon: 0.6 },
  /** Giggling: squeezed happy arcs and a full blush. */
  giggle: { ...FACE, smile: 1, blush: 1 },
  /** Being patted: happy arcs, a softer blush. */
  content: { ...FACE, smile: 1, blush: 0.7 },
  /** Puppy eyes: wide, the inner ends of the lids raised high. */
  pleading: { ...FACE, wide: 0.5, lid: 0.12, tilt: -0.6 },
  /** Watching the visitor go down the page: the inner lids lifted, a little wide — interested. */
  watching: { ...FACE, lid: 0.04, tilt: -0.3, wide: 0.22 },
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
    lean: -0.025,
    turn: 0,
    chin: 0.06,
    roll: 0.13,
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
    face: EXPRESSIONS.success,
    faceTime: 0.16,
    lean: 0,
    // Signed by the flow at runtime: towards the side value is moving to.
    turn: 0.06,
    chin: 0.02,
    roll: 0.07,
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
    face: EXPRESSIONS.love,
    faceTime: 0.22,
    lean: -0.02,
    turn: 0,
    chin: 0.05,
    roll: 0.06,
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
    face: EXPRESSIONS.love,
    faceTime: 0.22,
    lean: -0.02,
    turn: 0,
    chin: 0.05,
    roll: 0.06,
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
    lean: 0.03,
    turn: 0.02,
    chin: -0.02,
    roll: -0.09,
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
    // The visitor is about to ask for a price: the robot lights up — eyes on the button, leaning in towards it,
    // smiling, the accents brightening.
    head: { yaw: 0.4, pitch: 0.46, share: 0.45, ease: 0.25 },
    eyes: { aperture: 1.04, time: 0.2, gain: 1.15, notice: true, focus: 0 },
    face: EXPRESSIONS.excited,
    faceTime: 0.18,
    lean: 0.035,
    turn: 0.05,
    chin: 0,
    roll: 0.05,
    breath: 0.9,
    blinks: true,
    accent: 0.75,
    settle: 0.45,
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
  focused: {
    // Watching a live price with the client: the eyes stay on it and the head carries little of the look, so
    // it reads as attention rather than a turn. Blinks are allowed — a quote can be live for minutes.
    attention: () => 'rate',
    head: { yaw: 0.5, pitch: 0.56, share: 0.35, ease: 0.35 },
    eyes: { aperture: 0.9, time: 0.3, gain: 1.08, notice: true, focus: 0 },
    face: EXPRESSIONS.neutral,
    faceTime: 0.3,
    lean: 0.006,
    turn: 0.012,
    chin: -0.004,
    roll: 0,
    breath: 0.8,
    blinks: true,
    accent: 0.45,
    settle: 0.8,
    drift: false,
  },
  ready: {
    // Rest, as a working posture rather than a showroom one: the same slow load cycle, corrections and drift as
    // idle, with the body turned a touch towards the page it serves and the accents a shade warmer. It returns
    // through the page after work in it, exactly as idle does.
    attention: (elapsed, from) => (RETURNS_THROUGH_MODULE.has(from) && elapsed < DURATION.linger ? 'panel' : 'viewer'),
    head: { yaw: 0.78, pitch: 0.88, share: 0.5, ease: 0.42 },
    eyes: { aperture: 1, time: 0.3, gain: 1, notice: false, focus: 0 },
    face: EXPRESSIONS.neutral,
    faceTime: 0.3,
    lean: 0.003,
    turn: 0.008,
    chin: 0,
    roll: 0,
    breath: 1,
    blinks: true,
    accent: 0.34,
    settle: 0.9,
    drift: true,
  },
  checking: {
    // The reading face of `value`, held: narrowed optics on the trade, the head a little down to it. The band of
    // light passes through the eyes now and then, at irregular intervals of several seconds (`behaviour.ts`).
    attention: () => 'panel',
    head: { yaw: 0.55, pitch: 0.62, share: 0.4, ease: 0.4 },
    eyes: { aperture: 0.95, time: 0.3, gain: 1.04, notice: false, focus: 0 },
    face: EXPRESSIONS.verifying,
    faceTime: 0.3,
    lean: 0.006,
    turn: 0.01,
    chin: -0.01,
    roll: 0,
    breath: 0.8,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.8,
    drift: false,
  },
  done: {
    // The pleased face of `accepted`, held for as long as the trade is settled — so the body is allowed to rest,
    // blink and drift around it; nothing else is asked of it.
    attention: () => 'viewer',
    head: { yaw: 0.6, pitch: 0.7, share: 0.5, ease: 0.4 },
    eyes: { aperture: 1, time: 0.3, gain: 1.06, notice: false, focus: 0 },
    face: EXPRESSIONS.success,
    faceTime: 0.3,
    lean: -0.006,
    turn: 0,
    chin: 0.012,
    roll: 0,
    breath: 0.9,
    blinks: true,
    accent: 0.42,
    settle: 0.9,
    drift: true,
  },
  attention: {
    // Concern, held: a look at what needs the client first, then the client. The tip's two blinks happen once, as
    // the mood arrives (`behaviour.ts`); its steady glow is the expression's own, and lasts as long as the mood.
    attention: (elapsed) => (elapsed < 1.2 ? 'panel' : 'viewer'),
    head: { yaw: 0.5, pitch: 0.56, share: 0.5, ease: 0.3 },
    eyes: { aperture: 1.04, time: 0.25, gain: 1.04, notice: true, focus: 0 },
    face: EXPRESSIONS.alert,
    faceTime: 0.2,
    lean: 0.008,
    turn: 0,
    chin: -0.004,
    roll: -0.03,
    breath: 0.8,
    blinks: true,
    accent: 0.4,
    settle: 0.6,
    drift: false,
  },
  wow: {
    // A large amount: a look at it, then at the visitor — eyes wide, chin up, rocked back on the heels.
    attention: (elapsed) => (elapsed < 0.5 ? 'amount' : 'viewer'),
    head: { yaw: 0.36, pitch: 0.42, share: 0.55, ease: 0.2 },
    eyes: { aperture: 1.08, time: 0.12, gain: 1.2, notice: true, focus: 0 },
    face: EXPRESSIONS.wow,
    faceTime: 0.1,
    lean: -0.045,
    turn: 0,
    chin: 0.09,
    roll: -0.04,
    breath: 0.6,
    blinks: false,
    accent: 0.8,
    settle: 0.35,
    drift: false,
  },
  pleased: {
    // An amount settled: a pleased look at it, with a nod, then straight back to the visitor.
    attention: (elapsed) => (elapsed < 0.6 ? 'amount' : 'viewer'),
    head: { yaw: 0.42, pitch: 0.5, share: 0.5, ease: 0.3 },
    eyes: { aperture: 1, time: 0.2, gain: 1.08, notice: true, focus: 0 },
    face: EXPRESSIONS.success,
    faceTime: 0.18,
    lean: -0.01,
    turn: 0,
    chin: 0.03,
    roll: 0.05,
    breath: 0.8,
    blinks: false,
    accent: 0.5,
    settle: 0.5,
    drift: false,
  },
  curious: {
    // Reading the headline beside it, head well over to one side — the way a person reads something interesting.
    attention: () => 'title',
    head: { yaw: 0.55, pitch: 0.6, share: 0.6, ease: 0.35 },
    eyes: { aperture: 1, time: 0.25, gain: 1.04, notice: false, focus: 0 },
    face: EXPRESSIONS.curious,
    faceTime: 0.25,
    lean: 0.01,
    turn: -0.03,
    chin: 0.01,
    roll: -0.14,
    breath: 0.9,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.6,
    drift: false,
  },
  starstruck: {
    // A whale: a look at the amount, then at the visitor, eyes turned to stars — rocked back further than `wow`.
    attention: (elapsed) => (elapsed < 0.4 ? 'amount' : 'viewer'),
    head: { yaw: 0.34, pitch: 0.4, share: 0.55, ease: 0.2 },
    eyes: { aperture: 1.08, time: 0.12, gain: 1.28, notice: true, focus: 0 },
    face: EXPRESSIONS.starstruck,
    faceTime: 0.1,
    lean: -0.05,
    turn: 0,
    chin: 0.11,
    roll: 0.05,
    breath: 0.6,
    blinks: false,
    accent: 0.95,
    settle: 0.35,
    drift: false,
  },
  smitten: {
    // Still on the button, eyes and all — but now fond of it: hearts, a blush, the head tilted towards it.
    attention: () => 'cta',
    head: { yaw: 0.45, pitch: 0.5, share: 0.45, ease: 0.3 },
    eyes: { aperture: 1.04, time: 0.2, gain: 1.15, notice: false, focus: 0 },
    face: EXPRESSIONS.smitten,
    faceTime: 0.2,
    lean: 0.04,
    turn: 0.05,
    chin: 0.02,
    roll: 0.1,
    breath: 0.9,
    blinks: false,
    accent: 0.8,
    settle: 0.5,
    drift: false,
  },
  delight: {
    // The visitor asked for a price: face them, chin up, hearts beating, both arms up (`behaviour.ts`).
    attention: () => 'viewer',
    head: { yaw: 0.36, pitch: 0.42, share: 0.5, ease: 0.2 },
    eyes: { aperture: 1.06, time: 0.12, gain: 1.25, notice: true, focus: 0 },
    face: EXPRESSIONS.smitten,
    faceTime: 0.1,
    lean: -0.035,
    turn: 0,
    chin: 0.09,
    roll: 0.06,
    breath: 0.6,
    blinks: false,
    accent: 0.95,
    settle: 0.35,
    drift: false,
  },
  watching: {
    // The page going down past it: eyes after the visitor, leaning a touch to see, interested rather than sad.
    attention: () => 'reading',
    head: { yaw: 0.5, pitch: 0.5, share: 0.55, ease: 0.3 },
    eyes: { aperture: 1.02, time: 0.2, gain: 1.04, notice: false, focus: 0 },
    face: EXPRESSIONS.watching,
    faceTime: 0.25,
    lean: 0.035,
    turn: 0,
    chin: -0.07,
    roll: 0.06,
    breath: 0.9,
    blinks: true,
    accent: REST_ACCENT,
    settle: 0.6,
    drift: false,
  },
  invite: {
    // Back at the top: lean towards the converter and look at its amount — the next step — eager.
    attention: () => 'amount',
    head: { yaw: 0.4, pitch: 0.46, share: 0.5, ease: 0.25 },
    eyes: { aperture: 1.04, time: 0.2, gain: 1.12, notice: true, focus: 0 },
    face: EXPRESSIONS.excited,
    faceTime: 0.18,
    lean: 0.035,
    turn: 0.05,
    chin: 0,
    roll: 0.05,
    breath: 0.9,
    blinks: true,
    accent: 0.6,
    settle: 0.45,
    drift: false,
  },
  drowsy: {
    // Fighting sleep: the lids heavy, the head sinking slowly, the lights fading. The catch is `behaviour.ts`'s.
    attention: () => 'viewer',
    head: { yaw: 1.2, pitch: 1.6, share: 0.5, ease: 0.5 },
    eyes: { aperture: 0.8, time: 1.6, gain: 0.9, notice: false, focus: 0 },
    face: EXPRESSIONS.drowsy,
    faceTime: 1.8,
    lean: 0.012,
    turn: 0,
    chin: -0.07,
    roll: 0.04,
    breath: 1.3,
    blinks: true,
    accent: 0.16,
    settle: 2.2,
    drift: false,
  },
  asleep: {
    // Asleep: the eyes shut, the head down and to one side, the lights all but out, breathing deeply and slowly.
    attention: () => 'viewer',
    head: { yaw: 1.4, pitch: 1.8, share: 0.5, ease: 0.5 },
    eyes: { aperture: 0.12, time: 0.9, gain: 0.8, notice: false, focus: 0 },
    face: EXPRESSIONS.asleep,
    faceTime: 1.2,
    lean: 0.02,
    turn: 0,
    chin: -0.13,
    roll: 0.1,
    breath: 1.8,
    blinks: false,
    accent: 0.06,
    settle: 2.4,
    drift: false,
  },
  startled: {
    // Woken: everything snaps — eyes round, head up, the lights back on at once.
    attention: () => 'viewer',
    head: { yaw: 0.22, pitch: 0.26, share: 0.55, ease: 0.12 },
    eyes: { aperture: 1.1, time: 0.06, gain: 1.25, notice: true, focus: 0 },
    face: EXPRESSIONS.startled,
    faceTime: 0.06,
    lean: -0.04,
    turn: 0,
    chin: 0.08,
    roll: 0,
    breath: 0.5,
    blinks: false,
    accent: 0.7,
    settle: 0.22,
    drift: false,
  },
  giggle: {
    // Poked: it squeezes its eyes shut laughing, blushes and jiggles (`behaviour.ts`), facing whoever poked it.
    attention: () => 'pointer',
    head: { yaw: 0.36, pitch: 0.42, share: 0.55, ease: 0.2 },
    eyes: { aperture: 1, time: 0.1, gain: 1.15, notice: false, focus: 0 },
    face: EXPRESSIONS.giggle,
    faceTime: 0.08,
    lean: -0.02,
    turn: 0,
    chin: 0.05,
    roll: 0.08,
    breath: 0.6,
    blinks: false,
    accent: 0.6,
    settle: 0.35,
    drift: false,
  },
  content: {
    // Patted: eyes closed happily, a blush, the head leaning up into the hand.
    attention: () => 'pointer',
    head: { yaw: 0.7, pitch: 0.8, share: 0.6, ease: 0.45 },
    eyes: { aperture: 1, time: 0.3, gain: 1.08, notice: false, focus: 0 },
    face: EXPRESSIONS.content,
    faceTime: 0.35,
    lean: -0.01,
    turn: 0,
    chin: 0.05,
    roll: 0.12,
    breath: 1.2,
    blinks: false,
    accent: 0.5,
    settle: 0.8,
    drift: false,
  },
  pleading: {
    // The pointer has gone up out of the window: puppy eyes after it, the head tilted — "don't go".
    attention: () => 'exit',
    head: { yaw: 0.55, pitch: 0.6, share: 0.6, ease: 0.35 },
    eyes: { aperture: 1.06, time: 0.25, gain: 1.1, notice: true, focus: 0 },
    face: EXPRESSIONS.pleading,
    faceTime: 0.3,
    lean: -0.01,
    turn: 0,
    chin: 0.03,
    roll: -0.12,
    breath: 0.8,
    blinks: true,
    accent: 0.45,
    settle: 0.6,
    drift: false,
  },
};

/** How long event-driven states last before the robot returns to rest (value lasts until it has confirmed). */
export const DURATION = {
  welcome: 2.3,
  wow: 1.9,
  pleased: 1.1,
  curious: 1.8,
  /** Amounts from this many USDT up impress the robot. */
  impressive: 250_000,
  /** And from this many, it is star-struck. */
  stellar: 1_000_000,
  starstruck: 2.3,
  /** How long the visitor stays on the call to action before the robot's eyes turn to hearts for it. */
  smitten: 1.8,
  delight: 2.6,
  /** How long the robot keeps watching after the page stops scrolling down. */
  watching: 1.1,
  invite: 1.9,
  /** Quiet seconds before the robot grows drowsy, and before it is asleep. */
  drowsy: 40,
  asleep: 47,
  startled: 1.15,
  giggle: 1.35,
  /** How long the pointer rests on the head before the robot leans into it. */
  pat: 0.8,
  direction: 0.7,
  rate: 1.0,
  locked: 2.8,
  accepted: 2.6,
  problem: 2.6,
  /** The longest the robot will wait on something that never answers before it lets the wait go. */
  waiting: 30,
  /**
   * Quiet time after the last keystroke before a typed value counts as settled. Long enough that the pause a
   * person leaves between digits of one number does not read as a finished number: one number, one response.
   */
  typedSettle: 1.0,
  /** The same for a value set in one step. */
  settledSettle: 0.25,
  /** How long attention stays on the amount after the confirmation. */
  confirmHold: 0.45,
  /** How long attention rests on the module, after working in it, before returning to the visitor. */
  linger: 0.8,
} as const;
