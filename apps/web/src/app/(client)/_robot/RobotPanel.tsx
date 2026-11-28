'use client';

import { type FormEvent, useState } from 'react';
import Link from 'next/link';
import type { RobotConsent } from '@inrp2p/db';
import type { AskResult, RobotBrief } from '@inrp2p/robot';
import { newIntentKey } from '../../../components/useCommand.tsx';
import { askRobotAction, setRobotConsentAction, snoozeRobotAction } from '../../../server/actions/robot.ts';
import { SendIcon } from '../_workspace/icons.tsx';
import { StateRing } from '../_workspace/StateRing.tsx';
import shell from '../shell.module.css';
import { RobotFace } from './RobotFace.tsx';
import styles from './robot.module.css';

/** The kinds that are the person's move or the robot's news: the page's one orange moment. */
const FIELD: ReadonlySet<RobotBrief['kind']> = new Set(['MOVE', 'PRICE', 'STEP']);

const CONSENT: readonly { value: RobotConsent; title: string; detail: string }[] = [
  { value: 'ALL', title: 'Everything', detail: 'Also when someone wants what I have' },
  { value: 'SERVICE', title: 'What I started', detail: 'Requests, setup, my deals' },
  { value: 'NONE', title: 'Nothing', detail: 'Only here in the app' },
];

/** Questions worth one tap, from what the robot is showing. */
function suggestionsFor(brief: RobotBrief): string[] {
  const out: string[] = [];
  if (brief.kind === 'SEARCH' || brief.kind === 'DEAL' || brief.kind === 'MOVE') out.push('Where is my deal?');
  out.push("What's the rate today?");
  if (brief.kind !== 'MOVE' && brief.kind !== 'DEAL') out.push('How does selling work?');
  out.push('Is it safe?');
  out.push('Talk to a person');
  return out.slice(0, 4);
}

/**
 * What the robot says when opened — in the masthead's sheet and on its own page: the one thing that matters now with its
 * one action, what it is doing meanwhile, what it remembers, a question to ask it, and what it may send outside the app.
 */
