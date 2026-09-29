import { FIGURES, strike } from '../src/app/(client)/_assistant/sound.ts';
import { AT, DURATION } from './timeline.ts';
import { wavBase64 } from './wav.ts';

/**
 * The soundtrack: no music bed, only the product's own sounds, a little air, and the robot's one line.
 *
 * Everything is struck with the workspace's own felt mallet (`strike`), so the film sounds like the product does.
 * The quote arrives with the workspace's "quote" figure. Each arc of the chest has a note of its own — A, C♯, E,
 * rising — struck as the arc lights; as the third lights the three sound together, and that chord is the mark's
 * sound: it rings through the push to the chest and has died away by the cut to the logo, which is silent. Each
 * payment is a soft tap under it. Then the robot's voice, alone.
 *
 * Rendered offline, sample-exact to the score, as 48 kHz stereo.
 */

const RATE = 48_000;

/** The three arcs' notes: the workspace's "success" figure (a third, then the fifth), spread over the trade. */
const ARC_NOTES = [440, 554.37, 659.25] as const;

/** The robot's line, as recorded (placeholder until the recorded voice replaces it: `voice/clips/measurements.ts`). */
const VOICE = new URL('../src/app/(public)/_landing/voice/clips/ready.wav', import.meta.url).href;

export async function renderSoundtrack(): Promise<string> {
  const ctx = new OfflineAudioContext(2, Math.ceil(DURATION * RATE), RATE);

  const master = ctx.createGain();
  master.gain.value = 0.9;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  master.connect(limiter).connect(ctx.destination);

  // The mallet, through the same soft low-pass the workspace plays it through.
  const mallet = (tone: number, gain: number) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = tone;
    filter.Q.value = 0.5;
    const level = ctx.createGain();
    level.gain.value = gain;
    filter.connect(level).connect(master);
    return filter;
  };

  // Air: the studio's room, barely there, so the silences are a room rather than nothing.
  const noise = ctx.createBuffer(1, ctx.length, RATE);
  const data = noise.getChannelData(0);
  let seed = 1;
  let brown = 0;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    brown = (brown + ((seed / 4294967296) * 2 - 1) * 0.02) / 1.02;
    data[i] = brown;
  }
  const air = ctx.createBufferSource();
  air.buffer = noise;
  const airTone = ctx.createBiquadFilter();
  airTone.type = 'lowpass';
  airTone.frequency.value = 520;
  const airLevel = ctx.createGain();
  airLevel.gain.setValueAtTime(0, 0);
  airLevel.gain.linearRampToValueAtTime(0.05, 0.6);
  airLevel.gain.setValueAtTime(0.05, DURATION - 0.8);
  airLevel.gain.linearRampToValueAtTime(0, DURATION);
  air.connect(airTone).connect(airLevel).connect(master);
  air.start(0);

  // The quote arrives — as it appears, once the request has left: the workspace's own figure.
  const quote = mallet(FIGURES.quote.tone, 0.32);
  for (const s of FIGURES.quote.strikes) strike(ctx, quote, AT.quote + 0.15 + s.at, s.freq, s.level, s.decay, s.bright);

  // "Accept quote" pressed: a key's click, felt more than heard.
  const click = mallet(1800, 0.12);
  strike(ctx, click, AT.press, 1760, 0.5, 0.035, 0.05);

  // The arcs: a note each as it lights, and the three together as the mark is whole.
  const arcs = mallet(2400, 0.34);
  strike(ctx, arcs, AT.accepted + 0.05, ARC_NOTES[0], 0.5, 1.8);
  strike(ctx, arcs, AT.final + 0.08, ARC_NOTES[1], 0.46, 1.8);
  strike(ctx, arcs, AT.complete + 0.08, ARC_NOTES[2], 0.5, 1.6);
  const chord = mallet(2200, 0.3);
  // Long enough to ring through the push to the chest, and gone by the cut to the logo.
  for (const [i, f] of ARC_NOTES.entries()) strike(ctx, chord, AT.complete + 0.2 + i * 0.012, f, 0.34, 7.5, 0.2);
  strike(ctx, chord, AT.complete + 0.2, ARC_NOTES[0] / 2, 0.3, 8, 0.1);

  // Each payment confirmed: a soft, low tap — counted, not celebrated.
  const taps = mallet(1400, 0.2);
  for (const at of AT.legs) strike(ctx, taps, at + 0.04, 329.63, 0.45, 0.16, 0.1);

  // The robot's one line, where its body says it (the `speak` cue at AT.ready, with no lead).
  const clip = await ctx.decodeAudioData(await (await fetch(VOICE)).arrayBuffer());
  const voice = ctx.createBufferSource();
  voice.buffer = clip;
  const voiceLevel = ctx.createGain();
  voiceLevel.gain.value = 0.95;
  voice.connect(voiceLevel).connect(master);
  voice.start(AT.ready);

  return wavBase64(await ctx.startRendering());
}
