import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERO, VOICE_LINES, type VoiceLine } from '../src/content/site.ts';

/**
 * Prepares the robot's voice clips: the few lines it says, as finished audio files, and the measurements its
 * body uses to move with them.
 *
 *   pnpm --filter @inrp2p/web voice:clips --from <folder>    recordings: <folder>/ready.wav, received.wav, check.wav
 *   pnpm --filter @inrp2p/web voice:clips --interim          placeholder renders with a macOS system voice
 *
 * Every clip goes through the same chain, so a line re-recorded later sits exactly beside the others: rumble
 * below the voice removed, silence trimmed to a few milliseconds before the first sound (the robot moves the
 * moment a clip starts, so a clip must speak the moment it starts), a short fade at each end, the same speech
 * level for every line and a peak ceiling. It writes, next to the page that plays them:
 *
 *   ready.m4a …    AAC, what nearly every browser plays
 *   ready.wav …    16-bit PCM, for the few that cannot decode AAC
 *   measurements.ts   each clip's length, the syllables it stresses and its loudness over time
 *
 * Commit all of them. macOS only: `afconvert` reads any recording format and writes the AAC.
 *
 * What a recording should be. The lines are in `HERO.voice.lines` and nothing else is ever said. The voice is
 * calm, warm, confident and understated — a high-end car's or private bank's assistant, speaking to one person
 * at arm's length: unhurried but not slow, no announcer lift at the end of a line, no smile in the voice on
 * "Let's check that." (it is a problem, gently put, not a joke). Record dry — no reverb, no music, no processing
 * beyond a clean chain — at 48 kHz, 24-bit or float, one line per file, a second of room tone either side. The
 * chain here trims and levels it; it cannot make a synthetic voice sound recorded.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(APP, 'src/app/(public)/_landing/voice/clips');
const RATE = 48_000;

/** Speech level every clip is brought to, as the RMS of its voiced frames, and the highest any sample may reach. */
const TARGET_RMS_DB = -20;
const CEILING_DB = -1.5;
/** A frame counts as sound above this; the trim keeps this much before the first sound and after the last. */
const GATE_DB = -48;
const PRE_ROLL = 0.012;
const POST_ROLL = 0.09;
const FADE_IN = 0.006;
const FADE_OUT = 0.05;
/** Frames per second of the loudness curve the robot follows. */
const LEVEL_RATE = 50;

/** The placeholder voice: the calmest British voice every Mac has. Replace with recordings before launch. */
const INTERIM_VOICE = 'Daniel';
const INTERIM_WPM = 158;

const dbToGain = (db: number) => 10 ** (db / 20);
const gainToDb = (gain: number) => 20 * Math.log10(Math.max(gain, 1e-9));

function args(): { from: string | null; interim: boolean } {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--from');
  return { from: at >= 0 ? (argv[at + 1] ?? null) : null, interim: argv.includes('--interim') };
}

/** Any recording afconvert can read, as mono 32-bit float samples at 48 kHz. */
function readMono(file: string, work: string): Float32Array {
  const wav = path.join(work, `${path.basename(file)}.f32.wav`);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEF32@${RATE}`, '-c', '1', file, wav]);
  const bytes = readFileSync(wav);
  // Walk the RIFF chunks to the samples; afconvert may write others (FLLR padding) before them.
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'data') {
      const out = new Float32Array(size / 4);
      for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(at + 8 + i * 4);
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no audio data`);
}

/** Second-order high-pass (RBJ), for the rumble and breath noise below a voice. */
function highPass(samples: Float32Array, cutoff: number): Float32Array {
  const w = (2 * Math.PI * cutoff) / RATE;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] ?? 0;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/** RMS of each `frame`-second frame, in dB. */
function frameLevels(samples: Float32Array, frame: number): number[] {
  const n = Math.round(frame * RATE);
  const levels: number[] = [];
  for (let start = 0; start < samples.length; start += n) {
    let sum = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) sum += (samples[i] ?? 0) ** 2;
    levels.push(gainToDb(Math.sqrt(sum / Math.max(1, end - start))));
  }
  return levels;
}

function trim(samples: Float32Array): Float32Array {
  const frame = 0.005;
  const levels = frameLevels(samples, frame);
  const first = levels.findIndex((db) => db > GATE_DB);
  const last = levels.length - 1 - [...levels].reverse().findIndex((db) => db > GATE_DB);
  if (first < 0) throw new Error('clip is silent');
  const start = Math.max(0, Math.round((first * frame - PRE_ROLL) * RATE));
  const end = Math.min(samples.length, Math.round(((last + 1) * frame + POST_ROLL) * RATE));
  const out = samples.slice(start, end);
  const fadeIn = Math.round(FADE_IN * RATE);
  const fadeOut = Math.round(FADE_OUT * RATE);
  for (let i = 0; i < fadeIn && i < out.length; i++) out[i] = (out[i] ?? 0) * (0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn));
  for (let i = 0; i < fadeOut && i < out.length; i++) {
    const j = out.length - 1 - i;
    out[j] = (out[j] ?? 0) * (0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut));
  }
  return out;
}

