import type { Direction } from '@inrp2p/kernel';
import { INPUT_PRIORITY, MOOD_PRIORITY, type RobotCue, type RobotFocus, type RobotMood } from './cues.ts';
import { between, blinkOpenness, clamp, envelope, follow, follower, loadCycle } from './motion.ts';
import { DURATION, LOOK_FALLBACK, type LookTarget, type RobotState, type StateSpec, STATES } from './states.ts';

export type { LookTarget, RobotState } from './states.ts';

/**
 * The robot's state machine: quote events in, a pose out, once per frame.
 *
 * One state at a time, chosen by what just happened to the quote (`states.ts` says what each asks of the body).
 * Events start short states that end on their own and hand back to rest; what the visitor is on — the call to
 * action, or the masthead's way into the workspace — is the only sustained input. Every transition is an ease towards new targets from wherever the body is — never a clip —
 * so the robot can be interrupted mid-response and still move directly and calmly to the next one.
 *
 * In the workspace a second sustained input sets what "rest" is: the mood (`cues.ts` `RobotMood`), the state of
 * record the page's server data is in. The robot rests in the mood's held state instead of idle, marks the
 * mood's arrival once, and lets events play over it as before. The home page sets no mood, so nothing changes there.
 *
 * The body moves as one connected mechanism, each link driven by the one above it: the eyes reach a new target
 * first; the head takes up the aim and follows, softly or crisply depending on what asked; the neck finishes the
 * turn a moment later, leaning into it while it moves; the chest and shoulders come round last, by a fraction of
 * the look, and the arms trail the chest. Every link is critically damped — nothing overshoots, nothing swings
 * back — so a turn ends in stillness, not in a wobble.
 *
 * At rest the robot holds position the way a precise machine does: a slow load cycle whose length and depth vary
 * from one cycle to the next, a small correction of posture every few seconds at irregular intervals, and a
 * slower drift of weight. None of it repeats on a period an eye could learn.
 *
 * The face shows the state's expression (`states.ts` `EXPRESSIONS`): a greeting when it comes online and when the
 * visitor starts, reading while a value changes, wide eyes for a large amount, waiting while something is on its way,
 * hearts when something is accepted, and concern when something needs changing. Each is a state's target like any
 * other, eased into from wherever the face is.
 *
 * Gestures play over whatever state the robot is in, each once, from an event: a wave with its greeting, a hop for
 * a new direction, a large amount or an accepted request, a shake of the head for a problem. At rest it follows the
 * visitor's pointer, and every few seconds, at irregular intervals, does something of its own — winks, reads the
 * headline beside it, glances at the quote module and nods, hops, or waves.
 *
 * Lights run on their own clock: one short, faint sweep of the emblem when a value is confirmed or the direction
 * changes, a pulse at its hub for a new rate, the whole mark resolving when a rate locks or a request is accepted, a
 * band of light through the eyes for each change read, and the antenna's tip — one soft pulse for a greeting, two
 * blinks and a steady glow for a problem. Each starts at an event and ends.
 *
 * On the home page it also attends to the visitor as a whole (docs/ROBOT_BEHAVIOUR.md, `presence.ts`): it watches them
 * scroll on and looks at what they read, welcomes them back to the tab or to the top and shows them the next step, is
 * star-struck by a very large amount, grows fond of a call to action they linger on and celebrates when they press it,
 * dozes off when left alone and wakes with a start, giggles when poked, leans into a pat, and makes puppy eyes when the
 * pointer heads for the tabs. None of it happens while a state of record holds, so the workspace never sees it. The
 * antenna, a thin stem with a weight on its tip, is the one part allowed to sway: it trails the head and settles.
 *
 * Pure: time, focus and where things are come in; the frame loop owns the scene.
 */

/** Where a target is, as seen from the head: yaw to the robot's left (the visitor's right) and pitch upward. */
export interface LookAngles {
  readonly yaw: number;
  readonly pitch: number;
}

export interface BehaviourInput {
  /** Seconds since the robot started. */
  readonly time: number;
  readonly dt: number;
  readonly focus: RobotFocus;
  /** Look angles for a target, or null when that target is not on the page. */
  readonly angles: (target: LookTarget) => LookAngles | null;
  /** The visitor's pointer moved a moment ago: at rest, the robot's eyes follow it. */
  readonly pointer?: boolean;
  /** What the visitor is doing on the page as a whole (`presence.ts`); absent where nothing watches (the workspace). */
  readonly presence?: Presence;
}

/** The visitor on the page as a whole, as the frame loop sees it (`presence.ts`, `scene.ts`). */
export interface Presence {
  /** Seconds since the visitor last moved, typed, touched or scrolled. */
  readonly quiet: number;
  /** 1 while the page scrolls down, -1 while it scrolls up, 0 when it is still. */
  readonly scrolling: -1 | 0 | 1;
  /** The page has scrolled on past the robot's head: what the visitor reads is below it. */
  readonly below: boolean;
  /** Seconds the pointer has rested on the robot's head; 0 while it is not on it. */
  readonly over: number;
  /** The pointer left the window through its top edge and is not back. */
  readonly leaving: boolean;
}

