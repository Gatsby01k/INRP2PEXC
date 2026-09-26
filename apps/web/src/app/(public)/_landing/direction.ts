import type { Direction } from '@inrp2p/kernel';
import { DIRECTION_ATTRIBUTE, STORY_DIRECTION } from './story.ts';

/**
 * The direction the story below the hero is told in, once the visitor has a say in it.
 *
 * Two switches change it — the execution flow's and the one beside the controls' record — and the quote module's
 * direction moves it too (flow/FlowStage.tsx), so it is held here, once, rather than in either island: each
 * switch shows what the other chose. Setting it writes the story's one attribute (Story.tsx), which is all that
 * shows one direction's words and hides the other's. Browser-only; the server renders STORY_DIRECTION.
 */
type Listener = (direction: Direction) => void;

const listeners = new Set<Listener>();
let current: Direction = STORY_DIRECTION;

export const storyDirection = {
  get(): Direction {
    return current;
  },
  set(next: Direction): void {
    if (next === current) return;
    current = next;
    document.querySelector('[data-story]')?.setAttribute(DIRECTION_ATTRIBUTE, next);
    for (const listener of listeners) listener(next);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
