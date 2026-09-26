import type { Speaker } from './controller.ts';
import { selectVoice } from './select.ts';

/**
 * The browser's speech synthesis, behind the `Speaker` the controller talks to.
 *
 * Voices arrive asynchronously, so availability is reported when they do; a device without an acceptable voice
 * never becomes available and the robot stays silent. The delivery is calm and unhurried — a touch slower than
 * the voice's default, at its natural pitch (shifting pitch is what makes synthetic speech sound synthetic).
 * Nothing here can block the page: speaking is asynchronous, and every call is guarded.
 */
const RATE = 0.94;
const VOLUME = 0.9;

export interface BrowserSpeaker extends Speaker {
  /** Calls back with whether an acceptable voice exists, now and whenever the device's voices change. */
  onAvailability(listener: (available: boolean) => void): () => void;
  dispose(): void;
}

/** Null when the browser has no speech synthesis at all. */
export function createBrowserSpeaker(): BrowserSpeaker | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return null;
  const synth = window.speechSynthesis;
  const android = /android/i.test(navigator.userAgent);
  let voice: SpeechSynthesisVoice | null = null;
  const listeners = new Set<(available: boolean) => void>();

  const refresh = () => {
    try {
      voice = selectVoice(synth.getVoices(), { android });
    } catch {
      voice = null;
    }
    for (const listener of listeners) listener(voice !== null);
  };
  refresh();
  synth.addEventListener('voiceschanged', refresh);

  /** Real user activation, as the browser counts it — the last guard against speaking on page load. */
  const userHasActed = () => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;

  return {
    onAvailability(listener) {
      listeners.add(listener);
      listener(voice !== null);
      return () => {
        listeners.delete(listener);
      };
    },
    unlock() {
      // Some browsers only allow speech that began inside a gesture; an empty, silent utterance started here
      // opens the door for the confirmations that follow a moment later.
      try {
        const primer = new SpeechSynthesisUtterance(' ');
        primer.volume = 0;
        synth.speak(primer);
      } catch {
        // Nothing to unlock; the confirmations will simply not be heard.
      }
    },
    speak(text, onEnd) {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        onEnd();
      };
      if (!voice || !userHasActed()) {
        end();
        return;
      }
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.rate = RATE;
        utterance.volume = VOLUME;
        utterance.onend = end;
        utterance.onerror = end;
        synth.speak(utterance);
      } catch {
        end();
      }
    },
    cancel() {
      try {
        synth.cancel();
      } catch {
        // Nothing was playing.
      }
    },
    dispose() {
      synth.removeEventListener('voiceschanged', refresh);
      listeners.clear();
    },
  };
}
