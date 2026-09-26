'use client';

import { useEffect, useRef, useState } from 'react';
import type { HeroVoiceCopy } from '../../../../content/site.ts';
import { robotCues } from '../robot/cues.ts';
import { type Clock, VoiceController } from './controller.ts';
import { type VoicePlayer, createVoicePlayer } from './player.ts';
import styles from './voice.module.css';

/**
 * The robot's voice, and the control that turns it on and off.
 *
 * The voice is an extra, never the way anything works: it is off until the visitor turns it on, and the page says
 * and does everything without it. Once on, it listens to the same cues as the robot's body and answers three of
 * them with a recorded line (`controller.ts`); when it speaks, it tells the body, which moves with the line. The
 * clips are fetched only once the voice is on (`player.ts`).
 *
 * The control shows its position in words, not only in its icon. It is drawn once the page knows the browser can
 * play audio at all — its space kept until then, so nothing moves — and not at all where it cannot. The visitor's
 * choice is kept in this browser, as a convenience: losing it only means the voice is off again next time.
 */
const PREFERENCE_KEY = 'inrp2p.robot-voice';

/** The events a browser counts as a gesture that may start audio: a key, a mouse press, the end of a tap. */
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'] as const;

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === 'on';
  } catch {
    return false;
  }
}

function writePreference(on: boolean): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, on ? 'on' : 'off');
  } catch {
    // Not stored; the choice holds for this visit.
  }
}

const clock: Clock = { now: () => performance.now() / 1000 };

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
  const [on, setOn] = useState(false);
  const controller = useRef<VoiceController | null>(null);
  const audio = useRef<VoicePlayer | null>(null);

  useEffect(() => {
    const player = createVoicePlayer();
    if (!player) return;
    const enabled = readPreference();
    setOn(enabled);
    setAvailable(true);
    if (enabled) player.enable();
    audio.current = player;
    const voice = new VoiceController({ player, clock, muted: !enabled, onRobot: (cue) => robotCues.emit(cue) });
    controller.current = voice;
    // Clips that arrive while a greeting is still in time for them let it be said.
    player.onLoaded(() => voice.unlocked());
    const stopCues = robotCues.subscribe((cue) => voice.onCue(cue));
    // Audio is unlocked by the visitor's own gestures, on the window and before the page's handlers see them, so
    // a press that is also the visitor's first move is heard at once.
    const gesture = () => {
      if (player.unlock()) voice.unlocked();
    };
    for (const type of GESTURES) window.addEventListener(type, gesture, { capture: true, passive: true });
    // A line is never left playing once the visitor has looked away or left.
    const hush = () => {
      if (document.visibilityState === 'hidden') voice.hush();
    };
    const leave = () => voice.hush();
    document.addEventListener('visibilitychange', hush);
    window.addEventListener('pagehide', leave);
    return () => {
      for (const type of GESTURES) window.removeEventListener(type, gesture, { capture: true });
      document.removeEventListener('visibilitychange', hush);
      window.removeEventListener('pagehide', leave);
      stopCues();
      voice.dispose();
      player.dispose();
      controller.current = null;
      audio.current = null;
    };
  }, []);

  const toggle = () => {
    const next = !on;
    setOn(next);
    writePreference(next);
    if (next && audio.current) {
      // This press is a gesture: the moment audio may be started, whether or not the clips have arrived yet.
      audio.current.enable();
      audio.current.unlock();
    }
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
      {/* The position, in words; its name and state are already said by the button's name and `aria-pressed`. */}
      <span className={styles.state} aria-hidden="true">
        {on ? copy.state.on : copy.state.off}
      </span>
    </button>
  );
}
