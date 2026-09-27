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
   * action, which answers for itself. The robot greets them; the voice, if it is on, says so.
   */
  | { readonly kind: 'engage' }
  /**
   * What the visitor sent was accepted — a request by the desk, a sign-in code by the workspace. Only from UI that
   * submits something; the home page's module does not.
   */
  | { readonly kind: 'submitted' }
  /**
   * What the visitor asked for cannot go as it is (no amount, a refused code): recoverable, and shown next to what
   * needs changing. The robot turns to it and signals, gently; the voice, if it is on, says so.
   */
  | { readonly kind: 'problem' }
  /**
   * Something the visitor asked for is on its way (`on`), or has answered (`!on`) — a code being sent, or checked.
   * The robot waits with them in between.
   */
  | { readonly kind: 'wait'; readonly on: boolean }
  /**
   * The voice has started a line. `lead` is how long until its first sound reaches the speakers — the body's
   * attention moves now, its timing to the words waits that long.
   */
  | { readonly kind: 'speak'; readonly line: VoiceLine; readonly lead: number }
  /** The line stopped before its end (muted, interrupted, the page hidden). */
  | { readonly kind: 'hush' }
  /** The state of record changed (`RobotMood`): what the robot rests in until the next change. */
  | { readonly kind: 'mood'; readonly mood: RobotMood };

/**
 * What the robot rests in while a state of record lasts — the workspace's, never the home page's, which has none.
 *
 * Every other cue is an event that ends. A mood is a fact that holds: a request the desk is pricing, a firm quote
 * that is live, a transfer seen on the chain and not yet final, a trade settled, something that needs the client.
 * The workspace derives it from what the server returned for the page, so the robot can only rest in a state the
 * backend is actually in. Events still play over it and hand back to it when they end.
 *
 * - `none`: nothing is live; the robot rests as on the home page, and greets on arrival (Welcome).
 * - `waiting`: something the client asked for is with the desk (Waiting).
 * - `focused`: a firm quote is live and the client can act on it (Focused / Quote ready).
 * - `verifying`: money has been seen and is being confirmed (Verifying).
 * - `success`: done — a trade settled (Success).
 * - `alert`: something needs the client, or the desk is holding something (Help / Alert).
 */
export type RobotMood = 'none' | 'waiting' | 'focused' | 'verifying' | 'success' | 'alert';

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
let mood: RobotMood = 'none';

export const robotCues = {
  emit(cue: RobotCue): void {
    if (cue.kind === 'direction') direction = cue.direction;
    if (cue.kind === 'mood') {
      if (cue.mood === mood) return;
      mood = cue.mood;
    }
    for (const listener of listeners) listener(cue);
  },
  /** The direction the module shows now — where a robot that arrives late starts from. */
  direction(): Direction {
    return direction;
  },
  /** The mood the page is in now — what a robot that arrives late rests in from its first frame. */
  mood(): RobotMood {
    return mood;
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
