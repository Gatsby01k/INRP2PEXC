import { describe, expect, it } from 'vitest';
import { HERO } from '../src/content/site.ts';
import { type Clock, PAUSE_AFTER_LINE, type Speaker, VoiceController } from '../src/app/(public)/_landing/voice/controller.ts';
import { selectVoice, voiceQuality } from '../src/app/(public)/_landing/voice/select.ts';

/**
 * The robot's voice, held to what it is for: a short confirmation after something the visitor did, never
 * conversation. Nothing before an interaction, each line once, one at a time, nothing queued behind the visitor's
 * back — and only in a voice worth hearing.
 */

/** A clock that only moves when the test moves it, with the timers that are due run in order. */
function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = ++next;
      timers.set(id, { at: now + ms / 1000, run });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') timers.delete(handle);
    },
  };
  const advance = (seconds: number) => {
    const until = now + seconds;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { clock, advance, now: () => now };
}

/** A speaker that records what was said and finishes each line when the test says so. */
function fakeSpeaker() {
  const said: string[] = [];
  let finish: (() => void) | null = null;
  let cancels = 0;
  let unlocks = 0;
  const speaker: Speaker = {
    speak: (text, onEnd) => {
      said.push(text);
      finish = onEnd;
    },
    cancel: () => {
      cancels += 1;
      finish = null;
    },
    unlock: () => {
      unlocks += 1;
    },
  };
  return {
    speaker,
    said,
    /** The current line finishes. */
    end: () => {
      const f = finish;
      finish = null;
      f?.();
    },
    cancels: () => cancels,
    unlocks: () => unlocks,
  };
}

const LINES = HERO.voice.lines;

function setup(options: { muted?: boolean } = {}) {
  const time = fakeClock();
  const voice = fakeSpeaker();
  const controller = new VoiceController({ speaker: voice.speaker, clock: time.clock, lines: LINES, muted: options.muted ?? false });
  /** Lets the current line finish and the pause after it pass. */
  const settle = () => {
    voice.end();
    time.advance(PAUSE_AFTER_LINE + 0.05);
  };
  return { time, voice, controller, settle };
}

describe('when the robot speaks', () => {
  it('says nothing on its own: no line before the visitor has done anything, however long the page is open', () => {
    const { time, voice } = setup();
    time.advance(120);
    expect(voice.said).toEqual([]);
    expect(voice.unlocks()).toBe(0);
  });

  it('greets the first interaction that is not itself an action, a moment after it', () => {
    const { time, voice, controller } = setup();
    controller.onCue({ kind: 'engage' });
    expect(voice.unlocks(), 'unlocked inside the gesture').toBe(1);
    expect(voice.said).toEqual([]);
    time.advance(0.4);
    expect(voice.said).toEqual([LINES.ready]);
  });

  it('lets an action answer for itself when it is the first interaction: no greeting before or after it', () => {
    const { time, voice, controller, settle } = setup();
    controller.onCue({ kind: 'engage' });
    controller.onCue({ kind: 'direction', direction: 'BUY_USDT' });
    time.advance(0.3);
    expect(voice.said).toEqual([LINES.direction]);
    settle();
    controller.onCue({ kind: 'engage' });
    time.advance(2);
    expect(voice.said).toEqual([LINES.direction]);
  });

  it('confirms a typed amount once the typing stops, not while it continues', () => {
    const { time, voice, controller, settle } = setup();
    controller.onCue({ kind: 'engage' });
    time.advance(0.4);
    settle();
    for (let i = 0; i < 6; i++) {
      controller.onCue({ kind: 'value' });
      time.advance(0.2);
    }
    expect(voice.said).toEqual([LINES.ready]);
    time.advance(0.4);
    expect(voice.said).toEqual([LINES.ready, LINES.amount]);
  });

  it('confirms an amount picked in one step sooner', () => {
    const { time, voice, controller } = setup();
    controller.onCue({ kind: 'value', settled: true });
    time.advance(0.3);
    expect(voice.said).toEqual([LINES.amount]);
  });

  it('answers the call to action and a received request with their own lines', () => {
    const { time, voice, controller, settle } = setup();
    controller.onCue({ kind: 'cta' });
    settle();
    controller.onCue({ kind: 'submitted' });
    time.advance(0.1);
    expect(voice.said).toEqual([LINES.request, LINES.received]);
  });

  it('leaves a rate and a lock to the robot’s body: the figure on screen is the confirmation', () => {
    const { time, voice, controller } = setup();
    controller.onCue({ kind: 'rate' });
    controller.onCue({ kind: 'lock' });
    time.advance(2);
    expect(voice.said).toEqual([]);
  });
});

