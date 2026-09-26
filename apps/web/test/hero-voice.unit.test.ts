import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HERO, VOICE_LINES, type VoiceLine } from '../src/content/site.ts';
import type { RobotCue } from '../src/app/(public)/_landing/robot/cues.ts';
import { type LookAngles, type LookTarget, type Pose, REST_POSE, type RobotState, RobotBehaviour } from '../src/app/(public)/_landing/robot/behaviour.ts';
import { SPEECH, nodTime } from '../src/app/(public)/_landing/robot/speech.ts';
import { type Player, VoiceController } from '../src/app/(public)/_landing/voice/controller.ts';
import { CLIP_MEASUREMENTS } from '../src/app/(public)/_landing/voice/clips/measurements.ts';

/**
 * The robot's voice, held to what it is for: three recorded lines, each a confirmation of something the visitor
 * did, played the instant it is asked for or not at all — and a body that moves with each line as authored.
 */

/** A player whose clips are loaded; audio is unlocked when the test says so, and each line ends when it says so. */
function fakePlayer(options: { unlocked?: boolean; plays?: boolean } = {}) {
  const played: VoiceLine[] = [];
  let unlocked = options.unlocked ?? true;
  let finish: (() => void) | null = null;
  let stops = 0;
  const player: Player = {
    ready: () => unlocked,
    play: (line, onEnd) => {
      if (!unlocked || options.plays === false) return null;
      played.push(line);
      finish = onEnd;
      return { lead: 0.02 };
    },
    stop: () => {
      stops += 1;
      const f = finish;
      finish = null;
      f?.();
    },
  };
  return {
    player,
    played,
    unlock: () => {
      unlocked = true;
    },
    /** The current line plays to its end. */
    end: () => {
      const f = finish;
      finish = null;
      f?.();
    },
    stops: () => stops,
  };
}

