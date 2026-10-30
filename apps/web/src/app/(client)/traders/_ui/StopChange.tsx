'use client';

import { useCommand } from '../../../../components/useCommand.tsx';
import { cancelSettlementChangeAction } from '../../../../server/actions/traders.ts';
import { sentence } from './format.ts';
import shell from '../../shell.module.css';

/**
 * "This was not me": stops a change of where the trader is paid before it takes effect (ADR 0024). Any administrator,
 * no code — the person who did not make the change must be able to stop it at once.
 */
export function StopChange() {
  const cmd = useCommand();
  return (
    <div>
      <button type="button" className={shell.textAction} disabled={cmd.busy} onClick={() => void cmd.run('Stop the change of your settlement details', (key) => cancelSettlementChangeAction(key))}>
        Stop this change
      </button>
      {cmd.error ? (
        <p className={shell.error} role="alert">
          {sentence(cmd.error)}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