export interface Pose {
  /** The idle load cycle, 0 → 1, already scaled by its depth this cycle and by the state. */
  readonly load: number;
  /** The whole figure, turning from the hips: posture, lean and drift. */
  readonly torsoPitch: number;
  readonly torsoYaw: number;
  readonly torsoRoll: number;
  /** The chest and shoulders on their own pivot, following the neck and settling after it (pitch is a lean). */
  readonly chestPitch: number;
  readonly chestYaw: number;
  readonly chestRoll: number;
  /** The look's orientation, neck and head together. */
  readonly headYaw: number;
  readonly headPitch: number;
  readonly headRoll: number;
  /** The neck's part of the look. It trails the head, so a turn begins in the head and finishes in the neck. */
  readonly neckYaw: number;
  readonly neckPitch: number;
  /** The neck leaning into a turn while the head is moving; nothing once it has arrived. */
  readonly neckRoll: number;
  /** Eye offset across the visor, in shell units. */
  readonly gazeX: number;
  readonly gazeY: number;
  readonly eyeOpen: number;
  readonly eyeGain: number;
  /** The expression (`materials.ts` `FaceUniforms`): the lower lids' smile, the upper lids' drop and slope. */
  readonly smile: number;
  readonly lid: number;
  readonly lidTilt: number;
  readonly squint: number;
  /** A band of light passing through the eyes while reading: its strength, and where it is (0 → 1). */
  readonly scan: number;
  readonly scanAt: number;
  /** 0 two eyes, 1 three dots; and each dot's brightness, left to right. */
  readonly dots: number;
  readonly dotLevel: readonly [number, number, number];
  /** Glow of the antenna's tip: dark at rest, lit when the robot is asking for attention. */
  readonly beacon: number;
  /** The eye on the visitor's right smiled shut (0 → 1); the eyes opened wide (surprise); the eyes as hearts. */
  readonly wink: number;
  readonly wide: number;
  readonly heart: number;
  /** The eyes as five-pointed stars; a blush under them; asleep, with Z's rising (`zPhase` moves them). */
  readonly star: number;
  readonly blush: number;
  readonly sleep: number;
  readonly zPhase: number;
  /** The beat of hearts and stars: a double pulse, 0 → 1, while they are shown. */
  readonly beat: number;
  /** The whole figure lifted off its rest, in the figure's units: a hop. */
  readonly hop: number;
  /** The waving arm lifted (0 → 1), and its swing from the shoulder, in radians. */
  readonly waveLift: number;
  readonly waveSwing: number;
  /** Both arms up (0 → 1) — a cheer — and the small pump they make while up, in radians. */
  readonly cheer: number;
  readonly cheerPump: number;
  /** The antenna's sway on its stem, trailing the head: forward-back (pitch) and side to side (roll), in radians. */
  readonly antennaPitch: number;
  readonly antennaRoll: number;
  /**
   * How far the arms trail the body: sideways when it rolls (both arms alike), fore-and-aft when it leans, and
   * in opposition when the chest turns — the arm on the side turning away stays forward a moment.
   */
  readonly armSwing: number;
  readonly armPitch: number;
  readonly armTwist: number;
  /** Emissive strength of the orange accents (ear rings, arm stripes). */
  readonly accentGlow: number;
  /** Glow of the three chest arcs, in the mark's order: 30°, 270°, 150°. */
  readonly arcGlow: readonly [number, number, number];
  readonly hubGlow: number;
}

const MAX_YAW = 0.6;
const MAX_PITCH = 0.34;
/** How far the eyes can travel across the visor, in radians of look, and how that maps to shell units. */
const EYE_RANGE = 0.38;
const EYE_UNITS_X = 0.23;
const EYE_UNITS_Y = 0.17;
/** The neck's share of a look once the turn has finished. */
const NECK_SHARE = 0.35;
/** How much of the neck's turn and nod the chest takes up — a tenth or so of the whole look. */
const CHEST_OF_NECK_YAW = 0.3;
const CHEST_OF_NECK_PITCH = 0.25;

/**
 * The order the chest arcs light for each direction. Buying moves value from INR to USDT, left to right across
 * the mark (150° → 270° → 30°); selling moves it back. Indices are the arcs' slots in `arcGlow`.
 */
const SWEEP_ORDER: Record<Direction, readonly [number, number, number]> = {
  BUY_USDT: [2, 1, 0],
  SELL_USDT: [0, 1, 2],
};

/** The shortest gap between two emblem responses: a settled value may not repeat a light just seen. */
const RESPONSE_GAP = 1.2;

/**
 * Where the robot rests while a mood holds (`cues.ts` `RobotMood`) and the visitor is on nothing in particular.
 * Without a mood it rests as it always has; the home page never sets one.
 */
const MOOD_REST: Record<RobotMood, RobotState> = {
  none: 'idle',
  ready: 'ready',
  waiting: 'waiting',
  focused: 'focused',
  verifying: 'checking',
  success: 'done',
  alert: 'attention',
};

/** The gap between two passes of the reading band while a check is held: irregular, and never faster than this. */
const CHECK_SCAN = { min: 3.5, max: 6 } as const;

/** States a greeting may interrupt: only rest. Anything the visitor has started matters more than saying hello. */
const GREETS_FROM: ReadonlySet<RobotState> = new Set<RobotState>(['idle', 'ready', 'intent', 'entry']);

/** How long one pass of the reading band takes, and the shortest time between two passes. */
const SCAN = { duration: 0.55, gap: 0.5 } as const;

/** One breath of the waiting face: the dots brighten in turn over this many seconds. */
const WAIT_BREATH = 1.6;

/** The gestures. A wave lasts about two seconds and swings three times; a hop is short and low. */
const WAVE = { lift: 0.35, hold: 1.4, drop: 0.5, period: 0.62, swing: 0.32 } as const;
const HOP = { duration: 0.46, height: 0.075 } as const;
const SHAKE = { duration: 0.9, period: 0.3, yaw: 0.12 } as const;

/** At rest, the robot does something of its own every so often — never sooner after the visitor's last move. */
const PLAY = { min: 4.5, max: 8.5, quiet: 2.5 } as const;

/** States the robot plays in: rest, with nothing of the visitor's in hand. */
const PLAYS_IN: ReadonlySet<RobotState> = new Set<RobotState>(['idle', 'ready']);

/**
 * The home page's character (docs/ROBOT_BEHAVIOUR.md). Where it may act: rest and its moods of attention, never over
 * anything the visitor started. A bounce is two hops a beat apart; a cheer lifts both arms, pumps them and lowers them;
 * a giggle jiggles the head quickly side to side, dying away; the third poke in a short run gets hearts.
 */
const CHARACTER_IN: ReadonlySet<RobotState> = new Set<RobotState>(['idle', 'watching', 'drowsy', 'asleep', 'content', 'pleading']);
const BOUNCE_GAP = 0.52;
const CHEER = { lift: 0.26, hold: 1.3, drop: 0.55, period: 0.42, pump: 0.16 } as const;
const JIGGLE = { duration: 0.9, period: 0.17, roll: 0.07 } as const;
const POKES = { run: 3, within: 3 } as const;
/** Hearts and stars beat: a double pulse — lub, dub — once a period. */
const BEAT_PERIOD = 0.92;
/** How fast the Z's rise while asleep: three are in the air at once, each taking 1 / Z_RATE seconds. */
const Z_RATE = 0.34;
/**
 * The antenna: a weighted tip on a thin stem. Its natural frequency (rad/s) and damping ratio give one small,
 * quickly dying sway after the head moves; `drive` is how much the head's motion moves it, `hop` how much a hop does.
 */