export function RobotPanel({ brief, onNavigate, onChange }: { brief: RobotBrief; onNavigate?: (() => void) | undefined; onChange?: (() => void) | undefined }) {
  const navigate = () => onNavigate?.();
  const field = FIELD.has(brief.kind);
  const [snoozing, setSnoozing] = useState(false);
  const [consent, setConsent] = useState<RobotConsent>(brief.consent);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [said, setSaid] = useState<{ q: string; a: AskResult }[]>([]);

  async function snooze() {
    if (!brief.playbook) return;
    setSnoozing(true);
    const out = await snoozeRobotAction({ playbook: brief.playbook }, newIntentKey()).catch(() => null);
    setSnoozing(false);
    if (out?.ok) onChange?.();
  }

  async function choose(value: RobotConsent) {
    if (value === consent) return;
    const before = consent;
    setConsent(value);
    setConsentError(null);
    const out = await setRobotConsentAction({ outreach: value }, newIntentKey()).catch(() => null);
    if (!out?.ok) {
      setConsent(before);
      setConsentError(out && !out.ok ? out.message : 'That did not save. Try again.');
    }
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAskError(null);
    const out = await askRobotAction({ text: q }).catch(() => null);
    setAsking(false);
    if (!out?.ok) {
      setAskError(out && !out.ok ? out.message : 'I could not answer just now. Try again in a moment.');
      return;
    }
    setText('');
    setSaid((s) => [...s.slice(-3), { q, a: out.result }]);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(text);
  }

  return (
    <div className={styles.panel}>
      <section className={field ? `${styles.hero} ${shell.brandField}` : styles.hero} data-kind={brief.kind} aria-live="polite">
        <div className={styles.heroHead}>
          <RobotFace face={brief.face} size={72} />
          <span className={`${styles.visor} ${shell.visor} ${shell.led}`}>{brief.visor}</span>
        </div>
        <div className={styles.heroText}>
          <h2 className={styles.heroTitle}>{brief.title}</h2>
          <p className={styles.heroBody}>{brief.body}</p>
        </div>
        {brief.action || brief.playbook ? (
          <div className={styles.heroActions}>
            {brief.action ? (
              <Link href={brief.action.href} className={shell.action} {...(field ? { 'data-tone': 'ink' } : {})} onClick={navigate}>
                {brief.action.label}
              </Link>
            ) : null}
            {brief.playbook ? (
              <button type="button" className={styles.later} onClick={() => void snooze()} disabled={snoozing}>
                Not now
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {brief.working ? (
        <p className={styles.working}>
          <StateRing state="wait" className={styles.workingRing} />
          {brief.working}
        </p>
      ) : null}

      {brief.question ? (
        <section className={styles.section} aria-label="Your question">
          <h3 className={styles.sectionTitle}>{brief.question.status === 'ANSWERED' ? 'The desk answered' : 'With the desk'} · {brief.question.ref}</h3>
          <div className={styles.question}>
            <q>{brief.question.question}</q>
            {brief.question.answer ? <p>{brief.question.answer}</p> : <p>A person at INRP2P has it. The answer comes here{brief.reach.telegram ? ' and on Telegram' : ''}.</p>}
          </div>
        </section>
      ) : null}

      {brief.remembers.length > 0 ? (
        <section className={styles.section} aria-label="What the robot remembers">
          <h3 className={styles.sectionTitle}>I remember</h3>
          <ul className={styles.memory}>
            {brief.remembers.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.ask} aria-label="Your questions">
        {said.length > 0 ? (
          <div className={styles.exchange} aria-live="polite">
            {said.map(({ q, a }, i) => (
              <div key={i} className={styles.exchange}>
                <p className={styles.said}>{q}</p>
                <div className={styles.answer}>
                  <RobotFace face={a.source === 'CASE' ? 'dots' : 'happy'} size={28} />
                  <div className={styles.answerText}>
                    <span>{a.answer}</span>
                    {a.action ? (
                      <Link className={styles.answerLink} href={a.action.href} onClick={navigate}>
                        {a.action.label} →
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.suggestions}>
            {suggestionsFor(brief).map((s) => (
              <button key={s} type="button" className={styles.suggestion} onClick={() => void ask(s)} disabled={asking}>
                {s}
              </button>
            ))}
          </div>
        )}
        <form className={styles.askRow} onSubmit={submit}>
          <label className="ix-visually-hidden" htmlFor="robot-ask">
            Ask the robot
          </label>
          <input
            id="robot-ask"
            className={styles.askInput}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask about your deal, a rate, anything"
            maxLength={1000}
            autoComplete="off"
          />
          <button type="submit" className={styles.askSend} disabled={asking || text.trim().length === 0} aria-label="Ask" aria-busy={asking}>
            <SendIcon className={shell.toolIcon} />
          </button>
        </form>
        {askError ? <p className={styles.reach} role="alert">{askError}</p> : null}
      </section>

      <section className={styles.consent} aria-label="Messages outside the app">
        <h3 className={styles.sectionTitle}>Messages outside the app</h3>
        <div className={styles.choices} role="radiogroup" aria-label="What the robot may send you">
          {CONSENT.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={consent === c.value} className={styles.choice} onClick={() => void choose(c.value)}>
              <b>{c.title}</b>
              <span>{c.detail}</span>
            </button>
          ))}
        </div>
        <p className={styles.reach}>
          {consentError ??
            (brief.reach.telegram
              ? 'It writes to your Telegram — at most once a day, never at night.'
              : brief.reach.push
                ? 'It notifies this browser — at most once a day, never at night.'
                : brief.reach.email
                  ? 'It writes by email — at most once a day, never at night. '
                  : 'Nowhere to reach you outside the app yet. ')}
          {!consentError && !brief.reach.telegram ? <Link href="/account" onClick={navigate}>Connect Telegram</Link> : null}
        </p>
      </section>
    </div>
  );
}
