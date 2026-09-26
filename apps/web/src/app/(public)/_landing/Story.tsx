import type { ReactNode } from 'react';
import type { Direction } from '@inrp2p/kernel';
import { DIRECTION_ATTRIBUTE, STORY_DIRECTION } from './story.ts';
import styles from './story.module.css';

/**
 * The sections below the hero, told in one direction at a time.
 *
 * Both directions' words are rendered on the server, and this wrapper's `data-direction` shows one of them — so
 * the page reads completely before any script runs, a search engine reads both, and changing direction swaps
 * words without rendering anything. The execution flow's switch sets the attribute (flow/FlowStage.tsx).
 */
export function Story({ children }: { children: ReactNode }) {
  return (
    <div className={styles.story} data-story="" {...{ [DIRECTION_ATTRIBUTE]: STORY_DIRECTION }}>
      {children}
    </div>
  );
}

/** Words that may differ by direction: one element when they do not, one per direction when they do. */
export function ByDirection({ value }: { value: Record<Direction, string> }) {
  if (value.BUY_USDT === value.SELL_USDT) return <>{value.BUY_USDT}</>;
  return (
    <>
      <span data-dir="BUY_USDT">{value.BUY_USDT}</span>
      <span data-dir="SELL_USDT">{value.SELL_USDT}</span>
    </>
  );
}