const ANTENNA = { omega: 17, zeta: 0.24, drive: 0.07, hop: 0.32, limit: 0.3 } as const;

export class RobotBehaviour {
  private readonly random: () => number;

  private state: RobotState = 'idle';
  private from: RobotState = 'idle';
  private since = 0;
  private until = Number.POSITIVE_INFINITY;
  /**
   * Whether the current state is where the robot rests (and lasts until the rest changes), rather than one an
   * event started (and time ends). A held `waiting` rests; the same state from a `wait` cue does not.
   */
  private resting = true;
  private mood: RobotMood;
  /** -1 when the page's module is on the robot's right (the workspace) rather than its left (the home page). */
  private readonly side: 1 | -1;

  private direction: Direction;
  private valuePending = false;
  private confirmAt = 0;

  private target: LookTarget = 'viewer';
  /** Scales the timing of the current head move: longer for a longer move, never quite the same twice. */
  private moveScale = 1;
  private blinkAt = -10;
  private nextBlinkAt: number;

  // Rest: an irregular load cycle, small corrections at irregular intervals, and a slower drift of weight.
  private loadPhase = 0;
  private loadPeriod: number;
  private loadDepth: number;
  private correctUntil = 0;
  private correctPitch = 0;
  private correctRoll = 0;
  private driftUntil = 0;
  private driftRoll = 0;
  private driftYaw = 0;
  private driftHeadRoll = 0;

  // One-off responses, each started by an event and finished by its own envelope.
  private respondAt = -10;
  private sweepOrder: readonly [number, number, number];
  private pulseAt = -10;
  private resolveAt = -10;
  private noticeAt = -10;
  private focusAt = -10;
  private focusDepth = 0;
  /** When coming online, the greeting that follows the emblem's sweep. */
  private welcomeAt = Number.POSITIVE_INFINITY;
  private greetAt = -10;
  private alertAt = -10;
  private scanAt = -10;
  private nextCheckScan = 0;
  /** When attention last left a typed value, so a keystroke soon after continues that number rather than starting over. */
  private valueLeftAt = Number.NEGATIVE_INFINITY;
  private nodAt = -10;
  /** The amount the last value cue said, if it said one. */
  private amount: number | null = null;
  private waveAt = -10;
  private shakeAt = -10;
  private winkAt = -10;
  private grinAt = -10;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private nextPlayAt: number;
  /** The home page's character (docs/ROBOT_BEHAVIOUR.md). */
  private lastFocus: RobotFocus = 'none';
  /** When the visitor's focus came onto the call to action, while it is there. */
  private ctaSince = Number.POSITIVE_INFINITY;
  private hops: { at: number; height: number }[] = [];
  private blink2At = -10;
  private cheerAt = -10;
  private jiggleAt = -10;
  private catchAt = -10;
  private commitAt = -10;
  private pokes: number[] = [];
  /** A greeting owed once something else ends (waking up, refocusing on a tab), and a turn to the next step. */
  private greetAfterAt = Number.POSITIVE_INFINITY;
  private inviteAt = Number.POSITIVE_INFINITY;
  private zPhase = 0;
  private readonly antenna = { pitch: 0, roll: 0, vPitch: 0, vRoll: 0 };
  private readonly was = { pitch: 0, roll: 0, hop: 0 };
  /** Whether the robot does things of its own at rest: the live robot does; a still drawn for a sheet does not. */
  private readonly playful: boolean;

  /** Where the head is aimed: the look target, taken up first so a move starts as the state asks, not at once. */
  private readonly aimYaw = follower();
  private readonly aimPitch = follower();
  private readonly headYaw = follower();
  private readonly headPitch = follower();
  private readonly neckYaw = follower();
  private readonly neckPitch = follower();
  private readonly chestYaw = follower();
  private readonly chestPitch = follower();
  private readonly correctionPitch = follower();
  private readonly correctionRoll = follower();
  private readonly eyeYaw = follower();
  private readonly eyePitch = follower();
  private readonly lean = follower();
  private readonly turn = follower();
  private readonly chin = follower();
  private readonly roll = follower();
  private readonly headRollBias = follower();
  private readonly loadDepthOfState = follower(1);
  private readonly aperture = follower(1);
  private readonly gain = follower(1);
  private readonly accent = follower(STATES.idle.accent);
  private readonly armLagRoll = follower();
  private readonly armLagYaw = follower();
  private readonly armLagLean = follower();
  private readonly headTilt = follower();
  // The face: one follower per number of the rig, so every expression eases into every other.
  private readonly smile = follower();
  private readonly lid = follower();
  private readonly lidTilt = follower();
  private readonly squint = follower();
  private readonly dots = follower();
  private readonly beacon = follower();
  private readonly wide = follower();
  private readonly heart = follower();
  private readonly star = follower();
  private readonly blush = follower();
  private readonly sleep = follower();

  /**
   * `mirror` for a robot standing to the right of what it attends to. Its look is aimed at wherever things are on
   * the page either way; what flips is the little each state leans, turns and tilts relative to the module.
   */
  constructor(options: { direction: Direction; mood?: RobotMood; mirror?: boolean; wakeAt?: number; random?: () => number; playful?: boolean }) {
    this.side = options.mirror ? -1 : 1;
    this.playful = options.playful ?? true;
    this.random = options.random ?? Math.random;
    this.direction = options.direction;
    // A robot that arrives while a mood already holds rests in it from its first frame, without the mood's arrival.
    this.mood = options.mood ?? 'none';
    this.sweepOrder = SWEEP_ORDER[options.direction];
    this.nextBlinkAt = between(2.2, 3.6, this.random);
    this.loadPeriod = between(4.6, 6.8, this.random);
    this.loadDepth = between(0.65, 1, this.random);
    this.nextPlayAt = between(PLAY.min, PLAY.max, this.random) + 3;
    // Coming online is reported the way the robot reports everything: one short sweep of the emblem — and then,
    // as the sweep ends, a greeting.
    if (options.wakeAt !== undefined) {
      this.respondAt = options.wakeAt;
      this.blinkAt = options.wakeAt - 0.12;
      this.welcomeAt = options.wakeAt + 0.3;
    }
  }

  /** The state the robot is in — for diagnostics and for tests. */
  get current(): RobotState {
    return this.state;
  }