describe('how little it says', () => {
  it('says each line at most once per visit', () => {
    const { time, voice, controller, settle } = setup();
    for (const direction of ['BUY_USDT', 'SELL_USDT', 'BUY_USDT'] as const) {
      controller.onCue({ kind: 'direction', direction });
      time.advance(0.2);
      settle();
    }
    for (let i = 0; i < 3; i++) {
      controller.onCue({ kind: 'value', settled: true });
      time.advance(0.3);
      settle();
    }
    expect(voice.said).toEqual([LINES.direction, LINES.amount]);
  });

  it('never talks over itself: a line asked for mid-line waits for it, briefly — only the most recent one', () => {
    const { time, voice, controller } = setup();
    controller.onCue({ kind: 'cta' });
    controller.onCue({ kind: 'value', settled: true });
    time.advance(0.3);
    controller.onCue({ kind: 'submitted' });
    expect(voice.said).toEqual([LINES.request]);
    voice.end();
    time.advance(PAUSE_AFTER_LINE + 0.05);
    // The amount was superseded by the newer line while it waited: it is dropped, not queued behind it.
    expect(voice.said).toEqual([LINES.request, LINES.received]);
    voice.end();
    time.advance(5);
    expect(voice.said).toEqual([LINES.request, LINES.received]);
  });

  it('drops a waiting line that is no longer news', () => {
    const { time, voice, controller } = setup();
    controller.onCue({ kind: 'cta' });
    controller.onCue({ kind: 'submitted' });
    // The current line runs long: by the time it ends, the waiting one is stale.
    time.advance(2);
    voice.end();
    time.advance(PAUSE_AFTER_LINE + 0.05);
    expect(voice.said).toEqual([LINES.request]);
  });

  it('confirms an amount typed straight after the greeting, once the greeting and its pause are over', () => {
    const { time, voice, controller } = setup();
    controller.onCue({ kind: 'engage' });
    time.advance(0.4);
    controller.onCue({ kind: 'value' });
    time.advance(0.6);
    expect(voice.said).toEqual([LINES.ready]);
    voice.end();
    time.advance(PAUSE_AFTER_LINE + 0.05);
    expect(voice.said).toEqual([LINES.ready, LINES.amount]);
  });

  it('keeps a pause after every line', () => {
    const { time, voice, controller } = setup();
    controller.onCue({ kind: 'cta' });
    voice.end();
    time.advance(PAUSE_AFTER_LINE / 2);
    controller.onCue({ kind: 'submitted' });
    expect(voice.said, 'not yet').toEqual([LINES.request]);
    time.advance(PAUSE_AFTER_LINE / 2 + 0.05);
    expect(voice.said, 'after the pause').toEqual([LINES.request, LINES.received]);
  });
});

describe('the mute control', () => {
  it('silences everything while muted', () => {
    const { time, voice, controller } = setup({ muted: true });
    controller.onCue({ kind: 'engage' });
    controller.onCue({ kind: 'value', settled: true });
    controller.onCue({ kind: 'cta' });
    time.advance(3);
    expect(voice.said).toEqual([]);
  });

  it('stops the current line the moment it is pressed', () => {
    const { voice, controller } = setup();
    controller.onCue({ kind: 'cta' });
    controller.setMuted(true);
    expect(voice.cancels()).toBe(1);
  });

  it('confirms being turned on, once, if nothing has been said yet', () => {
    const { voice, controller, settle } = setup({ muted: true });
    controller.setMuted(false);
    expect(voice.said).toEqual([LINES.ready]);
    settle();
    controller.setMuted(true);
    controller.setMuted(false);
    expect(voice.said).toEqual([LINES.ready]);
  });
});

describe('which voice', () => {
  const v = (name: string, lang: string, voiceURI = name) => ({ name, lang, voiceURI });
  const desktop = { android: false };

  it('prefers a natural voice, and Indian English among equals', () => {
    const voices = [v('Microsoft Aria Online (Natural) - English (United States)', 'en-US'), v('Microsoft Neerja Online (Natural) - English (India)', 'en-IN'), v('Samantha', 'en-US')];
    expect(selectVoice(voices, desktop)?.name).toContain('Neerja');
  });

  it('puts quality before region', () => {
    const voices = [v('Rishi', 'en-IN'), v('Ava (Premium)', 'en-US')];
    expect(selectVoice(voices, desktop)?.name).toBe('Ava (Premium)');
  });

  it('refuses mechanical engines, novelty voices and unknown desktop voices — and stays silent if that is all there is', () => {
    const voices = [v('English (America)', 'en-US', 'espeak-ng en-us'), v('Zarvox', 'en-US'), v('Bad News', 'en-US'), v('Microsoft David Desktop - English (United States)', 'en-US')];
    expect(selectVoice(voices, desktop)).toBeNull();
    for (const voice of voices) expect(voiceQuality(voice, desktop)).toBe(0);
  });

  it('accepts the Android engine’s plainly named English voices, on Android only', () => {
    const voices = [v('English United Kingdom', 'en-GB')];
    expect(selectVoice(voices, { android: true })?.name).toBe('English United Kingdom');
    expect(selectVoice(voices, desktop)).toBeNull();
  });

  it('knows Apple voices by their URI, whatever language the names are shown in', () => {
    const voices = [
      v('Саманта', 'en-US', 'com.apple.voice.compact.en-US.Samantha'),
      v('Ава (улучшенное)', 'en-US', 'com.apple.voice.premium.en-US.Ava'),
      v('Зарвокс', 'en-US', 'com.apple.speech.synthesis.voice.Zarvox'),
      v('Rocko', 'en-US', 'com.apple.eloquence.en-US.Rocko'),
    ];
    expect(selectVoice(voices, desktop)?.voiceURI).toBe('com.apple.voice.premium.en-US.Ava');
    expect(voiceQuality(voices[0]!, desktop)).toBe(2);
    expect(voiceQuality(voices[2]!, desktop)).toBe(0);
    expect(voiceQuality(voices[3]!, desktop)).toBe(0);
  });

  it('refuses translated names it cannot identify, rather than guess', () => {
    expect(selectVoice([v('Саманта', 'en-US'), v('Мойра', 'en-IE')], desktop)).toBeNull();
  });

  it('never picks a voice that does not speak English', () => {
    expect(selectVoice([v('Google हिन्दी', 'hi-IN'), v('Microsoft Swara Online (Natural) - Hindi (India)', 'hi-IN')], desktop)).toBeNull();
  });
});
