'use client';

import dynamic from 'next/dynamic';

/**
 * The confirmation sheet (ADR 0026), loaded when it is first shown. Every page that can change something uses
 * `useCommand`, and a stylesheet in a page from its first byte would hold the page's own reveal until it arrived
 * (React shows a streamed section only with its styles); the sheet is needed only after a press, so it waits until then.
 */
export const ConfirmPanel = dynamic(() => import('./ConfirmIdentity.tsx').then((m) => m.ConfirmPanel), { ssr: false });
export const ConfirmDialog = dynamic(() => import('./ConfirmIdentity.tsx').then((m) => m.ConfirmDialog), { ssr: false });
export const SecondFactorNeeded = dynamic(() => import('./ConfirmIdentity.tsx').then((m) => m.SecondFactorNeeded), { ssr: false });
