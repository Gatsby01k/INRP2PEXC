'use client';

import type { SoundCue } from './model.ts';

/**
 * The workspace's sounds: three, each for one kind of meaningful event (`model.ts` `soundForTransition`) — a firm
 * quote arriving, a quote accepted or a trade settled, something coming to need the client. Nothing else sounds:
 * not typing, focus, hover, tabs or ordinary waiting.
 *
 * Each is a short, quiet, tactile figure — a felt mallet on a soft surface, a fraction of a second — synthesised
 * on the spot with Web Audio. There is no file to fetch and nothing to wait for, so a sound can never hold the
 * interface up: if the audio device is not ready at that instant, the sound is simply skipped.
 *
 * Off by default for anyone who asked for reduced motion (the closest the platform comes to "fewer sensory
 * effects"), on otherwise, and the client's own choice from the masthead overrides both and is remembered on this
 * device. Nothing plays while the page is hidden, and the audio device is only opened by the client's own
 * gesture, as browsers require.
 */

const STORAGE_KEY = 'inrp2p.workspace.sound';
const MASTER_GAIN = 0.1;

type Listener = () => void;
const listeners = new Set<Listener>();
let context: AudioContext | null = null;
let unlockWired = false;

function storedChoice(): boolean | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}

/** Whether sounds are on for this client on this device. */
export function soundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const chosen = storedChoice();
  if (chosen !== null) return chosen;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function setSoundEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode or storage blocked: the choice holds for this page only.
  }
  if (on) void openContext();
  for (const l of listeners) l();
}

export function subscribeSound(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens (or resumes) the audio device. Only ever called from the client's own gesture. */
async function openContext(): Promise<void> {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  context ??= new Ctor({ latencyHint: 'interactive' });
  if (context.state === 'suspended') await context.resume().catch(() => undefined);
}

/**
 * Wires the one-time unlock: the first press or key anywhere in the workspace opens the audio device, if sounds
 * are on. Before that, a sound is skipped rather than queued — a late chime would be about something that is
 * already on screen.
 */
export function wireSoundUnlock(): void {
  if (unlockWired || typeof window === 'undefined') return;
  unlockWired = true;
  const unlock = () => {
    if (!soundEnabled()) return;
    void openContext();
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

/**
 * One strike of a felt mallet: a sine at the note with a soft octave above it that fades faster, a four-millisecond
 * onset (tactile, not clicky) and an exponential decay. `bright` sets how much of the octave is heard.
 */
function strike(ctx: AudioContext, out: AudioNode, at: number, freq: number, level: number, decay: number, bright = 0.28): void {
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(freq, at);
  const overtone = ctx.createOscillator();
  overtone.type = 'sine';
  overtone.frequency.setValueAtTime(freq * 2, at);

  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0, at);
  bodyGain.gain.linearRampToValueAtTime(level, at + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  const overtoneGain = ctx.createGain();
  overtoneGain.gain.setValueAtTime(0, at);
  overtoneGain.gain.linearRampToValueAtTime(level * bright, at + 0.003);
  overtoneGain.gain.exponentialRampToValueAtTime(0.0001, at + decay * 0.45);

  body.connect(bodyGain).connect(out);
  overtone.connect(overtoneGain).connect(out);
  body.start(at);
  overtone.start(at);
  body.stop(at + decay + 0.02);
  overtone.stop(at + decay + 0.02);
}

/** The three figures. Notes in Hz; times in seconds from now. Each is over in well under a second. */
const FIGURES: Record<SoundCue, { tone: number; strikes: readonly { at: number; freq: number; level: number; decay: number; bright?: number }[] }> = {
  // A quote arrives: two light strikes rising a fourth — something has come in.
  quote: {
    tone: 2600,
    strikes: [
      { at: 0, freq: 659.25, level: 0.55, decay: 0.22 },
      { at: 0.075, freq: 880, level: 0.5, decay: 0.3 },
    ],
  },
  // Accepted or settled: a soft third, then the fifth above it — resolved, and a little warmer.
  success: {
    tone: 2400,
    strikes: [
      { at: 0, freq: 440, level: 0.42, decay: 0.42 },
      { at: 0, freq: 554.37, level: 0.3, decay: 0.42 },
      { at: 0.09, freq: 659.25, level: 0.45, decay: 0.5 },
    ],
  },
  // Something needs the client: two low, muted knocks on the same note — attention, not alarm.
  alert: {
    tone: 1300,
    strikes: [
      { at: 0, freq: 293.66, level: 0.7, decay: 0.16, bright: 0.12 },
      { at: 0.14, freq: 293.66, level: 0.6, decay: 0.2, bright: 0.12 },
    ],
  },
};

/** Plays one of the workspace's sounds now, or not at all. Never waits, never queues, never throws. */
export function playSound(cue: SoundCue): void {
  try {
    if (!soundEnabled() || document.visibilityState !== 'visible') return;
    const ctx = context;
    if (!ctx || ctx.state !== 'running') return;
    const figure = FIGURES[cue];
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = figure.tone;
    tone.Q.value = 0.5;
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    tone.connect(master).connect(ctx.destination);
    const now = ctx.currentTime + 0.01;
    for (const s of figure.strikes) strike(ctx, tone, now + s.at, s.freq, s.level, s.decay, s.bright);
  } catch {
    // A sound is never worth an error.
  }
}
