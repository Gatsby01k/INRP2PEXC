import { FIGURES, strike } from '../../src/app/(client)/_assistant/sound.ts';
import { seeded } from '../../src/app/(public)/_landing/robot/motion.ts';
import { wavBase64 } from '../wav.ts';
import { AT, DURATION, FPS, HOOK_MESSAGES, HOOK_SHOUTS, clamp01, smooth, span } from './score.ts';

/**
 * HELD's soundtrack: sound design, with no music bed and no voice.
 *
 * The market is heard before it is seen: a chat that will not stop — every message lands with its own small pop,
 * every price in it ticks over — rising to a roar, and cut dead on black glass. Then the storm, first from inside the
 * robot's head and then all round it: wind, the rustle of a thousand cards of chat, cards tearing past. The price the
 * storm makes turns over twelve times a second; a rise that never arrives climbs under it; the chest's arcs light on
 * their notes, A, C♯ and E. When the ring closes there is one blow — a tabla's "dha", a lock, a weight felt more
 * than heard — and the storm's tape stops. Then silence, which is what the film is about.
 *
 * After it, only a few quiet sounds, each for something that matters: the word; the ring's note; the quote accepted,
 * with the product's own sound; the storm coming back while the ring's note does not move; one clean ping when the
 * money arrives; and the arcs' notes again as the mark is made whole, over A. The last card is silent.
 *
 * Everything is computed here, sample by sample or with Web Audio, and rendered offline: the same soundtrack every
 * time, exact to the score. Every sound starts on the frame its picture does, never ahead of it.
 */

const RATE = 48_000;
const TAU = Math.PI * 2;

/** The mix's level into the limiter, and the limiter's ceiling (−1 dBFS). */
const MASTER = 1;
const CEILING = 0.891;

/** Everything tonal in the film is in A. The arcs' notes — A, C♯, E — are the product's own "success" figure. */
const A1 = 55;
const A2 = 110;
const E3 = 164.81;
const A3 = 220;
const CS4 = 277.18;
const E4 = 329.63;
const E6 = 1318.51;
const ARC_NOTES = [440, 554.37, 659.25] as const;

/** The storm's tape: when it is first heard, how long it takes to stop and to start again, and how slow "stopped" is. */
const TAPE = { from: 5.3, stop: 0.45, start: 0.5, crawl: 0.02 } as const;

/** The first frame a moment is seen on (frames are whole 24ths): its sound starts there, never ahead of its picture. */
export function heard(t: number): number {
  return Math.ceil(t * FPS - 1e-6) / FPS;
}

// ——— the film, sound by sound —————————————————————————————————————————————————————————————————————————————

/** The whole mix, before the limiter. */
export async function mixdown(): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(DURATION * RATE), RATE);
  const mix = new Mix(ctx);
  hook(mix);
  wake(mix);
  storm(mix);
  price(mix);
  charge(mix);
  snap(mix);
  word(mix);
  ring(mix);
  phone(mix);
  night(mix);
  ending(mix);
  room(mix);
  // The last card is silent: whatever still rings has gone by the time its words are up.
  automate(mix.master.gain, [
    [0, MASTER],
    [26.9, MASTER],
    [27.5, 0],
  ]);
  return ctx.startRendering();
}

/** The soundtrack as a 48 kHz stereo WAV, base64: the mix, limited. */
export async function renderSoundtrack(): Promise<string> {
  const mixed = await mixdown();
  limit(mixed, CEILING);
  return wavBase64(mixed);
}

/** The chat, piling up on black; the roar under it; the cut. */
function hook(mix: Mix): void {
  const { ctx } = mix;
  const cut = heard(AT.hookEnd);
  // Every message lands with its own pop, where it lands on screen; the bigger it is, the louder.
  for (const [i, m] of HOOK_MESSAGES.entries()) {
    const pitch = (m.mine ? 760 : 540) * 2 ** ((((i * 5) % 7) - 3) / 12);
    const level = 0.22 + clamp01((m.size - 28) / 60) * 0.3;
    mix.play(bubble(ctx, pitch, m.mine, 300 + i), heard(m.at), mix.channel({ level, pan: (m.x + 0.1) * 2 - 1, room: 0.3 }, 'hook'));
  }
  // The prices in it never sit still: each flicks over fourteen times a second, and there are more and more of them.
  const prices = HOOK_MESSAGES.filter((m) => m.price).map((m) => m.at);
  const clicks = [click(ctx, 11, 3400), click(ctx, 12, 3900), click(ctx, 13, 3000)];
  const ticking = mix.channel({ level: 0.1, room: 0.15 }, 'hook');
  for (let k = Math.ceil((prices[0] ?? cut) * 14); k / 14 < cut; k++) {
    const shown = prices.filter((at) => at <= k / 14).length;
    mix.play(clicks[k % 3]!, k / 14, ticking, Math.min(1, Math.sqrt(shown) * 0.4));
  }
  // The words that stop being messages and become the noise itself: each one a blow.
  for (const [i, s] of HOOK_SHOUTS.entries()) mix.play(thump(ctx, 500 + i), heard(s.at), mix.channel({ level: 0.5, room: 0.25 }, 'hook'));
  // Under it all: a rise that never arrives, a semitone apart with itself; then a roar, and the screen turning.
  const anxious = mix.envelope(
    [
      [1.4, 0.0001],
      [cut, 0.2, 'exp'],
    ],
    mix.channel({}, 'hook'),
  );
  mix.play(shepard(ctx, cut - 1.4, [A1, 58.27], 0.32, 23), 1.4, anxious);
  mix.play(roar(ctx, cut - 2.6, 21), 2.6, mix.channel({ level: 0.9 }, 'hook'));
  mix.play(swirl(ctx, cut - 3.1, 22), 3.1, mix.channel({ level: 0.25 }, 'hook'));
  // And then nothing: not even its echo.
  mix.cutHook(cut);
}

