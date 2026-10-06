'use client';

import type { NewBusinessState } from '@inrp2p/trades';
import { setNewBusinessAction } from '../../../server/actions/operations.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { dateTime } from '../_desk/format.ts';
import { Chip, Notice, Section } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

/**
 * New business, open or paused (RUNBOOKS `pause-new-business`). Pausing stops new requests, quotes, acceptances and
 * trader offers — in the commands and in the database — and never touches what is already started.
 */
export function NewBusinessControl({ state, canChange }: { state: NewBusinessState; canChange: boolean }) {
  const cmd = useCommand();
  return (
    <Section
      title="New business"
      hint="Pausing stops new requests, quotes, acceptances and trader offers. Trades already started settle as usual."
      actions={<Chip tone={state.paused ? 'danger' : 'success'}>{state.paused ? 'Paused' : 'Open'}</Chip>}
    >
      <div className={d.stackTight} data-testid="new-business">
        {state.paused ? (
          <Notice tone="danger" icon="exceptions" role="status">
            <strong>New business is paused</strong>
            {state.since ? ` since ${dateTime(state.since)}` : ''}
            {state.setBy ? ` by ${state.setBy}` : ''}: {state.reason}
          </Notice>
        ) : state.since ? (
          <p className={d.fieldHint}>
            Open since {dateTime(state.since)}
            {state.setBy ? ` (${state.setBy})` : ''}: {state.reason}
          </p>
        ) : null}
        {canChange ? (
          <div className={d.actions}>
            <GuardedAction
              label={state.paused ? 'Resume new business' : 'Pause new business'}
              trigger={state.paused ? 'secondary' : 'ghost'}
              tone={state.paused ? 'neutral' : 'danger'}
              stepUp
              busy={cmd.busy}
              consequence={
                state.paused
                  ? 'Requests, quotes, acceptances and trader offers are allowed again. Quotes that expired meanwhile are re-quoted, not revived.'
                  : 'No new request, quote, acceptance or trader offer until it is resumed. Started trades, payouts, deliveries and refunds go on.'
              }
              reasonLabel="Why"
              onConfirm={async (reason) => (await cmd.run(state.paused ? 'Resume new business' : 'Pause new business', (key) => setNewBusinessAction({ paused: !state.paused, reason }, key))).ok}
            />
          </div>
        ) : (
          <p className={d.fieldHint}>Pausing or resuming needs the owner or finance role.</p>
        )}
        {cmd.error ? (
          <p className={d.errorLine} role="alert">
            {cmd.error}
          </p>
        ) : null}
        {cmd.dialog}
      </div>
    </Section>
  );
}