  cue(cue: RobotCue, time: number): void {
    if (cue.kind !== 'mood') this.lastInputAt = time;
    switch (cue.kind) {
      case 'value': {
        // The client's input moves the robot only while no state of record outranks it (`cues.ts` MOOD_PRIORITY).
        if (!this.inputHeard()) return;
        this.amount = cue.amount ?? null;
        this.valuePending = true;
        this.confirmAt = time + (cue.settled ? DURATION.settledSettle : DURATION.typedSettle);
        // A keystroke while attention is still lingering on the number is the same number: the robot takes it up
        // again without a second narrowing of the optics.
        const continuing = this.state !== 'value' && time - this.valueLeftAt < DURATION.linger;
        this.enter('value', time, Number.POSITIVE_INFINITY, false, continuing);
        // Each change is read: one pass of light through the eyes, unless one is still passing.
        if (time - this.scanAt >= SCAN.gap) this.scanAt = time;
        return;
      }
      case 'direction':
        if (cue.direction === this.direction) return;
        this.direction = cue.direction;
        // Remembered either way, so the flow is right when input is heard again; answered only while it is.
        if (!this.inputHeard()) return;
        this.enter('direction', time, time + DURATION.direction);
        this.hop(time);
        // Always answered, even straight after another response: the sweep is what shows the new flow.
        this.respond(time, 0);
        return;
      case 'rate':
        this.pulseAt = time;
        this.enter('rate', time, time + DURATION.rate);
        return;
      case 'lock':
        // A locked rate supersedes a value still settling: there is nothing left to confirm.
        this.valuePending = false;
        this.resolveAt = time;
        this.nodAt = time + 0.4;
        this.hop(time + 0.15);
        this.enter('locked', time, time + DURATION.locked);
        return;
      case 'submitted':
        // Accepted: the mark resolves, as for a locked rate, and the robot nods once after its glance.
        this.valuePending = false;
        this.resolveAt = time;
        this.nodAt = time + 0.36;
        this.hop(time + 0.15);
        this.enter('accepted', time, time + DURATION.accepted);
        return;
      case 'problem':
        this.valuePending = false;
        this.alertAt = time;
        this.shakeAt = time + 0.1;
        this.enter('problem', time, time + DURATION.problem);
        return;
      case 'wait':
        if (cue.on) {
          // What was being typed has been sent: there is nothing left to confirm.
          this.valuePending = false;
          this.enter('waiting', time, time + DURATION.waiting);
        } else if (this.state === 'waiting') {
          this.until = time;
        }
        return;
      case 'engage':
        if (this.inputHeard()) this.greet(time);
        return;
      case 'mood':
        this.arrive(cue.mood, time);
        return;
      case 'commit':
        // Asking for a price: the decision is celebrated — hearts beating, both arms up, a bounce. Once per press.
        if (!this.inputHeard() || time - this.commitAt < 1) return;
        this.commitAt = time;
        this.valuePending = false;
        this.cheerAt = time;
        this.bounce(time);
        this.respond(time, 0);
        this.enter('delight', time, time + DURATION.delight);
        return;
      case 'poke':
        // Poked: a giggle; the third poke in a short run gets hearts. Only on the home page, and only at rest.
        if (this.mood !== 'none' || !(this.resting || CHARACTER_IN.has(this.state) || this.state === 'giggle')) return;
        this.pokes = [...this.pokes.filter((t) => time - t < POKES.within), time];
        this.jiggleAt = time;
        this.hop(time, HOP.height * 0.55);
        if (this.pokes.length >= POKES.run) {
          this.pokes = [];
          this.enter('delight', time, time + DURATION.giggle + 0.5);
        } else {
          this.enter('giggle', time, time + DURATION.giggle);
        }
        return;
      case 'back':
        // Back with the robot. To the tab: two quick blinks to refocus, then a wave. To the top, after reading on: a
        // happy hop, and then a turn to the converter — the next step — while the visor points at it (`director.ts`).
        if (this.mood !== 'none' || !(this.resting || CHARACTER_IN.has(this.state))) return;
        if (cue.via === 'tab') {
          this.blinkAt = time + 0.05;
          this.blink2At = time + 0.32;
          this.greetAfterAt = time + 0.6;
        } else {
          this.greetAt = time;
          this.hop(time + 0.12);
          this.enter('welcome', time, time + DURATION.welcome);
          this.inviteAt = time + 0.9;
        }
        return;
    }
  }