/** Black glass: a low presence in the silence; the eyes open; the pull back through the storm. */
function wake(mix: Mix): void {
  const { ctx } = mix;
  const after = heard(AT.hookEnd);
  const presence = mix.envelope(
    [
      [after, 0],
      [heard(AT.reveal), 0.06],
      [AT.price, 0.045],
      [AT.price + 0.8, 0],
    ],
    mix.channel({ room: 0.1 }),
  );
  for (const [f, level] of [
    [A1, 1],
    [A2, 0.3],
  ] as const) {
    const tone = ctx.createOscillator();
    tone.frequency.value = f;
    const g = mix.gain(level);
    tone.connect(g).connect(presence);
    tone.start(after);
    tone.stop(AT.price + 0.9);
  }
  // The eyes open: a small motor, and the note of a light coming on.
  const open = heard(AT.eyesOpen);
  mix.play(servo(ctx, 0.18, 190, 280, 61), open, mix.channel({ level: 0.07, room: 0.3 }));
  strike(ctx, mix.mallet(3000, { level: 0.14, room: 0.4, hall: 0.25 }), open + 0.015, E6, 0.5, 1.6, 0.12);
  // The pull back: a rush away from the glass, and the weight of the size of it all.
  const reveal = heard(AT.reveal);
  mix.play(whoosh(ctx, { seconds: 1.8, from: 2800, to: 200, peak: 0.05, q: 0.8, pan: [0, 0], seed: 71 }), reveal, mix.channel({ level: 0.5, hall: 0.12 }));
  mix.play(blow(ctx, { from: 70, to: 38, decay: 0.9, sub: 0 }), reveal, mix.channel({ level: 0.55 }));
}

/**
 * The storm: heard muffled from inside the robot's head, opened as the camera pulls back, ducked while the chest
 * charges, and stopped like tape when the ring closes. When the market moves again it starts from exactly where it
 * stopped, as the storm's own words do (`storm.ts`: at rest, then up to speed over half a second).
 */
function storm(mix: Mix): void {
  const { ctx } = mix;
  const bed = stormBed(ctx);
  const glass = ctx.createBiquadFilter();
  glass.type = 'lowpass';
  glass.Q.value = 0.5;
  const level = ctx.createGain();
  glass.connect(level).connect(mix.channel({ level: 1.2, room: 0.06 }));

  const reveal = heard(AT.reveal);
  const shot = heard(AT.charge[0] - 0.1);
  const launch = heard(AT.launch);
  const stop = heard(AT.snap);
  const sms = heard(AT.sms);
  automate(level.gain, [
    [TAPE.from, 0],
    [reveal, 0.22],
    [AT.reveal + 1.1, 1],
    [shot, 1],
    [shot + 0.12, 0.5],
    [launch, 0.5],
    [launch + 0.15, 1],
    [stop - 0.07, 1],
    // A breath before the blow.
    [stop - 0.01, 0.4],
    [stop, 1],
    [stop + 0.2, 1],
    [stop + TAPE.stop, 0],
    [AT.restart, 0],
    [AT.restart + 0.3, 0.8],
    [20, 0.8],
    [sms - 0.006, 0.6],
    [sms, 0],
  ]);
  automate(glass.frequency, [
    [TAPE.from, 320],
    [reveal, 320],
    [reveal + 0.3, 2600, 'exp'],
    [AT.reveal + 1.1, 17000, 'exp'],
    [stop, 17000],
    [stop + TAPE.stop, 1500, 'exp'],
    [AT.restart, 1500],
    [AT.restart + TAPE.start, 15000, 'exp'],
    [20, 15000],
    // Closing on the ring, the one still place in it.
    [sms, 5500, 'exp'],
  ]);

  const before = ctx.createBufferSource();
  before.buffer = bed;
  before.playbackRate.setValueAtTime(1, stop);
  before.playbackRate.linearRampToValueAtTime(TAPE.crawl, stop + TAPE.stop);
  before.connect(glass);
  before.start(TAPE.from);
  before.stop(stop + TAPE.stop + 0.02);
  // How much of the storm has played by the time it stops: it resumes from there.
  const played = stop - TAPE.from + (TAPE.stop * (1 + TAPE.crawl)) / 2;
  const after = ctx.createBufferSource();
  after.buffer = bed;
  after.playbackRate.setValueAtTime(TAPE.crawl, AT.restart);
  after.playbackRate.linearRampToValueAtTime(1, AT.restart + TAPE.start);
  after.connect(glass);
  after.start(AT.restart, played);
  after.stop(sms + 0.01);
}

/** The price the storm makes, turning over; the robot looking up at it; the rise under it. */
function price(mix: Mix): void {
  const { ctx } = mix;
  const at = heard(AT.price);
  const stop = heard(AT.snap);
  // The storm condenses into a figure: a rush in.
  mix.play(whoosh(ctx, { seconds: 0.5, from: 300, to: 2400, peak: 1, q: 1.2, pan: [-0.3, 0], seed: 88 }), at - 0.5, mix.channel({ level: 0.25 }));
  // It turns over twelve times a second (`Price.moving`): a counter's wheel, faster than anyone could read.
  const clicks = [click(ctx, 21, 3200), click(ctx, 22, 3700), click(ctx, 23, 2900)];
  const counter = mix.channel({ level: 0.32, room: 0.12 });
  for (let k = Math.ceil(AT.price * 12); k / 12 < AT.snap; k++) {
    const t = k / 12;
    mix.play(clicks[k % 3]!, t, counter, smooth(span(t, AT.price, AT.price + 0.5)) * (0.55 + 0.45 * span(t, AT.price, AT.snap)));
  }
  mix.play(servo(ctx, 0.42, 150, 230, 62), heard(AT.lookUp), mix.channel({ level: 0.07, room: 0.2 }));
  // A rise that never arrives (A and E, climbing without end), and air rising with it — cut just before the blow.
  const from = AT.lookUp + 0.05;
  const rise = mix.envelope(
    [
      [from, 0.0001],
      [stop - 0.05, 0.34, 'exp'],
      [stop - 0.04, 0],
    ],
    mix.channel({ hall: 0.05 }),
  );
  mix.play(shepard(ctx, stop - from, [A1, 82.41], 0.45, 91), from, rise);
  mix.play(whoosh(ctx, { seconds: stop - 0.04 - from, from: 400, to: 7000, peak: 1, q: 0.9, pan: [0, 0], seed: 92 }), from, mix.channel({ level: 0.22 }));
}

