import type { Direction } from '@inrp2p/kernel';
import type { VoiceLine } from '../../../../content/site.ts';

/**
 * How quote UI tells the robot what just happened.
 *
 * The UI and the robot are separate islands and never import each other: the UI announces an event, the robot
 * decides how to respond inside its own frame loop. No React state crosses between them, so a keystroke never
 * re-renders the canvas, and the UI works exactly the same when the robot never loads at all (reduced motion, no
 * WebGL, a slow connection).
 *
 * Every cue is a real event of the quote it describes. `rate` and `lock` exist for UI that holds a firm quote —
 * a rate the desk actually issued, and its acceptance. The home page's module shows no rate, so it never sends
 * them: a robot reacting to a rate nobody quoted would be performing, not reporting.
 */
export type RobotCue =
  /**
   * The quote's value changed. `settled` when the change is complete in one step (a preset, a paste); otherwise
   * the visitor is typing, and the robot waits for them to stop before it confirms.
   */
  | { readonly kind: 'value'; readonly settled?: boolean }
  /** The direction changed. The robot shows which way value is about to flow. */
  | { readonly kind: 'direction'; readonly direction: Direction }
  /** A firm rate arrived or changed. Only from UI that shows one. */
  | { readonly kind: 'rate' }
  /** The firm rate was accepted and is now locked. Only from UI that shows one. */
  | { readonly kind: 'lock' }
  /**
   * The visitor started working in the module: the first press or focus inside it — not a press on the call to
   * action, which answers for itself. Heard by the voice.
   */
  | { readonly kind: 'engage' }
  /** A request was accepted by the desk. Only from UI that submits one — the home page's module does not. */
  | { readonly kind: 'submitted' }
  /** The request cannot go as it is (no amount): recoverable, and shown next to what needs changing. */
  | { readonly kind: 'problem' }
  /**
   * The voice has started a line. `lead` is how long until its first sound reaches the speakers — the body's
   * attention moves now, its timing to the words waits that long.
   */
  | { readonly kind: 'speak'; readonly line: VoiceLine; readonly lead: number }
  /** The line stopped before its end (muted, interrupted, the page hidden). */
  | { readonly kind: 'hush' };

/** The direction the quote module opens on; the robot starts the conversation facing the same way. */
export const INITIAL_DIRECTION: Direction = 'SELL_USDT';

/**
 * What the visitor is on — hovering or focused on — that the robot attends to: the call to action, or the
 * masthead's way into the workspace. The one sustained input.
 */
export type RobotFocus = 'none' | 'cta' | 'entry';

type Listener = (cue: RobotCue) => void;

const listeners = new Set<Listener>();
let focus: Exclude<RobotFocus, 'entry'> = 'none';
let entry = false;
let direction: Direction = INITIAL_DIRECTION;

export const robotCues = {
  emit(cue: RobotCue): void {
    if (cue.kind === 'direction') direction = cue.direction;
    for (const listener of listeners) listener(cue);
  },
  /** The direction the module shows now — where a robot that arrives late starts from. */
  direction(): Direction {
    return direction;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setFocus(next: Exclude<RobotFocus, 'entry'>): void {
    focus = next;
  },
  /**
   * The masthead's way into the workspace is hovered or focused. Kept apart from the module's own focus, so
   * leaving one never clears the other; while both hold, the entry — the latest move — has the robot's eyes.
   */
  setEntry(on: boolean): void {
    entry = on;
  },
  focus(): RobotFocus {
    return entry ? 'entry' : focus;
  },
};
