import type { Direction } from '@inrp2p/kernel';

/**
 * The direction the sections below the hero tell their story in, until the visitor picks one.
 *
 * INR to USDT: rupees in on the left, USDT out on the right — the order a reader expects the flow to run in. It
 * is deliberately not the quote module's opening direction: the module asks what the visitor wants to do, and
 * these sections explain how either one runs. Once the visitor changes direction in the module, the sections
 * follow them.
 */
export const STORY_DIRECTION: Direction = 'BUY_USDT';

/** The attribute on the story's wrapper that every direction-dependent word and drawing below the hero reads. */
export const DIRECTION_ATTRIBUTE = 'data-direction';