/** The chest: each arc lights on its note and holds it; then the three leave for the sky. */
function charge(mix: Mix): void {
  const { ctx } = mix;
  const notes = mix.mallet(2400, { level: 0.6, room: 0.35, hall: 0.15 });
  for (const [i, when] of AT.charge.entries()) {
    const on = heard(when);
    const note = ARC_NOTES[i]!;
    strike(ctx, notes, on, note, 0.5, 1.8);
    // ...and holds it, an octave down, until the arc leaves.
    const leave = heard(AT.launch + i * 0.05);
    const held: Point[] = [
      [on, 0],
      [on + 0.25, 0.05],
      [leave, 0.05],
      [leave + 0.12, 0],
    ];
    const hum = ctx.createOscillator();
    hum.frequency.value = note / 2;
    hum.connect(mix.envelope(held, mix.channel({ room: 0.2 })));
    hum.start(on);
    hum.stop(leave + 0.15);
  }
  const pans = [-0.2, 0, 0.2] as const;
  for (const [i, pan] of pans.entries()) {
    mix.play(whoosh(ctx, { seconds: 0.95, from: 320, to: 2600, peak: 0.5, q: 1.5, pan: [pan, 0], seed: 81 + i }), heard(AT.launch + i * 0.05), mix.channel({ level: 0.3, hall: 0.12 }));
  }
}

/** The ring closes: the one blow in the film. Then the storm stops, and there is nothing but its echo. */
function snap(mix: Mix): void {
  const { ctx } = mix;
  const at = heard(AT.snap);
  mix.play(dha(ctx, 101), at, mix.channel({ level: 0.9, room: 0.2, hall: 0.28 }));
  mix.play(clank(ctx, 102), at + 0.004, mix.channel({ level: 0.4, room: 0.25, hall: 0.2 }));
  mix.play(blow(ctx, { from: 115, to: 55, decay: 0.34, sub: 38 }), at, mix.channel({ level: 0.85, hall: 0.05 }));
  // The wave that stops the world, going out.
  mix.play(whoosh(ctx, { seconds: 0.8, from: 3200, to: 500, peak: 0.03, q: 0.7, pan: [0, 0], seed: 105 }), at, mix.channel({ level: 0.28, hall: 0.12 }));
  // What hangs in the air after it: the ring's light, as a sound.
  mix.play(shimmer(ctx, 5), at + 0.06, mix.channel({ level: 0.05, hall: 0.6 }));
}

/** HELD. — the word placed, low and soft. */
function word(mix: Mix): void {
  const at = heard(AT.held);
  const felt = mix.mallet(1400, { level: 0.5, room: 0.4, hall: 0.3 });
  strike(mix.ctx, felt, at, A2, 0.7, 3.6, 0.22);
  strike(mix.ctx, felt, at + 0.005, E3, 0.3, 3, 0.14);
  strike(mix.ctx, felt, at + 0.01, A3, 0.32, 2.6, 0.2);
}

/**
 * The ring's note, A and the E above it: quiet from the ring on, under the phone, and steady through the storm's
 * return — the one thing in the film that does not move — growing as the camera closes on it. It lets go at the
 * cut to night.
 */
function ring(mix: Mix): void {
  const on = heard(AT.ringClose);
  const phone = heard(AT.phone);
  const sms = heard(AT.sms);
  const level = mix.envelope(
    [
      [on, 0],
      [on + 0.35, 0.05],
      [phone, 0.05],
      [phone + 0.8, 0.035],
      [AT.restart, 0.035],
      [AT.restart + 0.4, 0.2],
      [20, 0.2],
      [sms, 0.28],
    ],
    mix.channel({ room: 0.25, hall: 0.1 }),
  );
  level.gain.setTargetAtTime(0, sms, 0.18);
  const note = mix.ctx.createBufferSource();
  note.buffer = ringNote(mix.ctx, sms + 1.6 - on);
  note.connect(level);
  note.start(on);
  // The storm comes back: a breath in before it.
  const resume = heard(AT.resume);
  mix.play(whoosh(mix.ctx, { seconds: AT.restart - resume, from: 200, to: 1400, peak: 1, q: 1, pan: [0, 0], seed: 141 }), resume, mix.channel({ level: 0.18 }));
}

/** The quote on the phone: its seconds; the thumb on the glass; the product's own sound for a quote accepted. */
function phone(mix: Mix): void {
  const { ctx } = mix;
  const seconds = mix.channel({ level: 0.12, room: 0.2 });
  for (const t of [AT.phone, AT.phone + 1]) mix.play(tick(ctx, 120), heard(t), seconds);
  mix.play(tap(ctx, 131), heard(AT.tap), mix.channel({ level: 0.3, room: 0.12 }));
  const product = mix.mallet(FIGURES.success.tone, { level: 0.6, room: 0.3 });
  for (const s of FIGURES.success.strikes) strike(ctx, product, heard(AT.accepted) + s.at, s.freq, s.level, s.decay, s.bright);
}

/** Night, and the bank's message: one clean ping. */
function night(mix: Mix): void {
  mix.play(ping(mix.ctx), heard(AT.ping), mix.channel({ level: 0.3, room: 0.35, hall: 0.12 }));
}

