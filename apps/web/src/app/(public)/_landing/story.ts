import type { Direction } from '@inrp2p/kernel';

/**
 * The direction the sections below the hero tell their story in, until the visitor picks one.
 *
 * Selling USDT, as the hero's converter opens: the visitor is the seller, on the left of the deal's picture, and the
 * story reads from them to the escrow to the trader. Once the visitor changes direction in the converter or in the
 * story's own switch, every section below follows them.
 */
export const STORY_DIRECTION: Direction = 'SELL_USDT';

/** The attribute on the story's wrapper that every direction-dependent word and drawing below the hero reads. */
export const DIRECTION_ATTRIBUTE = 'data-direction';
