import { VOICE_LINES, type VoiceLine } from '../../../../content/site.ts';
import type { Player } from './controller.ts';

/**
 * The robot's recorded lines, played from memory with the Web Audio API.
 *
 * Nothing is fetched and no audio is set up until the voice is turned on (`enable`): most visitors never turn it
 * on, and they pay nothing for it. From then on, the clips are fetched and decoded once the page has settled and
 * kept decoded; saying a line is starting a buffer already in memory — no request, no decoding, no wait.
 * Decoding needs no audio device, so it happens in an offline context.
 *
 * The live audio context is the one costly step: creating one can hold the main thread for a noticeable
 * fraction of a second while the browser brings up its audio service. For a visitor whose voice was already on,
 * that must land neither on the page's load nor on their first press, so it happens in between: at the first
 * sign someone is there — a pointer moving, a touch starting, a scroll, a key — in the next idle moment, and it
 * is held suspended. A press only resumes it (`unlock`) and plays a silent frame through it, which is what the
 * strictest browsers ask; the press that turns the voice on creates it, since that press is the only gesture
 * there is. The clips are decoded again at the device's own rate then, in the background.
 *
 * AAC where the browser plays it, which is nearly everywhere; 16-bit PCM for the few that cannot.
 */
const CLIPS: Record<VoiceLine, { readonly aac: string; readonly pcm: string }> = {
  ready: { aac: new URL('./clips/ready.m4a', import.meta.url).href, pcm: new URL('./clips/ready.wav', import.meta.url).href },
  received: { aac: new URL('./clips/received.m4a', import.meta.url).href, pcm: new URL('./clips/received.wav', import.meta.url).href },
  check: { aac: new URL('./clips/check.m4a', import.meta.url).href, pcm: new URL('./clips/check.wav', import.meta.url).href },
};

/** The clips' own rate. */
const CLIP_RATE = 48_000;
/** Below full scale: a voice beside a page, not over it. */
const VOLUME = 0.85;
/** A stopped line fades this fast — quick enough to be stopped, slow enough not to click. */
const STOP_FADE = 0.06;
/** The first signs of a visitor, after which the audio context is prepared in the next idle moment. */
const PRESENCE = ['pointermove', 'pointerdown', 'touchstart', 'wheel', 'scroll', 'keydown', 'focusin'] as const;

export interface VoicePlayer extends Player {
  /** The voice is on: fetch the clips once the page has settled, and prepare audio at the first sign of a visitor. */
  enable(): void;
  /** Calls back once every clip is decoded. */
  onLoaded(listener: () => void): void;
  /**
   * Called from the visitor's gestures, once enabled. Resumes the audio context while the browser counts the event
   * as a gesture, and reports whether audio is now running or starting.
   */
  unlock(): boolean;
  dispose(): void;
}

type Ctx = AudioContext;

const idleCallback = (run: () => void, timeout: number): (() => void) => {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, Math.min(timeout, 300));
  return () => window.clearTimeout(handle);
};