/** The robot, pleased; it turns to us; the mark made whole — the arcs' notes one by one, then all three over A. */
function ending(mix: Mix): void {
  const { ctx } = mix;
  mix.play(servo(ctx, 0.3, 170, 230, 151), heard(AT.pleased + 0.15), mix.channel({ level: 0.05, room: 0.3 }));
  mix.play(servo(ctx, 0.55, 140, 210, 152), heard(AT.ending) + 0.04, mix.channel({ level: 0.05, room: 0.3 }));
  const notes = mix.mallet(2400, { level: 0.55, room: 0.4, hall: 0.2 });
  for (const [i, at] of AT.mark.entries()) strike(ctx, notes, heard(at), ARC_NOTES[i]!, 0.5, 2.2);
  // Long enough to carry the push into the chest and the cut to the mark; the master fade takes what is left.
  const chord = mix.mallet(2200, { level: 0.5, room: 0.45, hall: 0.3 });
  const hub = heard(AT.hub);
  const voicing = [
    [A2, 0.34],
    [E3, 0.2],
    [A3, 0.26],
    [CS4, 0.2],
    [E4, 0.22],
    [ARC_NOTES[0], 0.24],
    [ARC_NOTES[1], 0.16],
    [ARC_NOTES[2], 0.16],
  ] as const;
  for (const [i, [f, level]] of voicing.entries()) strike(ctx, chord, hub + i * 0.007, f, level, 5.2, 0.16);
}

/** The room: barely there, so that a silence after the hook is a place rather than nothing. Gone before the card. */
function room(mix: Mix): void {
  const from = heard(AT.hookEnd);
  const tone = mix.ctx.createBufferSource();
  tone.buffer = roomTone(mix.ctx, DURATION - from);
  tone.connect(
    mix.envelope(
      [
        [from, 0],
        [from + 0.3, 0.035],
        [26.6, 0.035],
        [27.2, 0],
      ],
      mix.channel({}),
    ),
  );
  tone.start(from);
}

// ——— the mix ——————————————————————————————————————————————————————————————————————————————————————————

interface Place {
  readonly level?: number;
  /** −1 (left) to 1 (right). */
  readonly pan?: number;
  /** How much of it the small room and the big hall hear. */
  readonly room?: number;
  readonly hall?: number;
}

type Point = readonly [at: number, value: number, curve?: 'exp'];

/** An automation: a value at the first point, then a ramp to each point after it (straight, or even in decibels). */
function automate(param: AudioParam, points: readonly Point[]): void {
  const [first, ...rest] = points;
  if (!first) return;
  param.setValueAtTime(first[1], first[0]);
  for (const [at, value, curve] of rest) {
    if (curve === 'exp') param.exponentialRampToValueAtTime(Math.max(value, 1e-4), at);
    else param.linearRampToValueAtTime(value, at);
  }
}

class Mix {
  readonly master: GainNode;
  private readonly sends: { readonly room: AudioNode; readonly hall: AudioNode };
  /** The hook has a room of its own, so that the cut out of it stops everything dead, echoes and all. */
  private readonly hookOut: GainNode;
  private readonly hookRoom: AudioNode;
  readonly ctx: OfflineAudioContext;

  constructor(ctx: OfflineAudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sends = { room: this.reverb(1.2, 5000, 12, this.master), hall: this.reverb(3.8, 3600, 31, this.master) };
    this.hookOut = ctx.createGain();
    this.hookOut.connect(this.master);
    this.hookRoom = this.reverb(0.7, 6500, 47, this.hookOut);
  }

  gain(value: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return g;
  }

  /** A channel into the mix: its level, its place, and its sends. */
  channel({ level = 1, pan = 0, room = 0, hall = 0 }: Place, bus: 'main' | 'hook' = 'main'): GainNode {
    const input = this.gain(level);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    input.connect(panner).connect(bus === 'hook' ? this.hookOut : this.master);
    if (room > 0) panner.connect(this.gain(room)).connect(bus === 'hook' ? this.hookRoom : this.sends.room);
    if (hall > 0 && bus === 'main') panner.connect(this.gain(hall)).connect(this.sends.hall);
    return input;
  }

  /** A channel with the product's felt mallet's own soft low-pass in front of it (`strike` plays into it). */
  mallet(tone: number, place: Place): BiquadFilterNode {
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = tone;
    filter.Q.value = 0.5;
    filter.connect(this.channel(place));
    return filter;
  }

  /** A gain that follows `points`, into `into`. */
  envelope(points: readonly Point[], into: AudioNode): GainNode {
    const g = this.gain(0);
    automate(g.gain, points);
    g.connect(into);
    return g;
  }

  /** A computed sound, once, from `at`. */
  play(buffer: AudioBuffer, at: number, into: AudioNode, level = 1): void {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    if (level === 1) source.connect(into);
    else source.connect(this.gain(level)).connect(into);
    source.start(at);
  }

  /** The hook ends on a cut: from `at`, nothing of it at all. */
  cutHook(at: number): void {
    this.hookOut.gain.setValueAtTime(1, at - 0.005);
    this.hookOut.gain.linearRampToValueAtTime(0, at);
  }

  private reverb(rt60: number, bright: number, seed: number, into: AudioNode): GainNode {
    const convolver = this.ctx.createConvolver();
    convolver.normalize = false;
    convolver.buffer = impulse(this.ctx, rt60, bright, seed);
    const input = this.ctx.createGain();
    input.connect(convolver).connect(into);
    return input;
  }
}

/**
 * A look-ahead peak limiter over the finished mix, in place: nothing leaves above `ceiling`, and the gain never
 * jumps — it falls in a straight line over five milliseconds to meet a peak, and comes back over a few hundred.
 */
