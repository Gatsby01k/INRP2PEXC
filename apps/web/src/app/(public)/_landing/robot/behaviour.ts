import type { Direction } from '@inrp2p/kernel';
import type { VoiceLine } from '../../../../content/site.ts';
import type { RobotCue, RobotFocus } from './cues.ts';
import { between, blinkOpenness, clamp, envelope, follow, follower, loadCycle } from './motion.ts';
import { SPEECH, clipOf, loudness, nodTime, speakingSpec } from './speech.ts';
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
 * Lights run on their own clock: one short, faint sweep of the emblem when a value is confirmed or the direction
 * changes, a pulse at its hub for a new rate, the whole mark resolving when a rate locks. Each starts at an event
 * and ends.
 *
 * When the voice says a line, the body follows that line's own timeline (`speech.ts`): attention at once, then a
 * nod on the stressed syllable and the hub light following the voice, timed to when the sound is heard.
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

/** Where the robot rests while nothing is happening: on whatever the visitor is on, or with the visitor. */
const REST: Record<RobotFocus, RobotState> = { none: 'idle', cta: 'intent', entry: 'entry' };

/** States an event starts and time ends. The others follow the visitor's focus. */
const TRANSIENT: ReadonlySet<RobotState> = new Set<RobotState>(['value', 'direction', 'rate', 'locked', 'speaking']);

/** The line being spoken: when it was asked for, how long until it is heard, and when it stopped early, if it did. */
interface Speech {
  readonly line: VoiceLine;
  readonly spec: StateSpec;
  readonly at: number;
  readonly lead: number;
  readonly nod: number | null;
  stoppedAt: number;
}

export class RobotBehaviour {
  private readonly random: () => number;

  private state: RobotState = 'idle';
  private from: RobotState = 'idle';
  private since = 0;
  private until = Number.POSITIVE_INFINITY;

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
  private speech: Speech | null = null;

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
  private readonly tilt = follower();
  private readonly voiceLight = follower();

  constructor(options: { direction: Direction; wakeAt?: number; random?: () => number }) {
    this.random = options.random ?? Math.random;
    this.direction = options.direction;
    this.sweepOrder = SWEEP_ORDER[options.direction];
    this.nextBlinkAt = between(2.2, 3.6, this.random);
    this.loadPeriod = between(4.6, 6.8, this.random);
    this.loadDepth = between(0.65, 1, this.random);
    // Coming online is reported the way the robot reports everything: one short sweep of the emblem, and done.
    if (options.wakeAt !== undefined) {
      this.respondAt = options.wakeAt;
      this.blinkAt = options.wakeAt - 0.12;
    }
  }

  /** The state the robot is in — for diagnostics and for tests. */
  get current(): RobotState {
    return this.state;
  }

  cue(cue: RobotCue, time: number): void {
    switch (cue.kind) {
      case 'value':
        this.valuePending = true;
        this.confirmAt = time + (cue.settled ? DURATION.settledSettle : DURATION.typedSettle);
        this.enter('value', time, Number.POSITIVE_INFINITY);
        return;
      case 'direction':
        if (cue.direction === this.direction) return;
        this.direction = cue.direction;
        this.enter('direction', time, time + DURATION.direction);
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
        this.enter('locked', time, time + DURATION.locked);
        return;
      case 'speak': {
        const at = time;
        const lead = clamp(cue.lead, 0, 0.3);
        const nod = nodTime(cue.line);
        this.speech = { line: cue.line, spec: speakingSpec(cue.line), at, lead, nod, stoppedAt: Number.POSITIVE_INFINITY };
        // Speaking supersedes a value still settling: its confirmation would land on the words.
        this.valuePending = false;
        this.enter('speaking', time, at + lead + clipOf(cue.line).duration + SPEECH[cue.line].hold);
        return;
      }
      case 'hush':
        if (!this.speech || this.speech.stoppedAt <= time) return;
        this.speech.stoppedAt = time;
        if (this.state === 'speaking') this.until = Math.min(this.until, time + 0.2);
        return;
      case 'engage':
      case 'submitted':
      case 'problem':
        // Answered by the voice, and through it by the body (`speak`); muted, the page itself shows them.
        return;
    }
  }

