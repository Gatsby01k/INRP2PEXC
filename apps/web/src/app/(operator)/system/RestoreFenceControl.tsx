'use client';

import type { RestoreFenceState } from '@inrp2p/trades';
import { decideRestoreFenceLiftAction, raiseRestoreFenceAction, requestRestoreFenceLiftAction } from '../../../server/actions/operations.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { dateTime } from '../_desk/format.ts';
import { Chip, Notice, Section } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

/**
 * Outgoing payments, flowing or held (RUNBOOKS `restore-fence`, migration 0034). After the database was recovered,
 * failed over or moved, nothing leaves the exchange until one person has recorded the reconciliation with the bank and
 * the chain and a second person has approved it. Recording a payment that was already made is never held.
 */
export function RestoreFenceControl({ state, canRaise, canApprove, viewerId }: { state: RestoreFenceState; canRaise: boolean; canApprove: boolean; viewerId: string }) {
  const cmd = useCommand();
  const { fence, lift, toReconcile: r } = state;
  const mine = lift?.requestedById === viewerId;
  return (
    <Section
      title="Outgoing payments"
      hint="After a database recovery, failover or move, nothing leaves the exchange until two people have checked what was paid since."
      actions={<Chip tone={state.held ? 'danger' : 'success'}>{state.held ? 'Held' : 'Flowing'}</Chip>}
    >
      <div className={d.stackTight} data-testid="restore-fence">
        {state.held ? (
          <>
            <Notice tone="danger" icon="exceptions" role="alert">
              <strong>Outgoing payments are held{fence ? ` (${fence.ref})` : ''}.</strong>{' '}
              {fence
                ? `${fence.reason} Raised ${dateTime(fence.raisedAt)} by ${fence.raisedBy}.`
                : 'The database is not the one the workers last wrote to. The worker raises the fence at its next heartbeat; it can also be raised now.'}
              {fence?.knownUntil ? ` Records are known whole until ${dateTime(fence.knownUntil)}.` : ''}
            </Notice>
            <p className={d.fieldHint}>
              Check each against the bank statements and the chain{fence?.knownUntil ? ` since ${dateTime(fence.knownUntil)}` : ''}: {r.payoutLegsToSend} payout leg(s) waiting
              to be sent, {r.payoutLegsInFlight} sent and not confirmed, {r.reserveApplicationsApproved} reserve application(s) approved, {r.reserveWithdrawalsRequested} reserve
              withdrawal(s) requested, {r.routeObligationsOpen} route obligation(s) open, {r.signerSendsOpen} signer transfer(s) open with {r.signerTransactionsLive} transaction(s) the chain
              has not decided (look each txid up: a transfer signed after the records were last whole may have landed). Record every payment already made with its UTR or transaction — that is never held.
            </p>
            {lift ? (
              <Notice tone="warning" icon="exceptions" role="status">
                <strong>Reconciled by {lift.requestedBy}</strong> {dateTime(lift.requestedAt)}: {lift.reconciliation}
              </Notice>
            ) : null}
          </>
        ) : state.lastLifted ? (
          <p className={d.fieldHint}>
            Flowing. Last held under {state.lastLifted.ref}, released {dateTime(state.lastLifted.liftedAt)} by {state.lastLifted.liftedBy}.
          </p>
        ) : null}

        <div className={d.actions}>
          {!fence && canRaise ? (
            <GuardedAction
              label="Hold outgoing payments"
              trigger={state.held ? 'secondary' : 'ghost'}
              tone="danger"
              stepUp
              busy={cmd.busy}
              consequence="No payout or refund is marked sent, and no reserve is applied, until two people release it. New business is paused with it. Recording payments already made stays open."
              reasonLabel="Why (what may have been lost)"
              minReason={10}
              onConfirm={async (reason) => (await cmd.run('Hold outgoing payments', (key) => raiseRestoreFenceAction({ reason }, key))).ok}
            />
          ) : null}
          {fence && !lift && canRaise ? (
            <GuardedAction
              label="Record the reconciliation"
              trigger="secondary"
              stepUp
              busy={cmd.busy}
              consequence="A second person reviews it and releases outgoing payments. Until then they stay held."
              reasonLabel="What was compared, and what was found and recorded"
              minReason={20}
              onConfirm={async (reconciliation) => (await cmd.run('Record the reconciliation', (key) => requestRestoreFenceLiftAction({ reconciliation }, key))).ok}
            />
          ) : null}
          {lift && canApprove && !mine ? (
            <GuardedAction
              label="Approve and release payments"
              trigger="secondary"
              tone="danger"
              stepUp
              busy={cmd.busy}
              consequence="Payout legs can be marked sent and reserves applied again. New business stays paused until it is resumed on its own control."
              reasonLabel="Note"
              onConfirm={async (note) => (await cmd.run('Release outgoing payments', (key) => decideRestoreFenceLiftAction({ liftId: lift.id, approve: true, note }, key))).ok}
            />
          ) : null}
          {lift && canApprove ? (
            <GuardedAction
              label={mine ? 'Withdraw the reconciliation' : 'Decline'}
              trigger="ghost"
              stepUp
              busy={cmd.busy}
              consequence="Outgoing payments stay held; the reconciliation can be recorded again."
              reasonLabel="Why"
              onConfirm={async (note) => (await cmd.run(mine ? 'Withdraw the reconciliation' : 'Decline the reconciliation', (key) => decideRestoreFenceLiftAction({ liftId: lift.id, approve: false, note }, key))).ok}
            />
          ) : null}
        </div>
        {lift && mine ? <p className={d.fieldHint}>Waiting for a second person: whoever recorded the reconciliation does not release the payments.</p> : null}
        {!canRaise && !canApprove ? <p className={d.fieldHint}>Holding and releasing outgoing payments needs the owner or finance role.</p> : null}
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