/** Null where there is no Web Audio at all; the robot is silent there, and its control is not drawn. */
export function createVoicePlayer(): VoicePlayer | null {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function' || typeof window.OfflineAudioContext !== 'function') return null;

  const aac = document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '';
  const encoded = new Map<VoiceLine, ArrayBuffer>();
  const buffers = new Map<VoiceLine, AudioBuffer>();
  const loadedListeners: (() => void)[] = [];
  const cancels: (() => void)[] = [];
  let enabled = false;
  let loaded = false;
  let disposed = false;
  let ctx: Ctx | null = null;
  let master: GainNode | null = null;
  let current: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  const fetchClip = async (line: VoiceLine, url: string): Promise<AudioBuffer> => {
    const response = await fetch(url, { credentials: 'same-origin', priority: 'low' } as RequestInit);
    if (!response.ok) throw new Error(`${line}: ${response.status}`);
    const bytes = await response.arrayBuffer();
    // Kept encoded too, to decode again at the device's rate once there is a device (decoding detaches it).
    encoded.set(line, bytes.slice(0));
    return new OfflineAudioContext(1, 1, CLIP_RATE).decodeAudioData(bytes);
  };

  const load = async () => {
    for (const line of VOICE_LINES) {
      let buffer: AudioBuffer;
      try {
        buffer = await fetchClip(line, aac ? CLIPS[line].aac : CLIPS[line].pcm);
      } catch {
        // A browser that claimed AAC and could not decode it gets the PCM instead; one without either, silence.
        if (!aac) return;
        try {
          buffer = await fetchClip(line, CLIPS[line].pcm);
        } catch {
          return;
        }
      }
      if (disposed) return;
      buffers.set(line, buffer);
    }
    loaded = true;
    for (const listener of loadedListeners.splice(0)) listener();
  };

  /** Creates the live context, suspended, and decodes the clips again at its rate if that is not theirs. */
  const prepare = (): Ctx | null => {
    if (ctx || disposed) return ctx;
    try {
      const context = new AudioContext({ latencyHint: 'interactive' });
      // Where the browser would let it run straight away it is paused anyway: nothing is live until asked for.
      if (context.state === 'running') void context.suspend().catch(() => {});
      master = context.createGain();
      master.gain.value = VOLUME;
      master.connect(context.destination);
      ctx = context;
    } catch {
      return null;
    }
    if (ctx.sampleRate !== CLIP_RATE) {
      for (const [line, bytes] of encoded) {
        ctx
          .decodeAudioData(bytes.slice(0))
          .then((buffer) => {
            if (!disposed) buffers.set(line, buffer);
          })
          .catch(() => {
            // The clip decoded at its own rate still plays, resampled.
          });
      }
    }
    return ctx;
  };

  const enable = () => {
    if (enabled || disposed) return;
    enabled = true;
    // The clips: once the page has loaded and gone idle, so they never compete with the page for anything.
    const onLoad = () => cancels.push(idleCallback(() => void load(), 1500));
    if (document.readyState === 'complete') onLoad();
    else {
      window.addEventListener('load', onLoad, { once: true });
      cancels.push(() => window.removeEventListener('load', onLoad));
    }
    // The live context: at the first sign of a visitor, in the next idle moment.
    const presence = () => {
      for (const type of PRESENCE) window.removeEventListener(type, presence, { capture: true });
      cancels.push(idleCallback(() => void prepare(), 250));
    };
    for (const type of PRESENCE) window.addEventListener(type, presence, { capture: true, passive: true });
    cancels.push(() => {
      for (const type of PRESENCE) window.removeEventListener(type, presence, { capture: true });
    });
  };

  /** Real user activation, as the browser counts it — the event must be one that grants it (a tap's end, a key). */
  const activated = () => {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return activation ? activation.isActive : true;
  };

  /**
   * Whether a line started now is heard now. A context still starting counts only inside a gesture — the one
   * that is starting it; outside one, a suspended context could hold a line and play it much later.
   */
  const audible = () => ctx !== null && master !== null && (ctx.state === 'running' || (ctx.state === 'suspended' && activated()));

  const stopCurrent = (fade: number) => {
    const playing = current;
    current = null;
    if (!playing || !ctx) return;
    try {
      const now = ctx.currentTime;
      playing.gain.gain.cancelScheduledValues(now);
      playing.gain.gain.setValueAtTime(playing.gain.gain.value, now);
      playing.gain.gain.linearRampToValueAtTime(0, now + fade);
      playing.source.stop(now + fade + 0.01);
    } catch {
      // Already stopped.
    }
  };

  return {
    enable,
    onLoaded(listener) {
      if (loaded) listener();
      else loadedListeners.push(listener);
    },
    unlock() {
      if (disposed || !enabled) return false;
      if (ctx?.state === 'running') return true;
      if (!activated()) return false;
      // Normally prepared already; a press that is the very first sign of the visitor prepares it here.
      const context = prepare();
      if (!context) return false;
      try {
        void context.resume().catch(() => {});
        // A single silent frame, started inside the gesture: what iOS needs to let later sound through.
        const silence = context.createBufferSource();
        silence.buffer = context.createBuffer(1, 1, context.sampleRate);
        silence.connect(context.destination);
        silence.start();
        return true;
      } catch {
        return false;
      }
    },
    ready() {
      return loaded && audible();
    },
    play(line, onEnd) {
      const buffer = buffers.get(line);
      if (!ctx || !master || !buffer || !audible()) return null;
      try {
        stopCurrent(STOP_FADE);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        source.connect(gain).connect(master);
        const playing = { source, gain };
        source.onended = () => {
          if (current === playing) current = null;
          onEnd();
        };
        source.start();
        current = playing;
        // Time until the first sample is heard: the context's own buffering and the output device's, plus the
        // start-up of a context that is not running yet.
        const lead = (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + (ctx.state === 'running' ? 0 : 0.04);
        return { lead };
      } catch {
        return null;
      }
    },
    stop() {
      stopCurrent(STOP_FADE);
    },
    dispose() {
      disposed = true;
      for (const cancel of cancels.splice(0)) cancel();
      stopCurrent(0.02);
      loadedListeners.length = 0;
      const context = ctx;
      ctx = null;
      master = null;
      void context?.close().catch(() => {});
    },
  };
}
