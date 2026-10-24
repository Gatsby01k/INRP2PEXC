import 'server-only';
import { cache } from 'react';
import { deskNow, deskQueue } from '@inrp2p/desk';
import type { OperatorContext } from '../../../server/operator.ts';

/**
 * Reads the shell and a page both need, once per request. The layout counts the queue for the navigation and the
 * Desk lists it; both show the business clock. On a full load or a refresh the layout and the page render in the same
 * request, and these were read twice. `ctx` is itself one object per request (`operatorContext` is cached), so the
 * key is the request: nothing read for one request is ever served to another.
 */
export const queueOf = cache((ctx: OperatorContext) => deskQueue(ctx.db, ctx.access, { limitPerGroup: 50 }));

export const nowOf = cache((ctx: OperatorContext) => deskNow(ctx.db));
