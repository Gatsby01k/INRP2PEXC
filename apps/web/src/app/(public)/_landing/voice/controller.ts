import type { VoiceLine } from '../../../../content/site.ts';
import type { RobotCue } from '../robot/cues.ts';

/**
 * When the robot speaks, and when it keeps quiet.
 *
 * Speech is confirmation, not conversation. Each line answers one thing the visitor did, and the rules that keep
 * it that way are all here:
 *
 *   - nothing is ever said before the visitor has interacted with the page;
 *   - each line is said at most once per visit — a confirmation heard twice is a prompt;
 *   - one line at a time, with a pause after it; a line asked for meanwhile waits — only the most recent one,
 *     and never longer than a moment — or is dropped, so the voice can never fall behind what is on screen;
 *   - the greeting belongs to the first interaction only when that interaction is not itself an action — once
 *     the visitor has acted, "ready when you are" no longer fits and is retired unsaid;
 *   - a typed amount is confirmed when the typing stops, at the moment the robot's own confirmation shows;
 *   - muting stops the current line at once.
 *
 * The browser is behind `Speaker`, and time behind `Clock`, so the rules can be tested as rules.
 */

export interface Speaker {
  /** Starts a line and reports when it has finished (or failed). Must never throw or block. */
  speak(text: string, onEnd: () => void): void;
  cancel(): void;
  /** Called inside the visitor's first gesture: some browsers only allow speech that began in one. */
  unlock(): void;
}

export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Seconds of quiet after a line before another may start. */
export const PAUSE_AFTER_LINE = 0.9;
/** A line that has not reported its end after this long is treated as finished. */
const LONGEST_LINE = 4;
/** How long the greeting waits, so a first press that is itself an action is answered by that action's line. */
const GREETING_DELAY = 0.35;
/** When a typed or picked amount counts as settled — the same moments the robot confirms it (`states.ts`). */
const AMOUNT_SETTLE = { typed: 0.55, picked: 0.25 } as const;
/** A short beat after a direction change, so the line follows the click rather than landing on it. */
const DIRECTION_DELAY = 0.12;
/** The longest a line may wait for the one before it to finish; after that it is no longer news. */
const LONGEST_WAIT = 1.5;

export class VoiceController {
  private readonly speaker: Speaker;
  private readonly clock: Clock;
  private readonly lines: Record<VoiceLine, string>;
  private readonly spoken = new Set<VoiceLine>();
  private muted: boolean;
  private activated = false;
  private speakingSince: number | null = null;
  private quietUntil = 0;
  private greeting: unknown = null;
  private amount: unknown = null;
  private direction: unknown = null;
  /** The one line waiting for the current line to finish: the most recent asked for. */
  private waiting: { readonly line: VoiceLine; readonly until: number } | null = null;
  private flush: unknown = null;

  constructor(options: { speaker: Speaker; clock: Clock; lines: Record<VoiceLine, string>; muted: boolean }) {
    this.speaker = options.speaker;
    this.clock = options.clock;
    this.lines = options.lines;
    this.muted = options.muted;
  }

  /** The visitor pressed, clicked, typed or tabbed: speech is now allowed, and unlocked where that is needed. */
  activate(): void {
    if (this.activated) return;
    this.activated = true;
    this.speaker.unlock();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.cancelPending();
      this.speaker.cancel();
      this.speakingSince = null;
      return;
    }
    // Turning the voice on is itself a first interaction worth answering — once.
    this.activate();
    this.say('ready');
  }

  onCue(cue: RobotCue): void {
    switch (cue.kind) {
      case 'engage':
        this.activate();
        if (this.spoken.has('ready') || this.greeting !== null) return;
        this.greeting = this.clock.setTimeout(() => {
          this.greeting = null;
          this.say('ready');
        }, GREETING_DELAY * 1000);
        return;
      case 'value':
        this.acted();
        this.clock.clearTimeout(this.amount);
        this.amount = this.clock.setTimeout(() => {
          this.amount = null;
          this.say('amount');
        }, (cue.settled ? AMOUNT_SETTLE.picked : AMOUNT_SETTLE.typed) * 1000);
        return;
      case 'direction':
        this.acted();
        this.clock.clearTimeout(this.direction);
        this.direction = this.clock.setTimeout(() => {
          this.direction = null;
          this.say('direction');
        }, DIRECTION_DELAY * 1000);
        return;
      case 'cta':
        this.acted();
        this.say('request');
        return;
      case 'submitted':
        this.acted();
        this.say('received');
        return;
      case 'rate':
      case 'lock':
        // Shown by the robot, not spoken: the figure on screen is the confirmation.
        return;
    }
  }

  dispose(): void {
    this.cancelPending();
    this.speaker.cancel();
  }

  /** The visitor has acted: the greeting no longer fits, whether or not it was said. */
  private acted(): void {
    this.activate();
    this.clock.clearTimeout(this.greeting);
    this.greeting = null;
    this.spoken.add('ready');
  }

  private say(line: VoiceLine): void {
    const now = this.clock.now();
    if (this.muted || !this.activated || this.spoken.has(line)) return;
    const speaking = this.speakingSince !== null && now - this.speakingSince < LONGEST_LINE;
    if (speaking || now < this.quietUntil) {
      // A confirmation may wait its turn, briefly; the greeting never does — by then it would be late.
      if (line === 'ready') return;
      this.waiting = { line, until: now + LONGEST_WAIT };
      if (!speaking) this.flushIn(this.quietUntil - now);
      return;
    }
    this.spoken.add(line);
    this.speakingSince = now;
    this.speaker.speak(this.lines[line], () => {
      this.speakingSince = null;
      this.quietUntil = this.clock.now() + PAUSE_AFTER_LINE;
      if (this.waiting) this.flushIn(PAUSE_AFTER_LINE);
    });
  }

  /** Says the waiting line once the pause is over, if it is still recent enough to be worth saying. */
  private flushIn(seconds: number): void {
    this.clock.clearTimeout(this.flush);
    this.flush = this.clock.setTimeout(() => {
      this.flush = null;
      const waiting = this.waiting;
      this.waiting = null;
      if (waiting && this.clock.now() <= waiting.until) this.say(waiting.line);
    }, Math.max(0, seconds) * 1000);
  }

  private cancelPending(): void {
    for (const handle of [this.greeting, this.amount, this.direction, this.flush]) this.clock.clearTimeout(handle);
    this.greeting = null;
    this.amount = null;
    this.direction = null;
    this.flush = null;
    this.waiting = null;
  }
}