  update(input: BehaviourInput): Pose {
    const { time } = input;
    const dt = clamp(input.dt, 0, 1 / 20);
    const since = (t: number) => time - t;

    // ---- state -----------------------------------------------------------------------------------------
    if (time >= this.welcomeAt) {
      this.welcomeAt = Number.POSITIVE_INFINITY;
      this.greet(time);
    }
    if (time >= this.greetAfterAt) {
      this.greetAfterAt = Number.POSITIVE_INFINITY;
      this.greet(time, true);
    }
    if (time >= this.inviteAt) {
      this.inviteAt = Number.POSITIVE_INFINITY;
      // Welcomed back from reading on: now the next step — unless something else has taken over since.
      if (this.state === 'welcome') this.enter('invite', time, time + DURATION.invite);
    }
    if (input.focus !== this.lastFocus) {
      this.lastFocus = input.focus;
      this.ctaSince = input.focus === 'cta' ? time : Number.POSITIVE_INFINITY;
    }
    if (this.valuePending && time >= this.confirmAt) {
      // The value has settled: confirm it once — star-struck by a very large amount, impressed by a large one,
      // pleased by any other.
      this.valuePending = false;
      this.respond(time, RESPONSE_GAP);
      if (this.state === 'value') {
        this.valueLeftAt = time;
        if (this.amount !== null && this.amount >= DURATION.stellar) {
          this.bounce(time);
          this.pulseAt = time;
          this.enter('starstruck', time, time + DURATION.starstruck);
        } else if (this.amount !== null && this.amount >= DURATION.impressive) {
          this.hop(time);
          this.pulseAt = time;
          this.enter('wow', time, time + DURATION.wow);
        } else {
          this.nodAt = time + 0.25;
          this.enter('pleased', time, time + DURATION.pleased);
        }
      }
    }
    // At rest and left alone for a while, the robot does something of its own.
    if (this.playful && this.resting && PLAYS_IN.has(this.state) && input.focus === 'none' && time >= this.nextPlayAt) {
      if (time - this.lastInputAt >= PLAY.quiet) this.play(time);
      this.nextPlayAt = time + between(PLAY.min, PLAY.max, this.random);
    }
    // The visitor on the page as a whole moves only the home page's robot: in the workspace a mood always holds.
    const presence = this.mood === 'none' ? input.presence : undefined;
    // Anything the visitor does wakes it: with a start from sleep, with a shake of the lids from a doze.
    if ((this.state === 'drowsy' || this.state === 'asleep') && !(presence && presence.quiet >= DURATION.drowsy)) this.wake(time);
    // The pointer is back from the tabs: relief.
    if (this.state === 'pleading' && !presence?.leaving) {
      this.grinAt = time;
      this.nodAt = time + 0.2;
      this.enter('pleased', time, time + DURATION.pleased);
    }
    // The page scrolling down past the robot: it watches the visitor go, for as long as it scrolls and a moment more.
    if (presence?.scrolling === 1 && input.focus === 'none' && (this.state === 'watching' || (this.resting && CHARACTER_IN.has(this.state)))) {
      this.enter('watching', time, time + DURATION.watching);
    }
    // What the client is on is input too: it draws the eyes only while nothing of record outranks it.
    const rest = this.restOf(input.focus, presence, time);
    const done = this.resting ? this.state !== rest : time >= this.until;
    if (done) {
      if (this.state === 'value') this.valueLeftAt = time;
      const arriving = rest !== this.state;
      this.enter(rest, time, Number.POSITIVE_INFINITY, true);
      if (arriving) this.settleInto(rest, time);
    }
    const spec = this.specOf(this.state);
    // A held check reads again every few seconds, at irregular intervals: the band of light is what shows it working.
    if (this.state === 'checking' && time >= this.nextCheckScan) {
      if (time - this.scanAt >= SCAN.gap) this.scanAt = time;
      this.nextCheckScan = time + between(CHECK_SCAN.min, CHECK_SCAN.max, this.random);
    }

    // ---- attention: eyes, head, neck -------------------------------------------------------------------
    // At rest, a pointer that moved a moment ago has the robot's eyes instead of the visitor's face.
    // Once the page has scrolled on past its head, it looks at what the visitor is reading instead.
    const asked = spec.attention(time - this.since, this.from);
    const free = asked === 'viewer' && PLAYS_IN.has(this.state);
    const wanted = free && input.pointer ? 'pointer' : free && presence?.below ? 'reading' : asked;
    const look = this.locate(wanted, input) ?? { yaw: 0, pitch: 0 };
    const yaw = clamp(look.yaw, -MAX_YAW, MAX_YAW);
    const pitch = clamp(look.pitch, -MAX_PITCH, MAX_PITCH);
    if (wanted !== this.target) {
      const previous = this.locate(this.target, input);
      const jump = previous ? Math.hypot(previous.yaw - yaw, previous.pitch - pitch) : 0;
      this.moveScale = (0.85 + 0.5 * Math.min(jump, 0.8)) * between(0.92, 1.08, this.random);
      // An occasional blink on a long shift of gaze; never on a short one.
      if (spec.blinks && jump > 0.3 && since(this.blinkAt) > 1.5 && this.random() < 0.25) this.blinkAt = time;
      this.target = wanted;
    }
    const { head } = spec;
    const scale = this.moveScale;
    // The aim is taken up over the state's `ease`, the head covers the rest of the move: together they give a
    // soft start for a deliberate look and a crisp one for a decisive look, in about the same overall time.
    follow(this.aimYaw, yaw * head.share, head.yaw * head.ease * scale, dt);
    follow(this.aimPitch, pitch * head.share, head.pitch * head.ease * scale, dt);
    follow(this.headYaw, this.aimYaw.value, head.yaw * (1.05 - head.ease) * scale, dt);
    follow(this.headPitch, this.aimPitch.value, head.pitch * (1.05 - head.ease) * scale, dt);
    follow(this.neckYaw, this.headYaw.value * NECK_SHARE, head.yaw * 0.55 * scale, dt);
    follow(this.neckPitch, this.headPitch.value * NECK_SHARE, head.pitch * 0.55 * scale, dt);
    // The eyes jump to the target at once and cover whatever the head has not yet turned.
    follow(this.eyeYaw, clamp(yaw - this.headYaw.value, -EYE_RANGE, EYE_RANGE), 0.045, dt);
    follow(this.eyePitch, clamp(pitch - this.headPitch.value, -EYE_RANGE, EYE_RANGE), 0.05, dt);

    // ---- body: chest, then the whole figure ------------------------------------------------------------
    // The chest takes up part of the neck's turn and nod, a beat after it, and settles after it.
    // Looking down rounds the shoulders forward a hair; the chest's pitch is a lean, forward-positive.
    follow(this.chestYaw, this.neckYaw.value * CHEST_OF_NECK_YAW, 0.5 * scale, dt);
    follow(this.chestPitch, -this.neckPitch.value * CHEST_OF_NECK_PITCH, 0.55 * scale, dt);

    if (spec.drift && time >= this.driftUntil) {
      this.driftRoll = between(-0.006, 0.006, this.random);
      this.driftYaw = between(-0.014, 0.014, this.random);
      this.driftHeadRoll = between(-0.015, 0.015, this.random);
      this.driftUntil = time + between(8, 15, this.random);
    }
    if (spec.drift && time >= this.correctUntil) {
      // A small correction of posture, the kind a servo makes holding position: quick to arrive, then still.
      this.correctPitch = between(-0.0015, 0.0015, this.random);
      this.correctRoll = between(-0.0015, 0.0015, this.random);
      this.correctUntil = time + between(1.8, 4.5, this.random);
    }
    const resting = spec.drift ? 1 : 0;
    follow(this.correctionPitch, this.correctPitch * resting, 0.35, dt);
    follow(this.correctionRoll, this.correctRoll * resting, 0.35, dt);
    // A direction change turns the body a touch towards the side value is moving to.
    // The flow is the visitor's left and right, wherever the robot stands; everything else is relative to the module.
    const flowSide = this.state === 'direction' ? (this.direction === 'SELL_USDT' ? -1 : 1) : this.side;
    follow(this.lean, spec.lean, spec.settle, dt);
    follow(this.turn, spec.turn * flowSide + this.driftYaw * resting, spec.settle * 1.6, dt);
    follow(this.chin, spec.chin, spec.settle, dt);
    follow(this.roll, this.driftRoll * resting, 1.8, dt);
    follow(this.headRollBias, this.driftHeadRoll * resting, 1.4, dt);
    follow(this.loadDepthOfState, spec.breath, 1.2, dt);

    const chestPitch = this.chestPitch.value + this.correctionPitch.value;
    // The shoulder on the side the chest turns to dips a hair.
    const chestRoll = -0.12 * this.chestYaw.value + this.correctionRoll.value;
    const bodyYaw = this.turn.value + this.chestYaw.value;
    const bodyRoll = this.roll.value + chestRoll;
    const bodyLean = this.lean.value + chestPitch;
    // The arms hang from the shoulders and trail every movement of the body a fraction of a second behind it.
    follow(this.armLagRoll, bodyRoll, 0.6, dt);
    follow(this.armLagYaw, bodyYaw, 0.5, dt);
    follow(this.armLagLean, bodyLean, 0.55, dt);

    // The load cycle: each cycle a different length and depth, joined where the cycle is at rest.
    this.loadPhase += dt / this.loadPeriod;
    if (this.loadPhase >= 1) {
      this.loadPhase -= 1;
      this.loadPeriod = between(4.6, 6.8, this.random);
      this.loadDepth = between(0.65, 1, this.random);
    }

    // ---- optics and light ------------------------------------------------------------------------------
    if (!spec.blinks) {
      // Holding: the next spontaneous blink waits until the hold is over.
      if (this.nextBlinkAt < time + 1) this.nextBlinkAt = time + between(1, 2.5, this.random);
    } else if (time >= this.nextBlinkAt) {
      this.blinkAt = time;
      this.nextBlinkAt = time + between(3.5, 7.5, this.random);
    }
    follow(this.aperture, spec.eyes.aperture, spec.eyes.time, dt);
    follow(this.gain, spec.eyes.gain, 0.25, dt);
    follow(this.accent, spec.accent, spec.settle, dt);

    // The face eases to the state's expression. A problem's two blinks of the antenna come first; its steady glow
    // follows them.
    const { face, faceTime } = spec;
    follow(this.smile, face.smile, faceTime, dt);
    follow(this.lid, face.lid, faceTime, dt);
    follow(this.lidTilt, face.tilt, faceTime, dt);
    follow(this.squint, face.squint, faceTime, dt);
    follow(this.dots, face.dots, faceTime, dt);
    follow(this.wide, face.wide, faceTime, dt);
    follow(this.heart, face.heart, faceTime * 1.4, dt);
    follow(this.star, face.star, faceTime * 1.4, dt);
    follow(this.blush, face.blush, faceTime * 1.6, dt);
    follow(this.sleep, face.sleep, faceTime, dt);
    // The Z's rise from the bottom each time it falls asleep.
    this.zPhase = this.sleep.value > 0.01 ? this.zPhase + dt * Z_RATE : 0;
    // Hearts and stars beat while they show: lub, dub.
    const fond = Math.max(this.heart.value, this.star.value);
    const inBeat = time % BEAT_PERIOD;
    const beat = fond > 1e-3 ? Math.max(envelope(inBeat, 0.06, 0, 0.2), 0.6 * envelope(inBeat - 0.22, 0.06, 0, 0.22)) * fond : 0;
    const alerting = since(this.alertAt) < 0.95;
    follow(this.beacon, alerting ? 0 : face.beacon, 0.3, dt);
    const blinks = Math.max(envelope(since(this.alertAt), 0.05, 0.1, 0.22), envelope(since(this.alertAt) - 0.5, 0.05, 0.1, 0.22));
    const greeting = envelope(since(this.greetAt) - 0.1, 0.25, 0.15, 0.7) * 0.55;
    // Waiting: the dots brighten in turn, left to right, slowly.
    const waiting = this.dots.value > 1e-3;
    const dot = (i: number) => (waiting ? 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (time / WAIT_BREATH - i * 0.2))) ** 3 : 1);
    // Reading: a band of light passes through the eyes, only while they are narrowed to read.
    const reading = since(this.scanAt);
    // Full strength while it crosses the eyes; it fades only where there is nothing left to light.
    const scan = envelope(reading, 0.06, SCAN.duration - 0.15, 0.09) * this.squint.value;

    follow(this.headTilt, spec.roll * this.side, spec.settle, dt);
    // Something accepted gets a nod, after the glance that confirms it.
    const nod = envelope(since(this.nodAt), 0.14, 0.05, 0.45) * 0.06;

    // ---- gestures --------------------------------------------------------------------------------------
    const waving = since(this.waveAt);
    const waveLift = envelope(waving, WAVE.lift, WAVE.hold, WAVE.drop);
    const waveSwing = waveLift * WAVE.swing * Math.sin((2 * Math.PI * Math.max(waving - WAVE.lift * 0.6, 0)) / WAVE.period);
    let hop = 0;
    for (const h of this.hops) {
      const t = time - h.at;
      if (t >= 0 && t < HOP.duration) hop += h.height * Math.sin((Math.PI * t) / HOP.duration);
    }
    if (this.hops.some((h) => time - h.at >= HOP.duration)) this.hops = this.hops.filter((h) => time - h.at < HOP.duration);
    const cheering = since(this.cheerAt);
    const cheer = envelope(cheering, CHEER.lift, CHEER.hold, CHEER.drop);
    const cheerPump = cheer * CHEER.pump * Math.sin((2 * Math.PI * Math.max(cheering - CHEER.lift * 0.5, 0)) / CHEER.period);
    const jiggling = since(this.jiggleAt);
    const jiggle = jiggling >= 0 && jiggling < JIGGLE.duration ? JIGGLE.roll * Math.sin((2 * Math.PI * jiggling) / JIGGLE.period) * (1 - jiggling / JIGGLE.duration) : 0;
    // Nodding off, it catches itself once: the head jerks up and the eyes fly open, and then it sinks again.
    const caught = envelope(since(this.catchAt), 0.1, 0.3, 0.9);
    const shaking = since(this.shakeAt);
    const shake = shaking >= 0 && shaking < SHAKE.duration ? SHAKE.yaw * Math.sin((2 * Math.PI * shaking) / SHAKE.period) * (1 - shaking / SHAKE.duration) : 0;
    const wink = envelope(since(this.winkAt), 0.08, 0.34, 0.16);
    const grin = envelope(since(this.grinAt), 0.12, 0.7, 0.35);

    // Noticing opens and brightens the optics a touch; focusing narrows them briefly, once.
    const notice = envelope(since(this.noticeAt), 0.07, 0.05, 0.3);
    const focus = envelope(since(this.focusAt), 0.1, 0.15, 0.3) * this.focusDepth;
    const pulse = envelope(since(this.pulseAt), 0.08, 0.06, 0.5);
    // A lock resolves the whole mark at once — the three arcs of a completed quote — and holds it for as long as
    // the body holds its confident stance, letting go as the robot returns to rest.
    const resolved = envelope(since(this.resolveAt), 0.3, DURATION.locked - 1.3, 0.9);
    // The response to a meaningful change: one short, faint pass through the arcs in the direction of flow.
    const response = since(this.respondAt);
    const arc = (slot: number) => envelope(response - this.sweepOrder.indexOf(slot) * 0.06, 0.05, 0.02, 0.28) * 0.75 + resolved * 1.2;

    const headPitch = this.headPitch.value + this.chin.value - nod + 0.1 * caught;
    const headRoll = -0.1 * this.headYaw.value + this.headRollBias.value + this.headTilt.value + (0.08 * wink + 0.05 * grin) * this.side + jiggle;
    const antenna = this.sway(headPitch, headRoll, hop, dt);

    return {
      load: loadCycle(this.loadPhase) * this.loadDepth * this.loadDepthOfState.value,
      torsoPitch: this.lean.value,
      torsoYaw: this.turn.value,
      torsoRoll: this.roll.value + 0.35 * jiggle,
      chestPitch,
      chestYaw: this.chestYaw.value,
      chestRoll,
      headYaw: this.headYaw.value + shake,
      headPitch,
      headRoll,
      neckYaw: this.neckYaw.value + shake * 0.3,
      neckPitch: this.neckPitch.value - nod * 0.3,
      neckRoll: clamp(-0.02 * this.headYaw.velocity, -0.012, 0.012),
      gazeX: this.eyeYaw.value * EYE_UNITS_X,
      gazeY: this.eyePitch.value * EYE_UNITS_Y,
      eyeOpen: Math.min(blinkOpenness(since(this.blinkAt)), blinkOpenness(since(this.blink2At))) * (this.aperture.value + 0.6 * caught) * (1 + 0.05 * notice) * (1 - focus),
      eyeGain: this.gain.value + 0.07 * notice + 0.08 * pulse,
      smile: Math.max(this.smile.value, 0.5 * grin),
      lid: this.lid.value,
      lidTilt: this.lidTilt.value,
      squint: this.squint.value,
      scan,
      scanAt: clamp(reading / SCAN.duration, 0, 1),
      dots: this.dots.value,
      dotLevel: [dot(0), dot(1), dot(2)],
      beacon: Math.max(this.beacon.value, blinks, greeting),
      wink,
      wide: Math.max(this.wide.value, 0.4 * caught),
      heart: this.heart.value,
      star: this.star.value,
      blush: this.blush.value,
      sleep: this.sleep.value,
      zPhase: this.zPhase,
      beat,
      hop,
      waveLift,
      waveSwing,
      cheer,
      cheerPump,
      antennaPitch: antenna.pitch,
      antennaRoll: antenna.roll,
      armSwing: (this.armLagRoll.value - bodyRoll) * 0.9,
      armPitch: (this.armLagLean.value - bodyLean) * 1.2,
      armTwist: (this.armLagYaw.value - bodyYaw) * 1.2,
      accentGlow: this.accent.value + 0.35 * resolved,
      arcGlow: [arc(0), arc(1), arc(2)],
      hubGlow: 1.1 * pulse + 1.2 * resolved,
    };
  }

  /** What a state asks of the body. */
  private specOf(state: RobotState): StateSpec {
    return STATES[state];
  }

  /** Whether the client's own input may move the robot now: only while no state of record outranks it. */
  private inputHeard(): boolean {
    return MOOD_PRIORITY[this.mood] < INPUT_PRIORITY;
  }

  /** `continuing` takes a state up again without the optics' one-off response to entering it. */
  private enter(state: RobotState, time: number, until: number, resting = false, continuing = false): void {
    this.resting = resting;
    if (state !== this.state) {
      this.from = state === this.state ? this.from : this.state;
      this.since = time;
      const { eyes } = this.specOf(state);
      if (eyes.notice && !continuing) this.noticeAt = time;
      if (eyes.focus > 0 && !continuing) {
        this.focusAt = time;
        this.focusDepth = eyes.focus;
      }
    }
    this.state = state;
    this.until = until;
  }

  /**
   * A new state of record. The robot rests in it from the next frame (or once the event it is answering has
   * ended), and marks its arrival once, the way it marks the event each mood resembles: the whole mark resolving
   * and a nod for a settled trade, the tip's two blinks for something that needs the client, a pulse at the hub for
   * a live quote, a pass of light through the eyes for a check. Waiting arrives quietly; so does no mood at all.
   */
  private arrive(mood: RobotMood, time: number): void {
    if (mood === this.mood) return;
    this.mood = mood;
    switch (mood) {
      case 'success':
        this.valuePending = false;
        this.resolveAt = time;
        this.nodAt = time + 0.36;
        return;
      case 'alert':
        this.alertAt = time;
        return;
      case 'focused':
        this.pulseAt = time;
        return;
      case 'verifying':
        this.scanAt = time;
        this.nextCheckScan = time + between(CHECK_SCAN.min, CHECK_SCAN.max, this.random);
        return;
      case 'waiting':
      case 'ready':
      case 'none':
        return;
    }
  }

  /**
   * A greeting, from rest only: a smile, a wave, and one soft pulse of the antenna's tip. `owed` is a greeting the
   * robot promised itself — after waking, after refocusing on a tab — which it may also give from its character's rest.
   */
  private greet(time: number, owed = false): void {
    if (!GREETS_FROM.has(this.state) && !(owed && (CHARACTER_IN.has(this.state) || this.state === 'startled'))) return;
    this.greetAt = time;
    this.waveAt = time + 0.1;
    this.enter('welcome', time, time + DURATION.welcome);
  }

  /**
   * Where the robot rests: on whatever the visitor is on, or with the visitor — and, on the home page, according to
   * what they are doing there: puppy eyes when the pointer heads for the tabs, leaning into a pat, drowsy and then
   * asleep when left alone. A call to action held a while makes it fond of it.
   */
  private restOf(focus: RobotFocus, presence: Presence | undefined, time: number): RobotState {
    if (!this.inputHeard()) return MOOD_REST[this.mood];
    if (focus === 'cta') return this.mood === 'none' && time - this.ctaSince >= DURATION.smitten ? 'smitten' : 'intent';
    if (focus === 'entry') return 'entry';
    if (!presence) return MOOD_REST[this.mood];
    if (presence.leaving) return 'pleading';
    if (presence.over >= DURATION.pat) return 'content';
    if (presence.quiet >= DURATION.asleep) return 'asleep';
    if (presence.quiet >= DURATION.drowsy) return 'drowsy';
    return MOOD_REST[this.mood];
  }

  /** Coming to rest somewhere new: the few rests that start with a gesture of their own. */
  private settleInto(rest: RobotState, time: number): void {
    if (rest === 'smitten') this.hop(time, HOP.height * 0.7);
    else if (rest === 'pleading') this.noticeAt = time;
    else if (rest === 'drowsy') {
      this.catchAt = time + 3.4;
      this.blinkAt = time + 4.1;
    }
  }

  /** Woken. From sleep: with a start — round eyes, a hop, two blinks — and then the greeting it owes. From a doze: back. */
  private wake(time: number): void {
    if (this.state === 'asleep') {
      this.hop(time + 0.04);
      this.blinkAt = time + 0.62;
      this.blink2At = time + 0.86;
      this.enter('startled', time, time + DURATION.startled);
      this.greetAfterAt = time + DURATION.startled - 0.05;
      return;
    }
    this.catchAt = -10;
    this.blinkAt = time;
    this.blink2At = time + 0.24;
    this.noticeAt = time;
    this.enter('idle', time, Number.POSITIVE_INFINITY, true);
  }

  /** One hop, starting at `at`. */
  private hop(at: number, height: number = HOP.height): void {
    this.hops.push({ at, height });
  }

  /** Two hops a beat apart, the second lower. */
  private bounce(at: number): void {
    this.hop(at);
    this.hop(at + BOUNCE_GAP, HOP.height * 0.7);
  }

  /**
   * The antenna's sway: a weighted tip on a thin stem, trailing the head's nod and tilt and a hop's lift, then
   * settling in one small, quickly dying swing. Integrated in steps short enough to stay stable at any frame rate.
   */
  private sway(headPitch: number, headRoll: number, hop: number, dt: number): { pitch: number; roll: number } {
    const a = this.antenna;
    if (dt > 0) {
      const vPitch = (headPitch - this.was.pitch) / dt;
      const vRoll = (headRoll - this.was.roll) / dt;
      const vHop = (hop - this.was.hop) / dt;
      const targetPitch = clamp(vPitch * ANTENNA.drive - vHop * ANTENNA.hop, -ANTENNA.limit, ANTENNA.limit);
      const targetRoll = clamp(-vRoll * ANTENNA.drive, -ANTENNA.limit, ANTENNA.limit);
      const steps = Math.ceil(dt / (1 / 120));
      const h = dt / steps;
      const w2 = ANTENNA.omega * ANTENNA.omega;
      const c = 2 * ANTENNA.zeta * ANTENNA.omega;
      for (let i = 0; i < steps; i++) {
        a.vPitch += (-w2 * (a.pitch - targetPitch) - c * a.vPitch) * h;
        a.pitch += a.vPitch * h;
        a.vRoll += (-w2 * (a.roll - targetRoll) - c * a.vRoll) * h;
        a.roll += a.vRoll * h;
      }
      a.pitch = clamp(a.pitch, -ANTENNA.limit, ANTENNA.limit);
      a.roll = clamp(a.roll, -ANTENNA.limit, ANTENNA.limit);
    }
    this.was.pitch = headPitch;
    this.was.roll = headRoll;
    this.was.hop = hop;
    return { pitch: a.pitch, roll: a.roll };
  }

  /** Something of the robot's own, at rest: a wink, a read of the headline, a glance and a nod, a hop, or a wave. */
  private play(time: number): void {
    const r = this.random();
    if (r < 0.28) {
      this.winkAt = time;
    } else if (r < 0.52) {
      this.enter('curious', time, time + DURATION.curious);
    } else if (r < 0.72) {
      this.nodAt = time + 0.35;
      this.grinAt = time;
      this.enter('pleased', time, time + DURATION.pleased);
    } else if (r < 0.9) {
      this.hop(time);
      this.grinAt = time;
    } else {
      this.waveAt = time;
      this.grinAt = time;
    }
  }

  /** The emblem's one response, unless another was shown less than `gap` seconds ago. */
  private respond(time: number, gap: number): void {
    if (time - this.respondAt < gap) return;
    this.respondAt = time;
    this.sweepOrder = SWEEP_ORDER[this.direction];
  }

  /** A target's angles, or the nearest fallback that is on the page. */
  private locate(target: LookTarget, input: BehaviourInput): LookAngles | null {
    for (let t: LookTarget | null = target; t !== null; t = LOOK_FALLBACK[t]) {
      const angles = input.angles(t);
      if (angles) return angles;
    }
    return null;
  }
}

