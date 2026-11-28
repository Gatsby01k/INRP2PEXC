'use client';

import { useState } from 'react';
import type { RobotAnswers, RobotOutreach } from '@inrp2p/db';
import type { RobotIntel } from '@inrp2p/robot';
import { answerRobotCaseAction, closeRobotCaseAction, setRobotPolicyAction } from '../../../server/actions/robot-desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { DataTable } from '../_desk/DataTable.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { Checkbox, TextArea, TextField } from '../_desk/fields.tsx';
import { Chip } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

type Policy = RobotIntel['policy'];

const OUTREACH: Record<RobotOutreach, { label: string; consequence: string }> = {
  OFF: { label: 'Off', consequence: 'The robot decides nothing and sends nothing outside the app. It still answers questions and shows people their next step in the app.' },
  DRY_RUN: { label: 'Dry run', consequence: 'The robot decides exactly as it would and records every message under Activity — and sends none of them.' },
  ON: { label: 'On', consequence: 'The robot writes to people stuck on their way in: at most one message a person a day, never at night, only with their consent, inbox plus one channel.' },
};

/**
 * What the robot may do on its own (ADR 0034 §2.1) — the owner's switch, with step-up and a reason — and the playbooks
 * it runs, each of which can be switched off on its own.
 */
export function RobotControls({ policy, canSet, aiConfigured, playbooks }: { policy: Policy; canSet: boolean; aiConfigured: boolean; playbooks: readonly { key: string; label: string }[] }) {
  const cmd = useCommand();
  const [from, setFrom] = useState(String(policy.quietFrom));
  const [to, setTo] = useState(String(policy.quietTo));
  const [limit, setLimit] = useState(String(policy.aiDailyLimit));
  const [off, setOff] = useState<readonly string[]>(policy.playbooksOff);
  const hour = (v: string) => (/^\d{1,2}$/.test(v) && Number.parseInt(v, 10) <= 23 ? Number.parseInt(v, 10) : null);
  const save = (label: string, change: Record<string, unknown>) => async (reason: string) =>
    (await cmd.run(label, (k) => setRobotPolicyAction({ expectedPolicyId: policy.id, reason, ...change }, k))).ok;
  const changed = hour(from) !== policy.quietFrom || hour(to) !== policy.quietTo || limit !== String(policy.aiDailyLimit) || off.join() !== [...policy.playbooksOff].join();
  const valid = hour(from) !== null && hour(to) !== null && /^\d{1,5}$/.test(limit);

  return (
    <div className={d.stack}>
      {cmd.dialog}
      <div className={d.row}>
        <Chip tone={policy.outreach === 'ON' ? 'success' : policy.outreach === 'DRY_RUN' ? 'warning' : 'neutral'}>Outreach: {OUTREACH[policy.outreach].label}</Chip>
        <Chip tone={policy.answers === 'AI' ? (aiConfigured ? 'success' : 'warning') : 'neutral'}>
          Answers: {policy.answers === 'AI' ? `rules, then a model${aiConfigured ? '' : ' (not configured)'}` : 'rules, then a person'}
        </Chip>
        <Chip tone="neutral">{policy.quietFrom === policy.quietTo ? 'No quiet hours' : `Quiet ${String(policy.quietFrom).padStart(2, '0')}:00–${String(policy.quietTo).padStart(2, '0')}:00 IST`}</Chip>
      </div>
      {canSet ? (
        <>
          <div className={d.row}>
            {(['OFF', 'DRY_RUN', 'ON'] as const).filter((o) => o !== policy.outreach).map((o) => (
              <GuardedAction
                key={o}
                label={o === 'ON' ? 'Switch outreach on' : o === 'DRY_RUN' ? 'Back to a dry run' : 'Switch outreach off'}
                tone={o === 'ON' ? 'neutral' : 'danger'}
                stepUp
                reasonLabel="Reason"
                minReason={10}
                consequence={OUTREACH[o].consequence}
                busy={cmd.busy}
                onConfirm={save(`Robot outreach ${OUTREACH[o].label}`, { outreach: o })}
              />
            ))}
            <GuardedAction
              label={policy.answers === 'AI' ? 'Answer with rules only' : 'Let a model answer too'}
              stepUp
              reasonLabel="Reason"
              minReason={10}
              consequence={policy.answers === 'AI'
                ? 'Questions no rule knows go straight to a person.'
                : `Questions no rule knows go to the model, with only that person’s facts in words; an answer with a figure it was not given goes to a person instead.${aiConfigured ? '' : ' No model is configured yet: set ANTHROPIC_API_KEY on the web app.'}`}
              busy={cmd.busy}
              onConfirm={save('Robot answers', { answers: (policy.answers === 'AI' ? 'RULES' : 'AI') satisfies RobotAnswers })}
            />
          </div>
          <div className={d.row}>
            <TextField label="Quiet from, IST hour" value={from} onChange={setFrom} mono />
            <TextField label="Quiet to, IST hour" value={to} onChange={setTo} mono />
            <TextField label="Model answers a day" value={limit} onChange={setLimit} mono />
          </div>
          <fieldset className={d.stackTight} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className={d.fieldLabel}>Playbooks</legend>
            {playbooks.map((p) => (
              <Checkbox key={p.key} label={p.label} checked={!off.includes(p.key)} onChange={(on) => setOff(on ? off.filter((k) => k !== p.key) : [...off, p.key])} />
            ))}
          </fieldset>
          <div className={d.row}>
            <GuardedAction
              label="Save hours, limit and playbooks"
              stepUp
              reasonLabel="Reason"
              minReason={10}
              disabled={!changed || !valid}
              disabledReason={!valid ? 'Hours are 0 to 23; the limit a whole number.' : !changed ? 'Nothing changed.' : null}
              consequence="The robot uses these from its next round."
              busy={cmd.busy}
              onConfirm={save('Robot settings', { quietFrom: hour(from), quietTo: hour(to), aiDailyLimit: Number.parseInt(limit, 10), playbooksOff: [...off] })}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** One question the robot passed on: what was asked, what the robot knew then, and the answer that goes back. */
export function RobotCases({ cases, canAnswer }: { cases: RobotIntel['openCases']; canAnswer: boolean }) {
  return (
    <div className={d.stack}>
      {cases.map((c) => (
        <RobotCase key={c.ref} c={c} canAnswer={canAnswer} />
      ))}
    </div>
  );
}

function RobotCase({ c, canAnswer }: { c: RobotIntel['openCases'][number]; canAnswer: boolean }) {
  const cmd = useCommand();
  const [answer, setAnswer] = useState('');
  const [done, setDone] = useState<string | null>(null);
  if (done) return <p className={d.muted}>{c.ref} — {done}</p>;
  return (
    <article className={d.stackTight} data-testid={`robot-case-${c.ref}`}>
      {cmd.dialog}
      <div className={d.row}>
        <strong>{c.who}</strong>
        <Chip tone="neutral">{c.channel === 'TELEGRAM' ? 'Telegram' : 'In the app'}</Chip>
        <span className={d.muted}>{c.ref} · {new Date(c.updatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} IST</span>
      </div>
      <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{c.question}</p>
      {c.context ? (
        <details>
          <summary className={d.muted}>What the robot knew</summary>
          <p className={d.muted} style={{ whiteSpace: 'pre-line', margin: '6px 0 0' }}>{c.context}</p>
        </details>
      ) : null}
      {canAnswer ? (
        <>
          <TextArea label="Answer" value={answer} onChange={setAnswer} rows={3} hint="It reaches them where they asked — their Telegram or the app — in your words." />
          <div className={d.row}>
            <GuardedAction
              label="Send the answer"
              disabled={answer.trim().length < 2}
              disabledReason={answer.trim().length < 2 ? 'Write the answer first.' : null}
              consequence="The person gets it now; the question closes."
              busy={cmd.busy}
              onConfirm={async () => {
                const ok = (await cmd.run('Answer sent', (k) => answerRobotCaseAction({ caseRef: c.ref, answer: answer.trim() }, k))).ok;
                if (ok) setDone('answered');
                return ok;
              }}
            />
            <GuardedAction
              label="Close without an answer"
              tone="danger"
              reasonLabel="Why"
              minReason={3}
              consequence="Nothing is sent; the question closes with your reason."
              busy={cmd.busy}
              onConfirm={async (reason) => {
                const ok = (await cmd.run('Question closed', (k) => closeRobotCaseAction({ caseRef: c.ref, reason }, k))).ok;
                if (ok) setDone('closed');
                return ok;
              }}
            />
          </div>
        </>
      ) : null}
    </article>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function RobotFunnel({ steps }: { steps: RobotIntel['funnel'] }) {
  return (
    <DataTable
      caption="Who is stuck where"
      rowKey={(r) => r.key}
      rows={steps}
      rail={(r) => (r.people > 0 && (r.oldestHours ?? 0) >= 24 ? 'action' : null)}
      dim={(r) => r.people === 0}
      columns={[
        { key: 'step', header: 'Where', render: (r) => r.label },
        { key: 'n', header: 'People', align: 'right', render: (r) => r.people },
        { key: 'oldest', header: 'Longest there', align: 'right', render: (r) => (r.people === 0 || r.oldestHours === null ? '—' : r.oldestHours < 48 ? `${r.oldestHours} h` : `${Math.round(r.oldestHours / 24)} days`) },
      ]}
    />
  );
}

export function RobotPlaybooks({ rows }: { rows: RobotIntel['playbooks'] }) {
  return (
    <DataTable
      caption="What it sent in 30 days, and what came of it"
      rowKey={(r) => r.key}
      rows={rows}
      empty="Nothing yet."
      columns={[
        { key: 'p', header: 'Playbook', render: (r) => r.label },
        { key: 'sent', header: 'Sent', align: 'right', render: (r) => r.sent },
        { key: 'dry', header: 'Dry run', align: 'right', render: (r) => r.dryRun },
        { key: 'acted', header: 'Then acted', align: 'right', render: (r) => r.acted },
        { key: 'rate', header: 'Rate', align: 'right', render: (r) => (r.sent + r.dryRun === 0 ? '—' : `${Math.round((100 * r.acted) / (r.sent + r.dryRun))}%`) },
        { key: 'failed', header: 'Not delivered', align: 'right', render: (r) => r.failed || '—' },
      ]}
    />
  );
}

export function RobotActivity({ rows }: { rows: RobotIntel['recent'] }) {
  return (
    <DataTable
      caption="Activity"
      rowKey={(r) => `${r.at}-${r.playbook}-${r.who}`}
      rows={rows}
      empty="The robot has not decided anything yet."
      dim={(r) => r.mode === 'DRY_RUN'}
      columns={[
        { key: 'at', header: 'When (IST)', render: (r) => when(r.at) },
        { key: 'who', header: 'To', render: (r) => r.who },
        { key: 'what', header: 'What', wrap: true, render: (r) => r.title },
        { key: 'how', header: 'How', render: (r) => (r.mode === 'DRY_RUN' ? `would: ${r.channel?.toLowerCase() ?? 'inbox'}` : `${r.channel?.toLowerCase() ?? 'inbox'} · ${r.delivery.toLowerCase()}`) },
        { key: 'acted', header: '', render: (r) => (r.acted ? <Chip tone="success">acted</Chip> : null) },
      ]}
    />
  );
}
