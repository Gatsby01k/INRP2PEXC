'use client';

import { useEffect, useRef, useState } from 'react';
import type { HeroVoiceCopy } from '../../../../content/site.ts';
import { robotCues } from '../robot/cues.ts';
import { type Clock, VoiceController } from './controller.ts';
import { createBrowserSpeaker } from './speaker.ts';
import styles from './voice.module.css';

/**
 * The robot's voice, and the control that mutes it.
 *
 * The voice listens to the same cues as the robot's body and answers a few of them in words (`controller.ts`).
 * The control stays out of sight — its space kept, so nothing moves — until the device turns out to have a voice
 * worth using; where none exists there is nothing to mute and it never appears. The visitor's choice is kept
 * in this browser, as a convenience: losing it only means the voice is on again next time.
 */
const PREFERENCE_KEY = 'inrp2p.robot-voice';

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writePreference(on: boolean): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, on ? 'on' : 'off');
  } catch {
    // Not stored; the choice holds for this visit.
  }
}

const clock: Clock = {
  now: () => performance.now() / 1000,
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (typeof handle === 'number') window.clearTimeout(handle);
  },
};

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      {on ? (
        <path d="M10.6 5.8a3 3 0 0 1 0 4.4 M12.4 4.2a5.3 5.3 0 0 1 0 7.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : (
        <path d="M10.8 6.2l3.4 3.6 M14.2 6.2l-3.4 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function VoiceControl({ copy }: { copy: HeroVoiceCopy }) {
  const [available, setAvailable] = useState(false);
  const [on, setOn] = useState(true);
  const controller = useRef<VoiceController | null>(null);
  const lines = useRef(copy.lines);

  useEffect(() => {
    const speaker = createBrowserSpeaker();
    if (!speaker) return;
    const enabled = readPreference();
    setOn(enabled);
    const voice = new VoiceController({ speaker, clock, lines: lines.current, muted: !enabled });
    controller.current = voice;
    const stopAvailability = speaker.onAvailability(setAvailable);
    const stopCues = robotCues.subscribe((cue) => voice.onCue(cue));
    // A line is never left playing once the visitor has looked away or left.
    const hush = () => {
      if (document.visibilityState === 'hidden') speaker.cancel();
    };
    const leave = () => speaker.cancel();
    document.addEventListener('visibilitychange', hush);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hush);
      window.removeEventListener('pagehide', leave);
      stopCues();
      stopAvailability();
      voice.dispose();
      speaker.dispose();
      controller.current = null;
    };
  }, []);

  const toggle = () => {
    const next = !on;
    setOn(next);
    writePreference(next);
    controller.current?.setMuted(!next);
  };

  return (
    <button
      type="button"
      className={styles.control}
      data-available={available ? 'true' : 'false'}
      aria-pressed={on}
      title={on ? copy.on : copy.off}
      onClick={toggle}
    >
      <SpeakerIcon on={on} />
      <span>{copy.control}</span>
    </button>
  );
}
