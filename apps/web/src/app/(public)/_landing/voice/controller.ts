import type { VoiceLine } from '../../../../content/site.ts';
import type { RobotCue } from '../robot/cues.ts';

/**
 * When the robot speaks, and when it keeps quiet.
 *
 * Three recorded lines, each an answer to something the visitor did — and rarity is part of what makes them
 * worth hearing, so the rules that keep them rare are all here:
 *
 *   - the voice is off until the visitor turns it on (VoiceControl.tsx), and nothing is ever said before the
 *     visitor has interacted with the page;
 *   - turning it on is answered with "Ready when you are.", once, if nothing has been said yet — as soon as the
 *     clips, which are fetched only then, are ready, or not at all if that takes more than a moment;
 *   - "Ready when you are." answers the visitor's first move in the quote module, once per visit, the moment it
 *     happens. Changing the amount or the direction is never spoken — the page and the robot's body show those;
 *   - "Let's check that." answers a request that cannot go as it is, once per visit: a second time is nagging;
 *   - "Request received." answers every request the desk accepts;
 *   - a line plays at once or not at all: nothing waits for audio, and nothing is queued to play later. The one
 *     allowance is the moment a touch screen takes to count a tap as a gesture (the tap's end, not its start);
 *   - one line at a time: a more important line cuts a lesser one short, never the other way round;
 *   - muting stops the current line at once.
 *
 * Audio is behind `Player` and time behind `Clock`, so the rules can be tested as rules.
 */

export interface Player {
  /** Whether a line started now would be heard now: clips decoded, audio unlocked by a gesture. */
  ready(): boolean;
  /**
   * Starts a line from memory, now, and reports when it ends (or is stopped). Returns how long until its first
   * sound reaches the speakers, or null when it cannot start at once. Never throws, never blocks.
   */
  play(line: VoiceLine, onEnd: () => void): { readonly lead: number } | null;
  /** Stops the current line with a short fade. */
  stop(): void;
}

export interface Clock {
  now(): number;
}

/** Which line may cut which short: a received request over a problem over the greeting. */
const PRIORITY: Record<VoiceLine, number> = { ready: 0, check: 1, received: 2 };
/** Lines said at most once per visit. */
const ONCE: ReadonlySet<VoiceLine> = new Set<VoiceLine>(['ready', 'check']);
/** How long the greeting may wait for the gesture that unlocks audio — a tap's length, no more. */
const UNLOCK_WINDOW = 0.6;
/** How long the answer to turning the voice on may wait for the clips it has just started fetching. */
const TURN_ON_WINDOW = 2;

export class VoiceController {
  private readonly player: Player;
  private readonly clock: Clock;
  private readonly onRobot: (cue: RobotCue) => void;
  private readonly spoken = new Set<VoiceLine>();
  private muted: boolean;
  private playing: VoiceLine | null = null;
  /** Monotonic: tells a finished line's callback whether it is still the current one. */
  private generation = 0;
  /** A greeting that could not be said at once — audio not yet unlocked, or clips not yet loaded — and until when
   * it may still be said. */
  private greetingUntil: number | null = null;

  constructor(options: { player: Player; clock: Clock; muted: boolean; onRobot: (cue: RobotCue) => void }) {
    this.player = options.player;
    this.clock = options.clock;
    this.onRobot = options.onRobot;
    this.muted = options.muted;
  }

  /**
   * Audio just became playable — unlocked by a gesture, or the clips finished loading: a greeting that was waiting
   * for it is said now, if still timely. One that has run out of time is dropped; one still in time but not yet
   * playable keeps waiting for the other half.
   */
  unlocked(): void {
    const until = this.greetingUntil;
    if (until === null) return;
    if (this.clock.now() > until) {
      this.greetingUntil = null;
      return;
    }
    if (!this.player.ready()) return;
    this.greetingUntil = null;
    this.say('ready');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.greetingUntil = null;
      this.stop();
      return;
    }
    // Turning the voice on is answered the way a first move is — once, and only if nothing has been said yet.
    this.greet(TURN_ON_WINDOW);
  }

  onCue(cue: RobotCue): void {
    switch (cue.kind) {
      case 'engage':
        this.greet(UNLOCK_WINDOW);
        return;
      case 'problem':
        this.say('check');
        return;
      case 'submitted':
        this.say('received');
        return;
      default:
        return;
    }
  }

  /** Stops the current line, if any, without changing whether the voice is on: the page was hidden or left. */
  hush(): void {
    this.greetingUntil = null;
    this.stop();
  }

  /** Says the greeting now if it can be heard now; otherwise lets it wait, for `window` seconds at most. */
  private greet(window: number): void {
    if (this.muted || this.spoken.has('ready')) return;
    if (this.player.ready()) this.say('ready');
    else this.greetingUntil = this.clock.now() + window;
  }

  dispose(): void {
    this.stop();
  }

  private say(line: VoiceLine): void {
    if (this.muted || this.spoken.has(line)) return;
    if (this.playing !== null && PRIORITY[this.playing] >= PRIORITY[line]) {
      // A lesser line never waits to be said later; the greeting's moment has simply passed.
      if (line === 'ready') this.spoken.add(line);
      return;
    }
    // Whether it is heard or not, the moment for the greeting is over once anything else is said.
    this.spoken.add('ready');
    if (ONCE.has(line)) this.spoken.add(line);
    if (this.playing !== null) this.stop();
    const generation = ++this.generation;
    const started = this.player.play(line, () => {
      if (generation !== this.generation) return;
      this.playing = null;
    });
    if (!started) return;
    this.playing = line;
    this.onRobot({ kind: 'speak', line, lead: started.lead });
  }

  private stop(): void {
    this.generation += 1;
    if (this.playing === null) return;
    this.playing = null;
    this.player.stop();
    this.onRobot({ kind: 'hush' });
  }
}