/** Brings the voiced frames to the target level, then lowers the whole clip if a peak would pass the ceiling. */
function level(samples: Float32Array): Float32Array {
  const frame = Math.round(0.02 * RATE);
  let sum = 0;
  let count = 0;
  for (let start = 0; start < samples.length; start += frame) {
    let s = 0;
    const end = Math.min(samples.length, start + frame);
    for (let i = start; i < end; i++) s += (samples[i] ?? 0) ** 2;
    if (gainToDb(Math.sqrt(s / (end - start))) > GATE_DB + 12) {
      sum += s;
      count += end - start;
    }
  }
  let gain = dbToGain(TARGET_RMS_DB) / Math.sqrt(sum / Math.max(1, count));
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  gain = Math.min(gain, dbToGain(CEILING_DB) / peak);
  return samples.map((x) => x * gain);
}

function writeWav(file: string, samples: Float32Array): void {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

interface Measurement {
  readonly duration: number;
  readonly peaks: readonly { readonly at: number; readonly level: number }[];
  readonly level: readonly number[];
}

/**
 * What the robot needs to move with a clip: how long it is, where its stressed syllables land (peaks of the
 * smoothed loudness, well separated and clearly above the dips around them) and how loud it is over time, 0–1.
 */
function measure(samples: Float32Array): Measurement {
  const db = frameLevels(samples, 1 / LEVEL_RATE);
  const floor = -50;
  const top = Math.max(...db);
  const curve = db.map((d) => Math.max(0, Math.min(1, (d - floor) / (top - floor))));
  const smooth = curve.map((_, i) => ((curve[i - 1] ?? 0) + 2 * (curve[i] ?? 0) + (curve[i + 1] ?? 0)) / 4);
  const peaks: { at: number; level: number }[] = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    const v = smooth[i] ?? 0;
    if (v < 0.55 || v < (smooth[i - 1] ?? 0) || v < (smooth[i + 1] ?? 0)) continue;
    const previous = peaks.at(-1);
    const at = i / LEVEL_RATE;
    if (previous && at - previous.at < 0.14) {
      if (v > previous.level) peaks[peaks.length - 1] = { at, level: v };
      continue;
    }
    if (previous) {
      const from = Math.round(previous.at * LEVEL_RATE);
      const dip = Math.min(...smooth.slice(from, i + 1));
      if (Math.min(previous.level, v) - dip < 0.08) {
        if (v > previous.level) peaks[peaks.length - 1] = { at, level: v };
        continue;
      }
    }
    peaks.push({ at, level: v });
  }
  const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;
  return {
    duration: round(samples.length / RATE, 3),
    peaks: peaks.map((p) => ({ at: round(p.at, 2), level: round(p.level, 2) })),
    level: curve.map((v) => round(v, 2)),
  };
}

function main(): void {
  const { from, interim } = args();
  if (!from && !interim) throw new Error('say where the recordings are (--from <folder>) or ask for placeholders (--interim)');
  const work = mkdtempSync(path.join(tmpdir(), 'inrp2p-voice-'));
  const measurements: Partial<Record<VoiceLine, Measurement>> = {};
  try {
    for (const line of VOICE_LINES) {
      let source: string;
      if (from) {
        source = path.resolve(from, `${line}.wav`);
      } else {
        source = path.join(work, `${line}.aiff`);
        execFileSync('say', ['-v', INTERIM_VOICE, '-r', String(INTERIM_WPM), '-o', source, HERO.voice.lines[line]]);
      }
      const clip = level(trim(highPass(readMono(source, work), 70)));
      const wav = path.join(OUT, `${line}.wav`);
      const m4a = path.join(OUT, `${line}.m4a`);
      writeWav(wav, clip);
      execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '96000', '-q', '127', wav, m4a]);
      measurements[line] = measure(clip);
      const kb = (file: string) => `${(statSync(file).size / 1024).toFixed(1)} KB`;
      console.log(`${line}: ${measurements[line].duration}s, ${measurements[line].peaks.length} stresses — m4a ${kb(m4a)}, wav ${kb(wav)}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const body = VOICE_LINES.map((line) => {
    const m = measurements[line];
    if (!m) throw new Error(`${line} was not measured`);
    return `  ${line}: {\n    duration: ${m.duration},\n    peaks: ${JSON.stringify(m.peaks).replaceAll('"', '')},\n    level: [${m.level.join(', ')}],\n  },`;
  }).join('\n');
  writeFileSync(
    path.join(OUT, 'measurements.ts'),
    `import type { VoiceLine } from '../../../../../content/site.ts';

/**
 * Generated by \`pnpm --filter @inrp2p/web voice:clips\` from the clips beside it — do not edit by hand.
 * ${interim ? `PLACEHOLDER clips, rendered with the macOS "${INTERIM_VOICE}" voice: replace with recordings before launch.` : 'From the studio recordings.'}
 *
 * \`duration\` is in seconds; \`peaks\` are the stressed syllables, seconds from the start with their loudness;
 * \`level\` is loudness 0–1 at ${LEVEL_RATE} frames a second.
 */
export interface ClipMeasurement {
  readonly duration: number;
  readonly peaks: readonly { readonly at: number; readonly level: number }[];
  readonly level: readonly number[];
}

export const LEVEL_RATE = ${LEVEL_RATE};

export const INTERIM = ${interim};

export const CLIP_MEASUREMENTS: Record<VoiceLine, ClipMeasurement> = {
${body}
};
`,
  );
}

main();