function limit(buffer: AudioBuffer, ceiling: number): void {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const n = buffer.length;
  const window = Math.round(0.005 * RATE);
  const release = Math.exp(-1 / (0.15 * RATE));
  // The gain each sample needs on its own...
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
    need[i] = peak > ceiling ? ceiling / peak : 1;
  }
  // ...the least of it over the next `window` samples (a running minimum)...
  const least = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[queue[tail - 1]!]! >= need[i]!) tail--;
    queue[tail++] = i;
    while (queue[head]! > i + window - 1) head++;
    least[i] = need[queue[head]!]!;
  }
  // ...averaged over the window before each sample, which can never be more than that sample needs; and released.
  let sum = 0;
  let gain = 1;
  for (let i = 0; i < n; i++) {
    sum += least[i]!;
    if (i >= window) sum -= least[i - window]!;
    const ramp = sum / Math.min(i + 1, window);
    gain = Math.min(ramp, 1 - (1 - gain) * release);
    left[i]! *= gain;
    right[i]! *= gain;
  }
}

// ——— the sounds, computed ——————————————————————————————————————————————————————————————————————————————————

type Random = () => number;

const white = (random: Random) => () => random() * 2 - 1;

/** Pink noise (Paul Kellet's filter): the wind's colour. */
function pink(random: Random): () => number {
  const POLES = [0.99886, 0.99332, 0.969, 0.8665, 0.55, -0.7616] as const;
  const GAINS = [0.0555179, 0.0750759, 0.153852, 0.3104856, 0.5329522, -0.016898] as const;
  const state = new Float64Array(POLES.length);
  let last = 0;
  return () => {
    const w = random() * 2 - 1;
    let p = last + w * 0.5362;
    for (let k = 0; k < POLES.length; k++) {
      state[k] = POLES[k]! * state[k]! + w * GAINS[k]!;
      p += state[k]!;
    }
    last = w * 0.115926;
    return p * 0.11;
  };
}

/** Noise with the top taken off: rumble. */
function brown(random: Random): () => number {
  let b = 0;
  return () => {
    b = (b + 0.02 * (random() * 2 - 1)) / 1.02;
    return b * 3.5;
  };
}

/** A sine oscillator whose pitch can change every sample. */
function sine(phase = 0): (freq: number) => number {
  return (freq) => {
    phase += (TAU * freq) / RATE;
    if (phase > TAU) phase -= TAU;
    return Math.sin(phase);
  };
}

/** A two-pole filter (RBJ's cookbook), run sample by sample; its frequency can be moved as it runs. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  set(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number): this {
    const w = (TAU * Math.min(freq, RATE * 0.45)) / RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const [b0, b1, b2] = type === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : type === 'highpass' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [alpha, 0, -alpha];
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  run(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function computed(ctx: BaseAudioContext, seconds: number, channels: 1 | 2, fill: (data: Float32Array[]) => void): AudioBuffer {
  const buffer = ctx.createBuffer(channels, Math.max(1, Math.ceil(seconds * RATE)), RATE);
  fill(Array.from({ length: channels }, (_, c) => buffer.getChannelData(c)));
  return buffer;
}

/** A mono sound, one sample at a time (`sample` is called in order, so it may keep state). */
function mono(ctx: BaseAudioContext, seconds: number, sample: (t: number) => number): AudioBuffer {
  return computed(ctx, seconds, 1, ([data]) => {
    for (let i = 0; i < data!.length; i++) data![i] = sample(i / RATE);
  });
}

/** Scales a sound so that its loudest sample is `peak`. */
function normalise(buffer: AudioBuffer, peak = 1): AudioBuffer {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) for (const x of buffer.getChannelData(c)) max = Math.max(max, Math.abs(x));
  if (max === 0) return buffer;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i]! *= peak / max;
  }
  return buffer;
}

/** Scales a sound so that its RMS level is `rms`. */
function atRms(buffer: AudioBuffer, rms: number): AudioBuffer {
  let sum = 0;
  let count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    for (const x of buffer.getChannelData(c)) sum += x * x;
    count += buffer.length;
  }
  const now = Math.sqrt(sum / count);
  return now > 0 ? normalise(buffer, (rms / now) * maxOf(buffer)) : buffer;
}

function maxOf(buffer: AudioBuffer): number {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) for (const x of buffer.getChannelData(c)) max = Math.max(max, Math.abs(x));
  return max;
}

/** Equal-power placement of a sample into a stereo pair. */
function place(left: Float32Array, right: Float32Array, i: number, s: number, pan: number): void {
  const a = ((pan + 1) * Math.PI) / 4;
  left[i]! += s * Math.cos(a);
  right[i]! += s * Math.sin(a);
}

/** A room's impulse response: noise dying away over `rt60`, darker as it goes, a few early reflections first. */
function impulse(ctx: BaseAudioContext, rt60: number, bright: number, seed: number): AudioBuffer {
  return computed(ctx, rt60 * 1.1, 2, (channels) => {
    for (const [c, data] of channels.entries()) {
      const random = seeded(seed + c * 7919);
      const predelay = Math.round((0.012 + c * 0.003) * RATE);
      let low = 0;
      for (let i = predelay; i < data.length; i++) {
        const t = (i - predelay) / RATE;
        const a = Math.exp((-TAU * (250 + bright * 0.1 ** (t / rt60))) / RATE);
        low = (1 - a) * (random() * 2 - 1) + a * low;
        data[i] = low * 10 ** ((-3 * t) / rt60) * Math.min(1, t / 0.004);
      }
      let energy = 0;
      for (const x of data) energy += x * x;
      const early = Math.sqrt(energy / data.length) * 10;
      for (let k = 0; k < 7; k++) data[predelay + Math.round((0.003 + random() * 0.045) * RATE)]! += (random() - 0.5) * early;
      energy = 0;
      for (const x of data) energy += x * x;
      // Unit energy: a steady sound through it comes out about as loud as it went in.
      for (let i = 0; i < data.length; i++) data[i]! /= Math.sqrt(energy);
    }
  });
}