  update(input: BehaviourInput): Pose {
    const { time } = input;
    const dt = clamp(input.dt, 0, 1 / 20);
    const since = (t: number) => time - t;

    // ---- state -----------------------------------------------------------------------------------------
    if (this.valuePending && time >= this.confirmAt) {
      // The value has settled: confirm it once, and let attention go.
      this.valuePending = false;
      this.respond(time, RESPONSE_GAP);
      if (this.state === 'value') this.until = time + DURATION.confirmHold;
    }
    const rest = REST[input.focus];
    const done = TRANSIENT.has(this.state) ? time >= this.until : this.state !== rest;
    if (done) this.enter(rest, time, Number.POSITIVE_INFINITY);
    const spec = this.specOf(this.state);

    // ---- attention: eyes, head, neck -------------------------------------------------------------------
    const wanted = spec.attention(time - this.since, this.from);
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
    const flowSide = this.state === 'direction' && this.direction === 'SELL_USDT' ? -1 : 1;
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

    // Speech: a held tilt while the line lasts, one nod on its stressed syllable, the hub light on the voice and,
    // for a received request, the emblem resolving with the nod. All timed from when the sound is heard, and
    // all ending with the line — or at once, eased, if it is stopped.
    const speech = this.speech;
    const heard = speech ? time - speech.at - speech.lead : Number.NEGATIVE_INFINITY;
    const speaking = speech !== null && this.state === 'speaking';
    const script = speech ? SPEECH[speech.line] : null;
    const cut = speech ? speech.stoppedAt - speech.at - speech.lead : Number.POSITIVE_INFINITY;
    follow(this.tilt, speaking && script ? script.tilt : 0, speaking ? 0.35 : 0.6, dt);
    const voice = speech && script && heard < cut ? loudness(speech.line, heard) ** 1.5 * script.light : 0;
    follow(this.voiceLight, voice, 0.045, dt);
    const nodAt = speech?.nod ?? null;
    // The nod starts a little before its syllable so that its lowest point lands on it; a stopped line only
    // keeps a nod already under way.
    const nodStart = nodAt === null ? Number.POSITIVE_INFINITY : nodAt - 0.1;
    const nod = speech && script?.nod && nodStart < cut ? envelope(heard - nodStart, 0.14, 0.04, 0.42) * script.nod.depth : 0;
    const complete =
      speech && script?.resolve && nodAt !== null && nodAt < cut
        ? envelope(heard - nodAt, 0.22, Math.max(0, clipOf(speech.line).duration - nodAt) + script.hold * 0.5, 0.8) * 0.8
        : 0;
    if (speech && !speaking && heard > clipOf(speech.line).duration + 2) this.speech = null;

    // Noticing opens and brightens the optics a touch; focusing narrows them briefly, once.
    const notice = envelope(since(this.noticeAt), 0.07, 0.05, 0.3);
    const focus = envelope(since(this.focusAt), 0.1, 0.15, 0.3) * this.focusDepth;
    const pulse = envelope(since(this.pulseAt), 0.08, 0.06, 0.5);
    // A lock resolves the whole mark at once — the three arcs of a completed quote — and holds it for as long as
    // the body holds its confident stance, letting go as the robot returns to rest.
    const resolved = envelope(since(this.resolveAt), 0.3, DURATION.locked - 1.3, 0.9);
    // The response to a meaningful change: one short, faint pass through the arcs in the direction of flow.
    const response = since(this.respondAt);
    const arc = (slot: number) => envelope(response - this.sweepOrder.indexOf(slot) * 0.06, 0.05, 0.02, 0.28) * 0.75 + resolved * 1.2 + complete;

    return {
      load: loadCycle(this.loadPhase) * this.loadDepth * this.loadDepthOfState.value,
      torsoPitch: this.lean.value,
      torsoYaw: this.turn.value,
      torsoRoll: this.roll.value,
      chestPitch,
      chestYaw: this.chestYaw.value,
      chestRoll,
      headYaw: this.headYaw.value,
      headPitch: this.headPitch.value + this.chin.value - nod,
      headRoll: -0.1 * this.headYaw.value + this.headRollBias.value + this.tilt.value,
      neckYaw: this.neckYaw.value,
      neckPitch: this.neckPitch.value - nod * 0.3,
      neckRoll: clamp(-0.02 * this.headYaw.velocity, -0.012, 0.012),
      gazeX: this.eyeYaw.value * EYE_UNITS_X,
      gazeY: this.eyePitch.value * EYE_UNITS_Y,
      eyeOpen: blinkOpenness(since(this.blinkAt)) * this.aperture.value * (1 + 0.05 * notice) * (1 - focus),
      eyeGain: this.gain.value + 0.07 * notice + 0.08 * pulse,
      armSwing: (this.armLagRoll.value - bodyRoll) * 0.9,
      armPitch: (this.armLagLean.value - bodyLean) * 1.2,
      armTwist: (this.armLagYaw.value - bodyYaw) * 1.2,
      accentGlow: this.accent.value + 0.35 * resolved + 0.2 * complete,
      arcGlow: [arc(0), arc(1), arc(2)],
      hubGlow: 1.1 * pulse + 1.2 * resolved + this.voiceLight.value + 0.6 * complete,
    };
  }

  /** What a state asks of the body; speaking asks what the line being spoken asks. */
  private specOf(state: RobotState): StateSpec {
    return state === 'speaking' && this.speech ? this.speech.spec : STATES[state];
  }

  private enter(state: RobotState, time: number, until: number): void {
    if (state !== this.state || state === 'speaking') {
      this.from = state === this.state ? this.from : this.state;
      this.since = time;
      const { eyes } = this.specOf(state);
      if (eyes.notice) this.noticeAt = time;
      if (eyes.focus > 0) {
        this.focusAt = time;
        this.focusDepth = eyes.focus;
      }
    }
    this.state = state;
    this.until = until;
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
  armSwing: 0,
  armPitch: 0,
  armTwist: 0,
  accentGlow: 0.14,
  arcGlow: [0, 0, 0],
  hubGlow: 0,
};
