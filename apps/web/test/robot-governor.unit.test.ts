import { describe, expect, it } from 'vitest';
import { FrameGovernor, type GovernorVerdict } from '../src/app/(public)/_landing/robot/governor.ts';

/**
 * The live robot keeps inside the frame budget of the device it is drawn on (`governor.ts`): a device that keeps up never
 * notices it; one whose GPU cannot draw the robot in time gets it at a lower pixel ratio, and then the still robot.
 */
const run = (g: FrameGovernor, interval: number, frames: number): GovernorVerdict[] =>
  Array.from({ length: frames }, () => g.frame(interval)).filter((v) => v.kind !== 'keep');

describe('the robot frame governor', () => {
  it('leaves a robot that keeps up with the display alone, at 60, 120 and a 30 Hz battery-saving cap', () => {
    expect(run(new FrameGovernor({ period: 1000 / 60, ratio: 2 }), 16.7, 2000)).toEqual([]);
    expect(run(new FrameGovernor({ period: 1000 / 120, ratio: 2 }), 8.4, 2000)).toEqual([]);
    expect(run(new FrameGovernor({ period: 1000 / 30, ratio: 2 }), 33.4, 2000)).toEqual([]);
  });

  it('is not moved by hitches: a collection or a decode now and then decides nothing', () => {
    const g = new FrameGovernor({ period: 1000 / 60, ratio: 2 });
    const verdicts = Array.from({ length: 3000 }, (_, i) => g.frame(i % 10 === 0 ? 60 : 16.7)).filter((v) => v.kind !== 'keep');
    expect(verdicts).toEqual([]);
  });

  it('treats a pause — a background tab, a robot scrolled away — as a pause, not as slow frames', () => {
    expect(run(new FrameGovernor({ period: 1000 / 60, ratio: 2 }), 2000, 500)).toEqual([]);
  });

  it('steps a slow robot down a quarter of a pixel ratio at a time, to one, then hands back to the still robot', () => {
    const g = new FrameGovernor({ period: 1000 / 60, ratio: 2 });
    expect(run(g, 40, 2000)).toEqual([
      { kind: 'ratio', ratio: 1.75 },
      { kind: 'ratio', ratio: 1.5 },
      { kind: 'ratio', ratio: 1.25 },
      { kind: 'ratio', ratio: 1 },
      { kind: 'still' },
    ]);
  });

  it('stops stepping once the lower ratio keeps up', () => {
    const g = new FrameGovernor({ period: 1000 / 60, ratio: 2 });
    const first = run(g, 30, 80);
    expect(first).toEqual([{ kind: 'ratio', ratio: 1.75 }]);
    expect(run(g, 17, 2000)).toEqual([]);
  });

  it('judges whole windows: a short slow stretch, shorter than one window, changes nothing', () => {
    const g = new FrameGovernor({ period: 1000 / 60, ratio: 2 });
    expect(run(g, 16.7, 30)).toEqual([]);
    expect(run(g, 40, 25)).toEqual([]);
    expect(run(g, 16.7, 500)).toEqual([]);
  });
});