function setup(options: { muted?: boolean; unlocked?: boolean; plays?: boolean } = {}) {
  let now = 0;
  const audio = fakePlayer(options);
  const robot: RobotCue[] = [];
  const controller = new VoiceController({
    player: audio.player,
    clock: { now: () => now },
    muted: options.muted ?? false,
    onRobot: (cue) => robot.push(cue),
  });
  return {
    audio,
    robot,
    controller,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

describe('when the robot speaks', () => {
  it('says nothing before the visitor has done anything, and nothing late for a gesture that came too late', () => {
    const { audio, controller, advance } = setup({ unlocked: false });
    controller.onCue({ kind: 'engage' });
    advance(2);
    audio.unlock();
    controller.unlocked();
    expect(audio.played).toEqual([]);
  });

  it('answers the first move in the quote module at once, in the same call', () => {
    const { audio, robot, controller } = setup();
    controller.onCue({ kind: 'engage' });
    expect(audio.played).toEqual(['ready']);
    expect(robot).toEqual([{ kind: 'speak', line: 'ready', lead: 0.02 }]);
  });

  it('waits for the end of a tap, and no longer, where a touch screen only unlocks audio then', () => {
    const { audio, controller, advance } = setup({ unlocked: false });
    controller.onCue({ kind: 'engage' });
    advance(0.15);
    audio.unlock();
    controller.unlocked();
    expect(audio.played).toEqual(['ready']);
  });

  it('never speaks about an amount, a direction, a rate or a lock', () => {
    const { audio, controller } = setup();
    const quiet: RobotCue[] = [
      { kind: 'value' },
      { kind: 'value', settled: true },
      { kind: 'direction', direction: 'BUY_USDT' },
      { kind: 'rate' },
      { kind: 'lock' },
    ];
    for (const cue of quiet) controller.onCue(cue);
    expect(audio.played).toEqual([]);
  });

  it('greets once per visit', () => {
    const { audio, controller } = setup();
    controller.onCue({ kind: 'engage' });
    audio.end();
    controller.onCue({ kind: 'engage' });
    expect(audio.played).toEqual(['ready']);
  });

  it('asks for a second look once per visit, and confirms every received request', () => {
    const { audio, controller } = setup();
    for (let i = 0; i < 2; i++) {
      controller.onCue({ kind: 'problem' });
      audio.end();
      controller.onCue({ kind: 'submitted' });
      audio.end();
    }
    expect(audio.played).toEqual(['check', 'received', 'received']);
  });

  it('retires the greeting once another line has been said: a first move that was a problem is not greeted', () => {
    const { audio, controller } = setup();
    controller.onCue({ kind: 'problem' });
    audio.end();
    controller.onCue({ kind: 'engage' });
    expect(audio.played).toEqual(['check']);
  });

  it('lets a more important line cut a lesser one short — never the other way round, and nothing waits', () => {
    const { audio, robot, controller } = setup();
    controller.onCue({ kind: 'engage' });
    controller.onCue({ kind: 'problem' });
    expect(audio.stops()).toBe(1);
    expect(robot.map((c) => c.kind)).toEqual(['speak', 'hush', 'speak']);
    controller.onCue({ kind: 'engage' });
    audio.end();
    expect(audio.played).toEqual(['ready', 'check']);
  });

  it('tells the body nothing when a line could not start', () => {
    const { robot, controller } = setup({ plays: false });
    controller.onCue({ kind: 'engage' });
    controller.onCue({ kind: 'problem' });
    expect(robot).toEqual([]);
  });
});

describe('the mute control', () => {
  it('silences everything while muted', () => {
    const { audio, controller } = setup({ muted: true });
    controller.onCue({ kind: 'engage' });
    controller.onCue({ kind: 'problem' });
    controller.onCue({ kind: 'submitted' });
    expect(audio.played).toEqual([]);
  });

  it('stops the current line the moment it is pressed, and tells the body', () => {
    const { audio, robot, controller } = setup();
    controller.onCue({ kind: 'submitted' });
    controller.setMuted(true);
    expect(audio.stops()).toBe(1);
    expect(robot.at(-1)).toEqual({ kind: 'hush' });
  });

  it('answers being turned on as soon as the clips it has just started fetching are ready', () => {
    const { audio, controller, advance } = setup({ muted: true, unlocked: false });
    controller.setMuted(false);
    expect(audio.played).toEqual([]);
    advance(0.4);
    audio.unlock();
    controller.unlocked();
    expect(audio.played).toEqual(['ready']);
  });

  it('drops the answer to being turned on when the clips take too long, and says nothing late', () => {
    const { audio, controller, advance } = setup({ muted: true, unlocked: false });
    controller.setMuted(false);
    advance(3);
    audio.unlock();
    controller.unlocked();
    expect(audio.played).toEqual([]);
    // The greeting was never heard, so the visitor's first move may still be answered.
    controller.onCue({ kind: 'engage' });
    expect(audio.played).toEqual(['ready']);
  });

  it('drops a waiting answer when it is turned off again before the clips arrive', () => {
    const { audio, controller, advance } = setup({ muted: true, unlocked: false });
    controller.setMuted(false);
    controller.setMuted(true);
    advance(0.2);
    audio.unlock();
    controller.unlocked();
    expect(audio.played).toEqual([]);
  });

  it('confirms being turned on, once, only if nothing has been said yet', () => {
    const { audio, controller } = setup({ muted: true });
    controller.setMuted(false);
    audio.end();
    controller.setMuted(true);
    controller.setMuted(false);
    expect(audio.played).toEqual(['ready']);
  });

  it('stops a line when the page is hidden, without muting the voice', () => {
    const { audio, controller } = setup();
    controller.onCue({ kind: 'problem' });
    controller.hush();
    expect(audio.stops()).toBe(1);
    controller.onCue({ kind: 'submitted' });
    expect(audio.played).toEqual(['check', 'received']);
  });
});

// ---- the body, moving with a line ----------------------------------------------------------------------

const ANGLES: Record<LookTarget, LookAngles> = {
  viewer: { yaw: 0, pitch: -0.05 },
  panel: { yaw: 0.45, pitch: -0.1 },
  amount: { yaw: 0.42, pitch: -0.02 },
  toggle: { yaw: 0.4, pitch: 0.06 },
  rate: { yaw: 0.46, pitch: -0.14 },
  cta: { yaw: 0.44, pitch: -0.3 },
  entry: { yaw: 0.5, pitch: 0.32 },
};
const FRAME = 1 / 60;
const LEAD = 0.03;

interface Frame {
  readonly pose: Pose;
  readonly state: RobotState;
  readonly time: number;
}

function robotAtRest() {
  let s = 11;
  const random = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const behaviour = new RobotBehaviour({ direction: 'SELL_USDT', random });
  let time = 0;
  const step = (seconds: number, each?: (frame: Frame) => void): Frame => {
    let frame: Frame = { pose: REST_POSE, state: behaviour.current, time };
    for (let i = 0; i < Math.round(seconds / FRAME); i++) {
      time += FRAME;
      const pose = behaviour.update({ time, dt: FRAME, focus: 'none', angles: (t) => ANGLES[t] });
      frame = { pose, state: behaviour.current, time };
      each?.(frame);
    }
    return frame;
  };
  step(4);
  return { behaviour, step, now: () => time };
}

/** Speaks `line` on a robot at rest and records every frame until it is back at rest. */
function speak(line: VoiceLine) {
  const robot = robotAtRest();
  const at = robot.now();
  const rest = robot.step(0);
  robot.behaviour.cue({ kind: 'speak', line, lead: LEAD }, at);
  const frames: Frame[] = [];
  robot.step(CLIP_MEASUREMENTS[line].duration + 3, (f) => frames.push(f));
  const heard = (f: Frame) => f.time - at - LEAD;
  return { robot, at, rest, frames, heard };
}

describe('the body while it speaks', () => {
  it('moves its attention the moment a line starts: the eyes are on their way within the first frames', () => {
    const { frames, rest } = speak('check');
    const early = frames[5]!;
    expect(early.state).toBe('speaking');
    expect(early.pose.gazeX - rest.pose.gazeX).toBeGreaterThan(0.01);
  });

  it('nods once, on the syllable each line stresses, and only on lines that have a nod', () => {
    for (const line of VOICE_LINES) {
      const { frames, rest, heard } = speak(line);
      const dip = frames.map((f) => ({ t: heard(f), pitch: f.pose.headPitch - f.pose.neckPitch }));
      const target = nodTime(line);
      if (target === null) continue;
      // The nod's lowest point, against the pitch the pose would hold without it.
      const around = dip.filter((d) => d.t > target - 0.4 && d.t < target + 0.6);
      const deepest = around.reduce((a, b) => (b.pitch < a.pitch ? b : a));
      expect(Math.abs(deepest.t - (target + 0.04)), line).toBeLessThan(0.12);
      expect(rest.pose.headPitch - deepest.pitch, line).toBeLessThan(0.08);
    }
  });

  it('lights the hub with the voice and only while it is heard', () => {
    for (const line of VOICE_LINES) {
      const { frames, heard } = speak(line);
      const duration = CLIP_MEASUREMENTS[line].duration;
      const during = frames.filter((f) => heard(f) > 0.1 && heard(f) < duration - 0.1).map((f) => f.pose.hubGlow);
      const after = frames.filter((f) => heard(f) > duration + 2).map((f) => f.pose.hubGlow);
      expect(Math.max(...during), line).toBeGreaterThan(0.1);
      expect(Math.max(...after), line).toBeLessThan(0.01);
    }
  });

  it('wears the expression of what it says: a greeting, pleasure at a received request, concern for a check', () => {
    const held = (line: VoiceLine) => {
      const { frames, heard } = speak(line);
      return frames.filter((f) => f.state === 'speaking' && heard(f) > 0.4).at(-1)!.pose;
    };
    expect(held('ready').smile).toBeGreaterThan(0.95);
    const received = held('received');
    expect(received.smile).toBeGreaterThan(0.45);
    expect(received.smile).toBeLessThan(0.55);
    const check = held('check');
    expect(check.lidTilt).toBeLessThan(-0.2);
    expect(check.beacon).toBeGreaterThan(0.5);
  });

  it('completes the emblem for a received request, and for nothing else', () => {
    const arcs = (line: VoiceLine) => Math.max(...speak(line).frames.map((f) => Math.min(...f.pose.arcGlow)));
    expect(arcs('received')).toBeGreaterThan(0.3);
    expect(arcs('ready')).toBeLessThan(0.05);
    expect(arcs('check')).toBeLessThan(0.05);
  });

  it('holds a moment after the line, then returns to rest by itself', () => {
    for (const line of VOICE_LINES) {
      const { frames, heard } = speak(line);
      const end = CLIP_MEASUREMENTS[line].duration + SPEECH[line].hold;
      expect(frames.find((f) => heard(f) > end - 0.1 && heard(f) < end - 0.05)?.state, line).toBe('speaking');
      expect(frames.at(-1)?.state, line).toBe('idle');
    }
  });

  it('lets go at once when the line is stopped', () => {
    const robot = robotAtRest();
    robot.behaviour.cue({ kind: 'speak', line: 'received', lead: LEAD }, robot.now());
    robot.step(0.3);
    robot.behaviour.cue({ kind: 'hush' }, robot.now());
    const after = robot.step(0.4);
    expect(after.state).toBe('idle');
    expect(after.pose.hubGlow).toBeLessThan(0.05);
  });
});

// ---- the clips -------------------------------------------------------------------------------------------

const clip = (line: VoiceLine, ext: 'wav' | 'm4a') => fileURLToPath(new URL(`../src/app/(public)/_landing/voice/clips/${line}.${ext}`, import.meta.url));

describe('the clips', () => {
  it('are exactly the three lines of the copy, short, and speak from their first moment', () => {
    expect(Object.keys(HERO.voice.lines).sort()).toEqual([...VOICE_LINES].sort());
    for (const line of VOICE_LINES) {
      const wav = readFileSync(clip(line, 'wav'));
      expect(readFileSync(clip(line, 'm4a')).length, line).toBeGreaterThan(4000);
      const rate = wav.readUInt32LE(24);
      const samples = (wav.length - 44) / 2;
      expect(samples / rate, line).toBeCloseTo(CLIP_MEASUREMENTS[line].duration, 2);
      expect(samples / rate, line).toBeLessThan(2);
      // The first sound within 25 ms: the robot moves the moment a clip starts, so the clip must too.
      const first = Array.from({ length: samples }, (_, i) => Math.abs(wav.readInt16LE(44 + i * 2))).findIndex((v) => v > 32767 * 0.004);
      expect(first / rate, line).toBeLessThan(0.025);
    }
  });
});
