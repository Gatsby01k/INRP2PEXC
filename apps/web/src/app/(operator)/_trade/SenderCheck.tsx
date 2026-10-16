'use client';

import { useState } from 'react';
import type { DeskLeg } from '@inrp2p/desk';
import { Button } from '@inrp2p/ui';
import { acceptSenderAction, checkSenderAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { TextField } from '../_desk/fields.tsx';
import { time } from '../_desk/format.ts';
import { Chip, Notice, type Tone } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

type Source = NonNullable<DeskLeg['inrSource']>;

const VERDICT: Record<Source['verdict'], { label: string; tone: Tone }> = {
  NOT_CHECKED: { label: 'Sender not checked', tone: 'warning' },
  UNKNOWN: { label: 'Sender not shown', tone: 'warning' },
  PARTIAL: { label: 'Partial match', tone: 'warning' },
  MATCH: { label: 'Client’s own account', tone: 'success' },
  ACCEPTED: { label: 'Accepted as the client’s own', tone: 'success' },
  MISMATCH: { label: 'Someone else paid', tone: 'danger' },
};

const HOW: Record<string, string> = { EXACT: '=', SPELLING: '≈', TRUNCATED: '…', INITIAL: 'initial' };

/**
 * Who sent the rupees (ADR 0018), where the desk decides whether a client's payment counts. The account the payment
 * was declared from; what the statement or a person saw as its sender, word by word against the holder's name; and
 * the verdict that gates "Confirm received". The desk checks by typing what the bank shows — never by ticking a box.
 */
export function SenderCheck({ source, open }: { source: Source; open: boolean }) {
  const cmd = useCommand();
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const latest = source.checks[0] ?? null;
  const verdict = VERDICT[source.verdict];
  const canCheck = open && source.verdict !== 'MISMATCH';

  return (
    <div className={t.sender} data-testid="sender-check">
      <div className={t.senderHead}>
        <span className={d.fieldLabel}>Sender</span>
        <Chip tone={verdict.tone} {...(source.verdict === 'MATCH' || source.verdict === 'ACCEPTED' ? { glyph: 'done' as const } : {})}>
          {verdict.label}
        </Chip>
        <span className={d.muted}>filed by {source.filedBy === 'CLIENT' ? 'the client' : source.filedBy === 'TRADER' ? 'the trader' : 'the desk'}</span>
      </div>
      <dl className={t.senderFacts}>
        <div>
          <dt>Declared from</dt>
          <dd>{source.declared ? `${source.declared.bankName} ••${source.declared.last4} · ${source.declared.holderName}` : 'not declared — any of the payer’s registered accounts'}</dd>
        </div>
        {latest && (latest.seenName || latest.seenAccount) ? (
          <div>
            <dt>{latest.via === 'STATEMENT' ? 'Statement shows' : 'Seen in the bank'}</dt>
            <dd>
              {latest.seenName ?? '—'}
              {latest.seenAccount ? <span className={d.mono}> · {latest.seenAccount}</span> : null}
              <span className={d.muted}> · {time(latest.checkedAt)}</span>
            </dd>
          </div>
        ) : null}
      </dl>
      {latest && latest.pairs.length > 0 ? (
        <ol className={t.senderWords} aria-label="Name, word by word">
          {latest.pairs.map((p, i) => (
            <li key={`${p.seen}-${i}`} data-match={p.how ? (p.how === 'INITIAL' ? 'weak' : 'yes') : 'no'}>
              <span className={d.mono}>{p.seen}</span>
              <span className={t.senderHow}>{p.how ? `${HOW[p.how]} ${p.expected}` : 'not the holder’s'}</span>
            </li>
          ))}
          {latest.account && latest.account !== 'NOT_SHOWN' ? (
            <li data-match={latest.account === 'SAME' ? 'yes' : 'no'}>
              <span>account</span>
              <span className={t.senderHow}>{latest.account === 'SAME' ? 'same last digits' : 'different account'}</span>
            </li>
          ) : null}
        </ol>
      ) : null}
      {source.verdict === 'ACCEPTED' && latest?.reason ? <span className={d.fieldHint}>Accepted: {latest.reason}</span> : null}

      {source.verdict === 'MISMATCH' ? (
        <Notice tone="danger" icon="flag">
          These rupees came from someone other than the payer. They never count: send them back to the account they came from — not to the client — and mark the payment not received.
        </Notice>
      ) : null}

      {canCheck ? (
        <div className={t.senderForm}>
          <span className={d.fieldHint}>
            {source.verdict === 'NOT_CHECKED' || source.verdict === 'UNKNOWN'
              ? 'Open the credit in the collection account and type the sender exactly as the bank shows it.'
              : 'Check again with what the bank shows, if it says more.'}
          </span>
          <div className={d.formGrid}>
            <TextField label="Sender name on the credit" value={name} onChange={setName} placeholder="RAHUL KUMAR SHARMA" maxLength={140} />
            <TextField label="Sender account or UPI ID (if shown)" value={account} onChange={setAccount} placeholder="XXXXXX1234 or name@bank" maxLength={80} mono />
          </div>
          <div className={d.actions}>
            <Button
              size="sm"
              disabled={cmd.busy || name.trim().length < 2}
              onClick={() =>
                void cmd
                  .run('Check the sender', (key) => checkSenderAction({ transferId: source.transferId, senderName: name.trim(), senderAccount: account.trim() || null }, key))
                  .then((r) => {
                    if (r.ok) {
                      setName('');
                      setAccount('');
                    }
                  })
              }
            >
              Check sender
            </Button>
            {source.verdict === 'PARTIAL' ? (
              <GuardedAction
                label="Accept as the client’s own"
                stepUp
                busy={cmd.busy}
                consequence="The payment can then be confirmed. Accept only what you saw is the payer’s own account — its number on the bank’s screen, say — never a relative’s or a friend’s."
                reasonLabel="What you saw"
                placeholder="account ••1234 on the credit is the client’s registered HDFC account"
                onConfirm={async (reason) => (await cmd.run('Accept the sender', (key) => acceptSenderAction({ transferId: source.transferId, reason }, key))).ok}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}

/** Whether the payment may be confirmed now, and if not, what stops it — the button says so instead of failing. */
export function senderGate(source: DeskLeg['inrSource']): string | null {
  if (!source) return null;
  if (source.verdict === 'MATCH' || source.verdict === 'ACCEPTED') return null;
  if (source.verdict === 'MISMATCH') return 'Someone else paid — it is returned, never confirmed.';
  if (source.verdict === 'PARTIAL') return 'The sender only partly matches — check it again or accept it first.';
  return 'Check who sent it first.';
}