/** A chat message landing: a small, quick bubble — sent ones rise, received ones drop in. */
function bubble(ctx: BaseAudioContext, pitch: number, mine: boolean, seed: number): AudioBuffer {
  const noise = white(seeded(seed));
  const tone = sine();
  return normalise(
    mono(ctx, 0.14, (t) => {
      const glide = mine ? 0.7 + 0.3 * (1 - Math.exp(-t / 0.012)) : 1 + 0.5 * Math.exp(-t / 0.01);
      return tone(pitch * glide) * (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / 0.032) + noise() * Math.exp(-t / 0.0012) * 0.25;
    }),
  );
}

/** A price flicking over: the click of a counter's wheel. */
function click(ctx: BaseAudioContext, seed: number, centre: number): AudioBuffer {
  const noise = white(seeded(seed));
  const band = new Biquad().set('bandpass', centre, 2.2);
  const tone = sine();
  return normalise(mono(ctx, 0.03, (t) => band.run(noise()) * Math.exp(-t / 0.0025) * 2 + tone(centre * 0.55) * Math.exp(-t / 0.004) * 0.3));
}

/** A word shouted over the chat: a low blow with a crack in it. */
function thump(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const noise = white(seeded(seed));
  const crack = new Biquad().set('bandpass', 1700, 0.9);
  const tone = sine();
  return normalise(mono(ctx, 0.8, (t) => tone(46 + 70 * Math.exp(-t / 0.028)) * Math.exp(-t / 0.2) * (1 - Math.exp(-t / 0.002)) + crack.run(noise()) * Math.exp(-t / 0.035) * 0.6));
}

/** The robot moving its head: a small, well-made motor. */
function servo(ctx: BaseAudioContext, seconds: number, from: number, to: number, seed: number): AudioBuffer {
  const noise = white(seeded(seed));
  const band = new Biquad().set('bandpass', 1100, 1.4);
  let phase = 0;
  return normalise(
    mono(ctx, seconds, (t) => {
      phase = (phase + (from + (to - from) * smooth(t / seconds)) / RATE) % 1;
      const env = Math.min(1, t / 0.03) * Math.min(1, (seconds - t) / 0.07);
      return band.run((2 * phase - 1) * 0.8 + noise() * 0.12) * env * (0.78 + 0.22 * Math.sin(TAU * 64 * t));
    }),
  );
}

interface Sweep {
  readonly seconds: number;
  /** The band's centre at the start and at the end (Hz). */
  readonly from: number;
  readonly to: number;
  /** Where in it (0 to 1) it is loudest. */
  readonly peak: number;
  readonly q: number;
  /** Where it starts and ends in the stereo field. */
  readonly pan: readonly [number, number];
  readonly seed: number;
}

/** Air moving: noise in a band that sweeps, swelling to its peak and away. */
function whoosh(ctx: BaseAudioContext, { seconds, from, to, peak, q, pan, seed }: Sweep): AudioBuffer {
  const noise = white(seeded(seed));
  const band = new Biquad();
  return normalise(
    computed(ctx, seconds, 2, ([left, right]) => {
      const n = left!.length;
      // Three milliseconds in and out at the very edges, so a sound cut off at its loudest still ends cleanly.
      const edge = 0.003 * RATE;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        if (i % 32 === 0) band.set('bandpass', from * (to / from) ** u, q);
        const env = (u < peak ? (u / peak) ** 2 : ((1 - u) / (1 - peak)) ** 2) * Math.min(1, i / edge, (n - i) / edge);
        place(left!, right!, i, band.run(noise()) * env, pan[0] + (pan[1] - pan[0]) * u);
      }
    }),
  );
}

/** A Shepard–Risset rise: every octave of each root climbing together, fading in at the bottom and out at the top. */
function shepard(ctx: BaseAudioContext, seconds: number, roots: readonly number[], rise: number, seed: number): AudioBuffer {
  const OCTAVES = 7;
  const random = seeded(seed);
  return normalise(
    computed(ctx, seconds, 2, (channels) => {
      for (const [c, data] of channels.entries()) {
        // The right side a few cents sharp of the left: width.
        const spread = c === 0 ? 1 : 1.0035;
        const voices = roots.flatMap((root) => Array.from({ length: OCTAVES }, (_, k) => ({ root, k, osc: sine(random() * TAU) })));
        for (let i = 0; i < data.length; i++) {
          const t = i / RATE;
          let s = 0;
          for (const v of voices) {
            const x = (v.k + rise * t) % OCTAVES;
            s += v.osc(v.root * spread * 2 ** x) * Math.exp(-((x - OCTAVES / 2) ** 2) / 2.2);
          }
          data[i] = s;
        }
      }
    }),
  );
}

/** The roar under the hook: noise opening up and swelling, all the way to the cut. */
function roar(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  return normalise(
    computed(ctx, seconds, 2, (channels) => {
      for (const [c, data] of channels.entries()) {
        const noise = pink(seeded(seed + c));
        const a = new Biquad();
        const b = new Biquad();
        for (let i = 0; i < data.length; i++) {
          const u = i / data.length;
          if (i % 32 === 0) {
            const f = 220 * (8000 / 220) ** (u ** 1.3);
            a.set('lowpass', f, 0.7);
            b.set('lowpass', f, 0.7);
          }
          data[i] = b.run(a.run(noise())) * u ** 2.2;
        }
      }
    }),
  );
}