/**
 * The pose the robot holds when it is not animated at all — the still image, and anyone who asked for reduced
 * motion. Facing the visitor, optics open, lights at rest: the same first frame the live robot starts from, so
 * swapping one for the other cannot be seen.
 */
export const REST_POSE: Pose = {
  load: 0,
  torsoPitch: 0,
  torsoYaw: 0,
  torsoRoll: 0,
  chestPitch: 0,
  chestYaw: 0,
  chestRoll: 0,
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  neckYaw: 0,
  neckPitch: 0,
  neckRoll: 0,
  gazeX: 0,
  gazeY: 0,
  eyeOpen: 1,
  eyeGain: 1,
  smile: 0,
  lid: 0,
  lidTilt: 0,
  squint: 0,
  scan: 0,
  scanAt: 0,
  dots: 0,
  dotLevel: [1, 1, 1],
  beacon: 0,
  wink: 0,
  wide: 0,
  heart: 0,
  star: 0,
  blush: 0,
  sleep: 0,
  zPhase: 0,
  beat: 0,
  hop: 0,
  waveLift: 0,
  waveSwing: 0,
  cheer: 0,
  cheerPump: 0,
  antennaPitch: 0,
  antennaRoll: 0,
  armSwing: 0,
  armPitch: 0,
  armTwist: 0,
  accentGlow: STATES.idle.accent,
  arcGlow: [0, 0, 0],
  hubGlow: 0,
};