/** The screen turning: a narrow band of noise, rising, swinging from side to side ever faster. */
function swirl(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const noise = white(seeded(seed));
  const band = new Biquad();
  let phase = 0;
  return normalise(
    computed(ctx, seconds, 2, ([left, right]) => {
      const n = left!.length;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        if (i % 32 === 0) band.set('bandpass', 600 * (4200 / 600) ** u, 3);
        phase += (TAU * 0.7 * (9 / 0.7) ** u) / RATE;
        place(left!, right!, i, band.run(noise()) * u ** 1.6, Math.sin(phase) * 0.9);
      }
    }),
  );
}

/** A blow: a note falling fast to a low one, with what a small speaker can play of it, and (if asked) a sub under it. */
function blow(ctx: BaseAudioContext, { from, to, decay, sub }: { from: number; to: number; decay: number; sub: number }): AudioBuffer {
  const body = sine();
  const knock = sine();
  const low = sine();
  return normalise(
    mono(ctx, sub ? 3 : decay * 4, (t) => {
      const onset = 1 - Math.exp(-t / 0.002);
      const f = to + (from - to) * Math.exp(-t / 0.028);
      let s = (body(f) * Math.exp(-t / decay) + knock(f * 2) * Math.exp(-t / (decay * 0.3)) * 0.3) * onset;
      if (sub) s += low(sub) * Math.exp(-t / 0.75) * (1 - Math.exp(-t / 0.012)) * 0.75;
      return s;
    }),
  );
}

/**
 * A tabla's "dha": both drums at once. The bayan's note bends up as the heel of the hand presses into its skin;
 * the dayan, tuned to E, rings nearly in harmonics, as its black syahi makes it.
 */
function dha(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const RATIOS = [1, 2, 3, 4, 5.05];
  const LEVELS = [1, 0.55, 0.38, 0.22, 0.12];
  const DECAYS = [1.1, 0.7, 0.5, 0.35, 0.25];
  const noise = white(seeded(seed));
  const palm = new Biquad().set('lowpass', 360, 0.7);
  const finger = new Biquad().set('highpass', 2400, 0.7);
  const bayan = [sine(), sine()];
  const dayan = RATIOS.map(() => sine());
  return normalise(
    mono(ctx, 2.4, (t) => {
      const onset = 1 - Math.exp(-t / 0.0012);
      const f = 95 + 30 * (1 - Math.exp(-t / 0.09));
      const low = (bayan[0]!(f) + 0.2 * bayan[1]!(f * 2)) * Math.exp(-t / 0.62) * onset + palm.run(noise()) * Math.exp(-t / 0.014) * 0.9;
      const bend = 1 + 0.02 * Math.exp(-t / 0.01);
      let high = 0;
      for (let k = 0; k < RATIOS.length; k++) high += dayan[k]!(E4 * RATIOS[k]! * bend) * LEVELS[k]! * Math.exp(-t / DECAYS[k]!);
      return low + high * onset * 0.55 + finger.run(noise()) * Math.exp(-t / 0.0018) * 0.5;
    }),
  );
}

/** The ring locking: two edges of metal meeting, a hair apart. */
function clank(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const METAL = [
    [1187, 1, 0.3],
    [1733, 0.8, 0.24],
    [2419, 0.62, 0.18],
    [3067, 0.5, 0.13],
    [3968, 0.36, 0.09],
    [5210, 0.25, 0.06],
  ] as const;
  const noise = white(seeded(seed));
  const band = new Biquad().set('bandpass', 2700, 1.2);
  const first = METAL.map(() => sine());
  const second = METAL.map(() => sine());
  return normalise(
    mono(ctx, 0.7, (t) => {
      let s = band.run(noise()) * Math.exp(-t / 0.004) * 1.4;
      for (let k = 0; k < METAL.length; k++) {
        const [f, a, d] = METAL[k]!;
        s += first[k]!(f) * a * Math.exp(-t / d) * 0.3;
        if (t >= 0.013) s += second[k]!(f * 1.013) * a * Math.exp(-(t - 0.013) / d) * 0.2;
      }
      return s;
    }),
  );
}

/** The ring's light, as a sound: E, very high, slow to come and slower to go. */
function shimmer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const E7 = 2637.02;
  return normalise(
    computed(ctx, seconds, 2, (channels) => {
      for (const [c, data] of channels.entries()) {
        const a = sine();
        const b = sine();
        for (let i = 0; i < data.length; i++) {
          const t = i / RATE;
          const drift = 1 + 0.0012 * Math.sin(TAU * (5.1 + c * 0.7) * t + c) + c * 0.0008;
          data[i] = (a(E7 * drift) + 0.3 * b(E7 * 2 * drift) * Math.exp(-t / 0.7)) * (1 - Math.exp(-t / 0.2)) * Math.exp(-t / 1.6);
        }
      }
    }),
  );
}

/** The ring's note: A and the E above it, with a little A below and above, gently chorused. */
function ringNote(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const VOICES = [
    [A2, 0.3],
    [A3, 1],
    [E4, 0.62],
    [440, 0.1],
  ] as const;
  const random = seeded(77);
  return normalise(
    computed(ctx, seconds, 2, (channels) => {
      for (const [c, data] of channels.entries()) {
        const voices = VOICES.flatMap(([f, a]) => [-1, 0, 1].map((d) => ({ f: f * (1 + d * 0.0011 * (c ? 1.3 : 1)), a: a / 3, body: sine(random() * TAU), octave: sine(random() * TAU) })));
        for (let i = 0; i < data.length; i++) {
          let s = 0;
          for (const v of voices) s += (v.body(v.f) + 0.12 * v.octave(v.f * 2)) * v.a;
          data[i] = s;
        }
      }
    }),
  );
}

/** A second going by on the countdown: a small, dry tick. */
function tick(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const noise = white(seeded(seed));
  const band = new Biquad().set('bandpass', 1500, 3);
  const body = sine();
  return normalise(mono(ctx, 0.06, (t) => band.run(noise()) * Math.exp(-t / 0.003) + body(820) * Math.exp(-t / 0.007) * 0.4));
}

/** A thumb on glass. */
function tap(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const noise = white(seeded(seed));
  const low = new Biquad().set('lowpass', 1400, 0.7);
  const body = sine();
  return normalise(mono(ctx, 0.08, (t) => low.run(noise()) * Math.exp(-t / 0.004) + body(170) * Math.exp(-t / 0.014) * 0.7));
}

/** The bank's message arriving: one clean ping, A and the E above it. */
function ping(ctx: BaseAudioContext): AudioBuffer {
  const a = sine();
  const b = sine();
  const c = sine();
  return normalise(
    mono(ctx, 2, (t) => {
      const onset = 1 - Math.exp(-t / 0.0015);
      return onset * (a(1760) * Math.exp(-t / 0.45) + 0.5 * b(2637.02) * Math.exp(-t / 0.32) + 0.14 * c(3520) * Math.exp(-t / 0.16));
    }),
  );
}

/** The room: low, soft, and still. */
function roomTone(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  return atRms(
    computed(ctx, seconds, 2, (channels) => {
      for (const [c, data] of channels.entries()) {
        const noise = brown(seeded(601 + c));
        const low = new Biquad().set('lowpass', 420, 0.6);
        for (let i = 0; i < data.length; i++) data[i] = low.run(noise());
      }
    }),
    0.1,
  );
}

/**
 * The storm, twelve seconds of it: wind in gusts, the rustle of a thousand cards of chat and prices flapping as
 * they tumble, cards tearing past close by, and the tick of them knocking together. Computed, so it is the same
 * storm every time.
 */
function stormBed(ctx: BaseAudioContext): AudioBuffer {
  const seconds = 12;
  return atRms(
    computed(ctx, seconds, 2, (channels) => {
      const [left, right] = channels as [Float32Array, Float32Array];
      const n = left.length;
      // Wind: a slow, irregular swell, the same on both sides but a moment apart.
      const gust = (t: number) => clamp01(0.55 + 0.2 * Math.sin(t * 0.83 + 0.4) + 0.14 * Math.sin(t * 2.17 + 1.9) + 0.09 * Math.sin(t * 4.9 + 0.2) + 0.05 * Math.sin(t * 11.3 + 2.6));
      for (const [c, out] of [left, right].entries()) {
        const air = pink(seeded(71 + c));
        const deep = brown(seeded(83 + c));
        const hissing = white(seeded(97 + c));
        const body = new Biquad();
        const whistle = new Biquad();
        const rumble = new Biquad().set('lowpass', 110, 0.7);
        const hiss = new Biquad().set('highpass', 2800, 0.7);
        for (let i = 0; i < n; i++) {
          const g = gust(i / RATE + c * 0.21);
          if (i % 64 === 0) {
            body.set('bandpass', 220 * 2 ** (1.8 * g), 0.7);
            whistle.set('bandpass', 700 * 2 ** (1.1 * g), 16);
          }
          const p = air();
          out[i] = body.run(p) * (0.5 + 0.7 * g) + rumble.run(deep()) * 0.8 + hiss.run(hissing()) * 0.1 * g * g + whistle.run(p) * 0.6 * g ** 3;
        }
      }
      const random = seeded(4121);
      // Cards flapping past: a burst of rustle each, flapping as it tumbles.
      for (let e = 0; e < seconds * 36; e++) {
        const start = Math.floor(random() * n);
        const length = Math.floor((0.1 + random() ** 2 * 0.5) * RATE);
        const band = new Biquad().set('bandpass', 650 * 2 ** (random() * 2.3), 1.1);
        const flaps = 10 + random() * 24;
        const pan = random() * 1.8 - 0.9;
        const loud = 0.05 + random() * 0.16;
        let phase = random() * TAU;
        for (let k = 0; k < length && start + k < n; k++) {
          phase += (TAU * flaps) / RATE;
          const flap = Math.max(0, Math.sin(phase));
          place(left, right, start + k, band.run(random() * 2 - 1) * Math.sin((Math.PI * k) / length) ** 2 * (0.3 + 0.7 * flap * Math.sqrt(flap)) * loud, pan);
        }
      }
      // Cards tearing past close by: a rush that falls in pitch as it goes, from one side to the other.
      for (let at = random() * 0.3; at < seconds; at += 0.22 + random() * 0.5) {
        const start = Math.floor(at * RATE);
        const length = Math.floor((0.45 + random() * 0.7) * RATE);
        const centre = 450 + random() * 900;
        const side = random() < 0.5 ? -1 : 1;
        const loud = 0.25 + random() * 0.65;
        const flaps = 16 + random() * 18;
        const band = new Biquad();
        let phase = 0;
        for (let k = 0; k < length && start + k < n; k++) {
          const u = k / length;
          if (k % 32 === 0) band.set('bandpass', centre * 2 ** (1.2 * (0.5 - u)), 1.3);
          phase += (TAU * flaps) / RATE;
          place(left, right, start + k, band.run(random() * 2 - 1) * Math.exp(-(((u - 0.5) / 0.19) ** 2)) * (0.6 + 0.4 * Math.sin(phase)) * loud, side * 0.85 * (1 - 2 * u));
        }
      }
      // Cards knocking together.
      for (let e = 0; e < seconds * 22; e++) {
        const start = Math.floor(random() * n);
        const f = 1800 * 2 ** (random() * 1.6);
        const tau = 0.0015 + random() * 0.003;
        const loud = 0.01 + random() ** 2 * 0.06;
        const pan = random() * 1.8 - 0.9;
        for (let k = 0; k < tau * 6 * RATE && start + k < n; k++) {
          const t = k / RATE;
          place(left, right, start + k, Math.sin(TAU * f * t) * Math.exp(-t / tau) * loud, pan);
        }
      }
    }),
    0.1,
  );
}
